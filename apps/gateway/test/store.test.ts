import type { PGlite } from "@electric-sql/pglite";
import { createTestDatabase } from "@neuvex/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handle, sha256Hex } from "../src/app.js";
import { createStore, type Db } from "../src/store.js";

// The store's real SQL, run as neuvex_gateway against every migration, so row-level
// security, the grants and the definer functions are all exercised end to end.

const VENDOR_A = "00000000-0000-4000-8000-00000000000a";
const VENDOR_B = "00000000-0000-4000-8000-00000000000b";
const KEY_A = "nvx_live_vendor_a";
const KEY_B = "nvx_live_vendor_b";
const KEY_REVOKED = "nvx_live_revoked";

let pg: PGlite;
const rows = async (sql: string, params: unknown[] = []) =>
  (await pg.query<Record<string, unknown>>(sql, params)).rows;

/** Same contract as neonDb, but every statement runs as neuvex_gateway. */
function gatewayDb(db: PGlite): Db {
  const run = (qs: { text: string; params: unknown[] }[]) =>
    db.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE neuvex_gateway");
      const out: Record<string, unknown>[][] = [];
      for (const { text, params } of qs) out.push((await tx.query<Record<string, unknown>>(text, params)).rows);
      return out;
    });
  return {
    query: async (q) => (await run([q]))[0] ?? [],
    transaction: run,
  };
}

async function check(key: string, body: unknown) {
  const pending: Promise<unknown>[] = [];
  const res = await handle(
    new Request("https://gw.test/v1/check", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { store: createStore(gatewayDb(pg)), waitUntil: (p) => pending.push(p) },
  );
  await Promise.all(pending);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  pg = await createTestDatabase();
  await pg.query(
    `INSERT INTO control.vendors (id, slug, name) VALUES ($1, 'acme-mail', 'Acme Mail'), ($2, 'globex-crm', 'Globex CRM')`,
    [VENDOR_A, VENDOR_B],
  );
  await pg.query(
    `INSERT INTO control.vendor_keys (vendor_id, key_prefix, key_hash, scopes, revoked_at) VALUES
       ($1, 'nvx_live', $3, '{gateway:check,email:read}', NULL),
       ($2, 'nvx_live', $4, '{gateway:check}', NULL),
       ($1, 'nvx_live', $5, '{gateway:check}', now())`,
    [VENDOR_A, VENDOR_B, await sha256Hex(KEY_A), await sha256Hex(KEY_B), await sha256Hex(KEY_REVOKED)],
  );
  await pg.query(
    `INSERT INTO control.primitives (vendor_id, name) VALUES
       ($1, 'email.list_messages'), ($1, 'email.draft'), ($2, 'crm.list_contacts')`,
    [VENDOR_A, VENDOR_B],
  );
  await pg.query(
    `INSERT INTO control.contract_versions (vendor_id, primitive_id, version, rules)
     SELECT $1, id, v, r::jsonb FROM control.primitives,
       (VALUES (1, '{"allow":{"actions":["read","delete"]}}'),
               (2, '{"allow":{"actions":["read"],"fields":["id","subject","from"]},"redact":["from.email"]}')) AS c(v, r)
     WHERE vendor_id = $1 AND name = 'email.list_messages'`,
    [VENDOR_A],
  );
});

afterAll(async () => {
  await pg?.close();
});

describe("store against the migrated database", () => {
  it("uses the latest contract version, audits the call and counts usage", async () => {
    const res = await check(KEY_A, {
      primitive: "email.list_messages",
      action: "read",
      end_user_ref: "user_42",
      data: { id: "m1", subject: "Hi", from: { email: "ann@x.io" }, body: "secret" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ decision: "allowed", contract_version: 2 });
    expect(res.body.data).toEqual({ id: "m1", subject: "Hi", from: { email: "[redacted]" } });

    const [event] = await rows("SELECT * FROM audit.events WHERE request_id = $1", [res.body.request_id]);
    expect(event).toMatchObject({
      vendor_id: VENDOR_A,
      primitive: "email.list_messages",
      decision: "allowed",
      contract_version: 2,
      end_user_ref: "user_42",
      scopes: ["gateway:check", "email:read"],
      redacted_fields: ["from.email"],
    });

    const [usage] = await rows("SELECT primitive_calls::int AS n FROM control.usage_daily WHERE vendor_id = $1", [VENDOR_A]);
    expect(usage).toEqual({ n: 1 });
    const [key] = await rows("SELECT last_used_at FROM control.vendor_keys WHERE key_hash = $1", [await sha256Hex(KEY_A)]);
    expect(key?.last_used_at).not.toBeNull();
  });

  it("denies by the latest version, not an older, looser one", async () => {
    const res = await check(KEY_A, { primitive: "email.list_messages", action: "delete" });
    expect(res.body).toMatchObject({ decision: "denied", reason: "action_not_allowed", contract_version: 2 });
    const [usage] = await rows("SELECT primitive_calls::int AS n FROM control.usage_daily WHERE vendor_id = $1", [VENDOR_A]);
    expect(usage).toEqual({ n: 2 });
  });

  it("denies a primitive that has no contract yet", async () => {
    const res = await check(KEY_A, { primitive: "email.draft", action: "write" });
    expect(res.body).toMatchObject({ decision: "denied", reason: "no_contract" });
  });

  it("never lets one vendor's key see another vendor's primitives", async () => {
    const res = await check(KEY_B, { primitive: "email.list_messages", action: "read" });
    expect(res.status).toBe(404);
    const [event] = await rows("SELECT vendor_id, reason FROM audit.events WHERE request_id = $1", [res.body.request_id]);
    expect(event).toEqual({ vendor_id: VENDOR_B, reason: "unknown_primitive" });
  });

  it("rejects a revoked key", async () => {
    const res = await check(KEY_REVOKED, { primitive: "email.list_messages", action: "read" });
    expect(res.status).toBe(401);
  });

  it("runs audit maintenance as the gateway role", async () => {
    const result = await createStore(gatewayDb(pg)).runMaintenance();
    expect(result).toEqual(expect.objectContaining({}));
    expect(typeof result).toBe("object");
  });
});
