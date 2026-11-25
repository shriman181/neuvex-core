import { describe, expect, it } from "vitest";
import type { ContractRules } from "@neuvex/contracts";
import { AUDIT_SCOPE, CHECK_SCOPE, CONTRACTS_SCOPE, handle, sha256Hex, type Deps } from "../src/app.js";
import type { AuditEvent, ContractLookup, KeyRecord, Store } from "../src/store.js";

const VENDOR = "11111111-1111-4111-8111-111111111111";
const GOOD_KEY = "nvx_test_good";
const NO_SCOPE_KEY = "nvx_test_noscope";
const READ_KEY = "nvx_test_reader";

const listRules: ContractRules = {
  allow: { actions: ["read"], fields: ["id", "subject", "from", "snippet"] },
  deny: { fields: ["body"] },
  redact: ["from.email"],
};

function fakeStore(overrides: Partial<Store> = {}) {
  const keys = new Map<string, KeyRecord>();
  const calls: Array<{ event: AuditEvent; keyId: string }> = [];
  const contracts = new Map<string, ContractLookup>([
    ["email.list_messages", { kind: "found", version: 3, rules: listRules }],
    ["email.draft", { kind: "no_contract" }],
  ]);
  const store: Store = {
    async resolveKey(hash) {
      return keys.get(hash) ?? null;
    },
    async loadContract(vendorId, primitive) {
      expect(vendorId).toBe(VENDOR);
      return contracts.get(primitive) ?? { kind: "unknown_primitive" };
    },
    async recordCall(event, keyId) {
      calls.push({ event, keyId });
    },
    async runMaintenance() {
      return { ok: true };
    },
    async listContracts(vendorId) {
      expect(vendorId).toBe(VENDOR);
      return [
        { primitive: "email.draft", description: null, version: null, rules: null },
        { primitive: "email.list_messages", description: "List messages", version: 3, rules: listRules },
      ];
    },
    async auditSummary(vendorId, recent) {
      expect(vendorId).toBe(VENDOR);
      return {
        today: { date: "2026-11-26", allowed: 2, denied: 1 },
        total: 3,
        recent: [],
        checkpoints: [{ day: "2026-11-25", events: 3, hash: "0123456789abcdef", verified: true }],
        storage: { table: "audit.events", partition: "audit.events_20261126", postgres: `18.1 (recent=${recent})` },
      };
    },
    ...overrides,
  };
  return { store, keys, calls };
}

async function setup(overrides: Partial<Store> = {}) {
  const f = fakeStore(overrides);
  f.keys.set(await sha256Hex(GOOD_KEY), { vendorId: VENDOR, keyId: "key-1", scopes: [CHECK_SCOPE, "email:read"] });
  f.keys.set(await sha256Hex(NO_SCOPE_KEY), { vendorId: VENDOR, keyId: "key-2", scopes: ["email:read"] });
  f.keys.set(await sha256Hex(READ_KEY), { vendorId: VENDOR, keyId: "key-3", scopes: [CONTRACTS_SCOPE, AUDIT_SCOPE] });
  const pending: Promise<unknown>[] = [];
  const deps: Deps = {
    store: f.store,
    waitUntil: (p) => pending.push(p),
    newId: () => "req-1",
  };
  const call = async (body: unknown, key: string | null = GOOD_KEY, method = "POST") => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    const init: RequestInit = { method, headers };
    if (method === "POST") init.body = typeof body === "string" ? body : JSON.stringify(body);
    const res = await handle(new Request("https://gw.test/v1/check", init), deps);
    await Promise.all(pending.splice(0));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { ...f, deps, call };
}

describe("gateway", () => {
  it("answers health checks", async () => {
    const { deps } = await setup();
    const res = await handle(new Request("https://gw.test/health"), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ service: "neuvex-gateway", ok: true });
  });

  it("allows a call, shapes data and audits it", async () => {
    const { call, calls } = await setup();
    const res = await call({
      primitive: "email.list_messages",
      action: "read",
      session_id: "22222222-2222-4222-8222-222222222222",
      end_user_ref: "user_42",
      data: [
        { id: "m1", subject: "Hi", from: { name: "Ann", email: "ann@x.io" }, body: "secret", snippet: "Hi..." },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("allowed");
    expect(res.body.contract_version).toBe(3);
    expect(res.body.data).toEqual([
      { id: "m1", subject: "Hi", from: { name: "Ann", email: "[redacted]" }, snippet: "Hi..." },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.keyId).toBe("key-1");
    expect(calls[0]?.event).toMatchObject({
      vendorId: VENDOR,
      requestId: "req-1",
      primitive: "email.list_messages",
      action: "read",
      decision: "allowed",
      contractVersion: 3,
      endUserRef: "user_42",
      redactedFields: ["from.email"],
    });
  });

  it("denies fields the contract forbids, and audits the denial", async () => {
    const { call, calls } = await setup();
    const res = await call({ primitive: "email.list_messages", action: "read", fields: ["id", "body"] });
    expect(res.body).toMatchObject({ decision: "denied", reason: "field_denied", contract_version: 3 });
    expect(res.body.data).toBeUndefined();
    expect(calls[0]?.event).toMatchObject({ decision: "denied", reason: "field_denied" });
  });

  it("denies actions outside the contract", async () => {
    const { call } = await setup();
    const res = await call({ primitive: "email.list_messages", action: "delete" });
    expect(res.body).toMatchObject({ decision: "denied", reason: "action_not_allowed" });
  });

  it("denies when a primitive has no contract yet", async () => {
    const { call, calls } = await setup();
    const res = await call({ primitive: "email.draft", action: "write" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ decision: "denied", reason: "no_contract" });
    expect(calls[0]?.event.reason).toBe("no_contract");
  });

  it("returns 404 for an unknown primitive, and audits it", async () => {
    const { call, calls } = await setup();
    const res = await call({ primitive: "calendar.list_events", action: "read" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_primitive");
    expect(calls[0]?.event).toMatchObject({ decision: "denied", reason: "unknown_primitive" });
  });

  it("rejects missing, unknown and under-scoped keys without auditing", async () => {
    const { call, calls } = await setup();
    const body = { primitive: "email.list_messages", action: "read" };
    expect((await call(body, null)).status).toBe(401);
    expect((await call(body, "nvx_wrong")).status).toBe(401);
    const scoped = await call(body, NO_SCOPE_KEY);
    expect(scoped.status).toBe(403);
    expect(scoped.body.detail).toBe(CHECK_SCOPE);
    expect(calls).toHaveLength(0);
  });

  it("validates the request body", async () => {
    const { call } = await setup();
    expect((await call("{not json")).status).toBe(400);
    expect((await call({ primitive: "Email", action: "read" })).status).toBe(400);
    expect((await call({ primitive: "email.list_messages", action: "READ" })).status).toBe(400);
    expect((await call({ primitive: "email.list_messages", action: "read", session_id: "nope" })).status).toBe(400);
    expect((await call({ primitive: "email.list_messages", action: "read", fields: ["a.b"] })).status).toBe(400);
    const email = await call({ primitive: "email.list_messages", action: "read", end_user_ref: "ann@x.io" });
    expect(email.status).toBe(400);
    expect(String(email.body.detail)).toContain("never an email");
  });

  it("only accepts POST on /v1/check and 404s elsewhere", async () => {
    const { call, deps } = await setup();
    expect((await call(undefined, GOOD_KEY, "GET")).status).toBe(405);
    expect((await handle(new Request("https://gw.test/nope"), deps)).status).toBe(404);
  });

  it("still answers when the audit write fails", async () => {
    const { call } = await setup({
      async recordCall() {
        throw new Error("db down");
      },
    });
    const res = await call({ primitive: "email.list_messages", action: "read" });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("allowed");
  });

  it("returns 500 without details when the store fails", async () => {
    const { call } = await setup({
      async loadContract() {
        throw new Error("connection refused at ep-secret-host");
      },
    });
    const res = await call({ primitive: "email.list_messages", action: "read" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal_error" });
  });

  it("reports time spent in Neon in a Server-Timing header", async () => {
    const { deps } = await setup();
    const res = await handle(
      new Request("https://gw.test/v1/check", {
        method: "POST",
        headers: { authorization: `Bearer ${GOOD_KEY}` },
        body: JSON.stringify({ primitive: "email.list_messages", action: "read" }),
      }),
      deps,
    );
    expect(res.headers.get("server-timing")).toMatch(/^neon;dur=\d+(\.\d)?;desc="Neon Postgres", total;dur=\d+(\.\d)?$/);
  });
});

describe("read endpoints", () => {
  const get = async (deps: Deps, path: string, key: string | null) =>
    handle(new Request(`https://gw.test${path}`, key ? { headers: { authorization: `Bearer ${key}` } } : {}), deps);

  it("lists the vendor's primitives with their latest contracts", async () => {
    const { deps } = await setup();
    const res = await get(deps, "/v1/contracts", READ_KEY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contracts: Array<{ primitive: string; version: number | null }> };
    expect(body.contracts.map((c) => [c.primitive, c.version])).toEqual([
      ["email.draft", null],
      ["email.list_messages", 3],
    ]);
    expect(res.headers.get("server-timing")).toContain("neon;dur=");
  });

  it("returns the vendor's audit summary", async () => {
    const { deps } = await setup();
    const res = await get(deps, "/v1/audit/summary?recent=5", READ_KEY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; storage: { postgres: string } };
    expect(body.total).toBe(3);
    expect(body.storage.postgres).toContain("recent=5");
    expect((await get(deps, "/v1/audit/summary?recent=99", READ_KEY)).status).toBe(400);
  });

  it("needs a key with the right scope", async () => {
    const { deps } = await setup();
    expect((await get(deps, "/v1/contracts", null)).status).toBe(401);
    expect((await get(deps, "/v1/contracts", "nvx_wrong")).status).toBe(401);
    const noScope = await get(deps, "/v1/audit/summary", GOOD_KEY);
    expect(noScope.status).toBe(403);
    expect(((await noScope.json()) as { detail: string }).detail).toBe(AUDIT_SCOPE);
    const post = await handle(new Request("https://gw.test/v1/contracts", { method: "POST" }), deps);
    expect(post.status).toBe(405);
  });
});
