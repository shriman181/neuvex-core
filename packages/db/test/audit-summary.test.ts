import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../src/testing.js";

// audit.vendor_summary() (migration 0006): what the gateway may read of a vendor's own
// audit log, as neuvex_gateway, one vendor at a time.

const VENDOR_A = "00000000-0000-4000-8000-00000000000a";
const VENDOR_B = "00000000-0000-4000-8000-00000000000b";

let pg: PGlite;

async function summaryAs(vendorId: string | null, recent?: number): Promise<Record<string, any>> {
  await pg.exec("SET ROLE neuvex_gateway");
  await pg.query("SELECT set_config('app.vendor_id', $1, false)", [vendorId ?? ""]);
  try {
    const sql = recent === undefined ? "SELECT audit.vendor_summary() AS s" : "SELECT audit.vendor_summary($1) AS s";
    const { rows } = await pg.query<{ s: Record<string, any> }>(sql, recent === undefined ? [] : [recent]);
    return rows[0]!.s;
  } finally {
    await pg.exec("RESET ROLE");
    await pg.query("SELECT set_config('app.vendor_id', '', false)");
  }
}

const event = (vendorId: string, decision: "allowed" | "denied", ts = "now()") =>
  pg.query(
    `INSERT INTO audit.events (vendor_id, ts, request_id, end_user_ref, primitive, action, decision, reason, detail)
     VALUES ($1, ${ts}, gen_random_uuid(), 'user_secret_ref', 'email.list_messages', 'read', $2, $3, 'free text someone typed')`,
    [vendorId, decision, decision === "allowed" ? "allowed" : "action_denied"],
  );

beforeAll(async () => {
  pg = await createTestDatabase();
  await pg.query(
    `INSERT INTO control.vendors (id, slug, name) VALUES ($1, 'acme-mail', 'Acme'), ($2, 'globex-crm', 'Globex')`,
    [VENDOR_A, VENDOR_B],
  );
  await event(VENDOR_A, "allowed");
  await event(VENDOR_A, "allowed");
  await event(VENDOR_A, "denied");
  await event(VENDOR_A, "allowed", "now() - interval '1 day'");
  await event(VENDOR_B, "denied");
});

afterAll(async () => {
  await pg?.close();
});

describe("audit summary", () => {
  it("counts today's decisions and the total for the calling vendor only", async () => {
    const s = await summaryAs(VENDOR_A);
    expect(s.today).toMatchObject({ allowed: 2, denied: 1 });
    expect(s.total).toBe(4);
    expect((await summaryAs(VENDOR_B)).total).toBe(1);
  });

  it("lists recent events newest first, without anything a caller typed", async () => {
    const s = await summaryAs(VENDOR_A, 3);
    expect(s.recent).toHaveLength(3);
    expect(Object.keys(s.recent[0]).sort()).toEqual(
      ["action", "contract_version", "decision", "id", "latency_ms", "primitive", "reason", "ts"].sort(),
    );
    expect(JSON.stringify(s)).not.toContain("user_secret_ref");
    expect(JSON.stringify(s)).not.toContain("free text");
    expect(Date.parse(s.recent[0].ts)).toBeGreaterThanOrEqual(Date.parse(s.recent[2].ts));
  });

  it("caps how many recent events it returns", async () => {
    expect((await summaryAs(VENDOR_A, 500)).recent.length).toBeLessThanOrEqual(50);
    expect((await summaryAs(VENDOR_A, -1)).recent).toEqual([]);
  });

  it("verifies each checkpoint against the events, and notices tampering", async () => {
    await pg.query("SELECT audit.write_checkpoints((now() AT TIME ZONE 'UTC')::date - 1)");
    let s = await summaryAs(VENDOR_A);
    expect(s.checkpoints).toHaveLength(1);
    expect(s.checkpoints[0]).toMatchObject({ events: 1, verified: true });
    expect(s.checkpoints[0].hash).toMatch(/^[0-9a-f]{16}$/);

    await pg.exec("SET session_replication_role = replica");
    await pg.exec(`UPDATE audit.events SET reason = 'tampered'
                   WHERE vendor_id = '${VENDOR_A}' AND ts < date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`);
    await pg.exec("SET session_replication_role = origin");
    s = await summaryAs(VENDOR_A);
    expect(s.checkpoints[0].verified).toBe(false);
    expect((await summaryAs(VENDOR_B)).checkpoints).toEqual([]);
  });

  it("names where today's events are stored and the Postgres version", async () => {
    const s = await summaryAs(VENDOR_A);
    expect(s.storage.table).toBe("audit.events");
    expect(s.storage.partition).toMatch(/^audit\.events_\d{8}$/);
    expect(s.storage.postgres).toMatch(/^\d+/);
  });

  it("refuses to run without a vendor, and still lets the gateway read nothing directly", async () => {
    await expect(summaryAs(null)).rejects.toThrow(/app.vendor_id is not set/);
    await pg.exec("SET ROLE neuvex_gateway");
    try {
      await expect(pg.query("SELECT * FROM audit.events")).rejects.toThrow(/permission denied/);
    } finally {
      await pg.exec("RESET ROLE");
    }
  });
});
