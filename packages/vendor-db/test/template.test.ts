import { PGlite } from "@electric-sql/pglite";
import { q, splitStatements } from "@neuvex/sql";
import { pgliteDb } from "@neuvex/sql/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adoptMigrations,
  appliedMigrations,
  applyTemplate,
  configure,
  setGatewayPassword,
  TEMPLATE,
  TEMPLATE_VERSION,
} from "../src/index.js";

// The vendor template on an in-memory Postgres standing in for one vendor's Neon
// project. The connection is the owner role, as on Neon (neondb_owner).

const VENDOR = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";

let pg: PGlite;
const owner = () => pgliteDb(pg);
const gateway = () => pgliteDb(pg, "neuvex_gateway");
const rows = async (sql: string, params: unknown[] = []) =>
  (await pg.query<Record<string, unknown>>(sql, params)).rows;

const insertEvent = (vendorId: string, ts = "now()") =>
  q(
    `INSERT INTO audit.events (vendor_id, ts, request_id, primitive, action, decision, reason)
     VALUES ($1, ${ts}, gen_random_uuid(), 'email.list_messages', 'read', 'allowed', 'allowed')`,
    vendorId,
  );

beforeAll(async () => {
  pg = new PGlite();
});

afterAll(async () => {
  await pg?.close();
});

describe("vendor template", () => {
  it("applies every migration once", async () => {
    expect(await applyTemplate(owner())).toEqual({ applied: [1, 2], version: TEMPLATE_VERSION });
    expect(await applyTemplate(owner())).toEqual({ applied: [], version: TEMPLATE_VERSION });
    expect((await appliedMigrations(owner())).map((m) => m.version)).toEqual([1, 2]);
  });

  it("refuses a migration that changed after it was applied", async () => {
    const edited = TEMPLATE.map((m) => (m.version === 1 ? { ...m, sql: `${m.sql}\n-- edited` } : m));
    await expect(applyTemplate(owner(), edited)).rejects.toThrow(/was changed after it was applied/);
  });

  it("refuses to run older code against a newer project", async () => {
    await expect(applyTemplate(owner(), TEMPLATE.slice(0, 1))).rejects.toThrow(/Deploy newer code first/);
  });

  it("belongs to one vendor, set once", async () => {
    await configure(owner(), { vendorId: VENDOR, slug: "acme-mail", tier: "developer" });
    await configure(owner(), { vendorId: VENDOR, slug: "acme-mail", tier: "startup" });
    expect(await rows("SELECT vendor_id, audit_retention_days FROM neuvex.settings")).toEqual([
      { vendor_id: VENDOR, audit_retention_days: 30 },
    ]);
    await expect(configure(owner(), { vendorId: OTHER, slug: "globex", tier: "developer" })).rejects.toThrow(
      /belongs to vendor/,
    );
    await configure(owner(), { vendorId: VENDOR, slug: "acme-mail", tier: "developer" });
  });

  it("lets the gateway role log in only once a password is set", async () => {
    expect(await rows("SELECT rolcanlogin FROM pg_roles WHERE rolname = 'neuvex_gateway'")).toEqual([
      { rolcanlogin: false },
    ]);
    await expect(setGatewayPassword(owner(), "short")).rejects.toThrow(/too short/);
    await expect(
      owner().query(q("SELECT neuvex.set_login_password('postgres', $1)", "x".repeat(32))),
    ).rejects.toThrow(/not a Neuvex role/);
    await setGatewayPassword(owner(), "a-long-generated-password-0123456789");
    expect(await rows("SELECT rolcanlogin FROM pg_roles WHERE rolname = 'neuvex_gateway'")).toEqual([
      { rolcanlogin: true },
    ]);
  });

  it("lets the gateway write its own vendor's events and nothing else", async () => {
    await gateway().query(insertEvent(VENDOR));
    await expect(gateway().query(insertEvent(OTHER))).rejects.toThrow(/does not belong in this project/);
    await expect(gateway().query(q("SELECT * FROM audit.events"))).rejects.toThrow(/permission denied/);
    await expect(gateway().query(q("UPDATE audit.events SET reason = 'x'"))).rejects.toThrow(/permission denied/);
    await expect(gateway().query(q("DELETE FROM audit.events"))).rejects.toThrow(/permission denied/);
    await expect(gateway().query(q("SELECT * FROM neuvex.settings"))).rejects.toThrow(/permission denied/);
    await expect(gateway().query(q("DROP TABLE audit.events_default"))).rejects.toThrow(/must be owner/);
    await expect(gateway().query(q("CREATE TABLE public.x (id int)"))).rejects.toThrow(/permission denied/);
    expect(await gateway().query(q("SELECT neuvex.vendor_id() AS v"))).toEqual([{ v: VENDOR }]);
  });

  it("keeps events append-only even for the owner", async () => {
    await expect(owner().query(q("UPDATE audit.events SET reason = 'x'"))).rejects.toThrow(/append-only/);
    await expect(owner().query(q("DELETE FROM audit.events"))).rejects.toThrow(/append-only/);
  });

  it("checkpoints finished days, chained, and catches tampering", async () => {
    await owner().query(insertEvent(VENDOR, "now() - interval '1 day'"));
    await owner().query(insertEvent(VENDOR, "now() - interval '1 day'"));
    const result = (await gateway().query(q("SELECT audit.run_maintenance() AS r")))[0]?.r as Record<string, number>;
    expect(result.checkpoints_written).toBe(1);

    const yesterday = "(now() AT TIME ZONE 'UTC')::date - 1";
    expect(await gateway().query(q(`SELECT audit.verify_checkpoint(${yesterday}) AS ok`))).toEqual([{ ok: true }]);
    const [cp] = await rows(`SELECT prev_hash, row_count FROM audit.checkpoints WHERE day = ${yesterday}`);
    expect(cp).toEqual({ prev_hash: "genesis", row_count: 2 });

    await pg.exec("SET session_replication_role = replica");
    await pg.exec(
      `UPDATE audit.events SET reason = 'tampered' WHERE ts < date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    );
    await pg.exec("SET session_replication_role = origin");
    expect(await gateway().query(q(`SELECT audit.verify_checkpoint(${yesterday}) AS ok`))).toEqual([{ ok: false }]);
  });

  it("drops whole partitions past the vendor's retention", async () => {
    // A partition for 10 days ago, which developer-tier retention (7 days) has passed.
    await pg.exec(`
      DO $$
      DECLARE d date := (now() AT TIME ZONE 'UTC')::date - 10;
      BEGIN
        EXECUTE format('CREATE TABLE audit.%I PARTITION OF audit.events FOR VALUES FROM (%L) TO (%L)',
          'events_' || to_char(d, 'YYYYMMDD'), d::timestamp AT TIME ZONE 'UTC', (d + 1)::timestamp AT TIME ZONE 'UTC');
      END $$`);
    await owner().query(insertEvent(VENDOR, "now() - interval '10 days'"));
    await owner().query(insertEvent(VENDOR, "now() - interval '20 days'")); // lands in the default partition
    await owner().query(insertEvent(VENDOR, "now() - interval '3 days'")); // default partition, kept

    const result = (await gateway().query(q("SELECT audit.run_maintenance() AS r")))[0]?.r as Record<string, number>;
    expect(result).toMatchObject({ partitions_dropped: 1, deleted: 1 });
    const [left] = await rows("SELECT count(*)::int AS n FROM audit.events WHERE ts < now() - interval '7 days'");
    expect(left).toEqual({ n: 0 });
    const [kept] = await rows("SELECT count(*)::int AS n FROM audit.events WHERE ts < now() - interval '2 days'");
    expect(kept).toEqual({ n: 1 });
  });

  it("brings a schema-only copy under the template's bookkeeping", async () => {
    // A schema-only branch: the same objects, none of the rows.
    const copy = new PGlite();
    try {
      for (const m of TEMPLATE) {
        if (m.version === 1) await copy.exec("CREATE SCHEMA neuvex");
        for (const s of splitStatements(m.sql)) await copy.exec(s);
      }
      const fixtures = pgliteDb(copy);
      await adoptMigrations(fixtures, await appliedMigrations(owner()));
      expect(await applyTemplate(fixtures)).toEqual({ applied: [], version: TEMPLATE_VERSION });
      await configure(fixtures, { vendorId: VENDOR, slug: "acme-mail", tier: "developer" });
      await pgliteDb(copy, "neuvex_gateway").query(insertEvent(VENDOR));
    } finally {
      await copy.close();
    }
  });
});
