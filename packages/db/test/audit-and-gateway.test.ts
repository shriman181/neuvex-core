import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The audit log and the gateway's access (migration 0003), on in-memory Postgres set
// up like the Neon project: hand-made roles, migrations applied as neuvex_migrator.

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const VENDOR_A = "00000000-0000-4000-8000-00000000000a"; // developer tier
const VENDOR_B = "00000000-0000-4000-8000-00000000000b"; // scale tier
const KEY_HASH_A = "a".repeat(64);

let pg: PGlite;
const rows = async (sql: string, params: unknown[] = []) => (await pg.query(sql, params)).rows;

/** Run statements as neuvex_gateway, acting for `vendorId` (or for nobody). */
async function asGateway<T>(vendorId: string | null, fn: () => Promise<T>): Promise<T> {
  await pg.exec("SET ROLE neuvex_gateway");
  await pg.query("SELECT set_config('app.vendor_id', $1, false)", [vendorId ?? ""]);
  try {
    return await fn();
  } finally {
    await pg.exec("RESET ROLE");
    await pg.query("SELECT set_config('app.vendor_id', '', false)");
  }
}

const insertEvent = (vendorId: string, ts = "now()") =>
  `INSERT INTO audit.events (vendor_id, ts, request_id, primitive, action, decision, reason)
   VALUES ('${vendorId}', ${ts}, gen_random_uuid(), 'email.list_messages', 'read', 'allowed', 'allowed')`;

beforeAll(async () => {
  pg = new PGlite();
  const { rows: db } = await pg.query<{ d: string }>("SELECT current_database() AS d");
  await pg.exec(`
    CREATE SCHEMA control;
    CREATE ROLE neuvex_gateway LOGIN PASSWORD 'test';
    CREATE ROLE neuvex_migrator LOGIN PASSWORD 'test';
    GRANT CREATE ON DATABASE ${db[0]!.d} TO neuvex_migrator;
    GRANT USAGE, CREATE ON SCHEMA control TO neuvex_migrator;
    GRANT USAGE ON SCHEMA control TO neuvex_migrator WITH GRANT OPTION;
  `);
  await pg.exec("SET ROLE neuvex_migrator");
  await migrate(drizzle(pg), { migrationsFolder, migrationsSchema: "drizzle" });
  await pg.exec("RESET ROLE");

  await pg.query(
    `INSERT INTO control.vendors (id, slug, name, tier)
     VALUES ($1, 'acme-mail', 'Acme Mail', 'developer'), ($2, 'globex-crm', 'Globex CRM', 'scale')`,
    [VENDOR_A, VENDOR_B],
  );
  await pg.query(
    `INSERT INTO control.vendor_keys (vendor_id, key_prefix, key_hash, scopes)
     VALUES ($1, 'nvx_test', $2, '{gateway:check}')`,
    [VENDOR_A, KEY_HASH_A],
  );
});

afterAll(async () => {
  await pg?.close();
});

describe("vendor keys", () => {
  it("resolve through the lookup function, never by reading the table", async () => {
    const found = await asGateway(null, () =>
      rows("SELECT vendor_id, scopes FROM control.resolve_vendor_key($1)", [KEY_HASH_A]),
    );
    expect(found).toEqual([{ vendor_id: VENDOR_A, scopes: ["gateway:check"] }]);
    await expect(asGateway(VENDOR_A, () => rows("SELECT * FROM control.vendor_keys"))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("stop resolving once revoked", async () => {
    await pg.query(
      `INSERT INTO control.vendor_keys (vendor_id, key_prefix, key_hash, revoked_at)
       VALUES ($1, 'nvx_old', $2, now())`,
      [VENDOR_A, "b".repeat(64)],
    );
    const found = await asGateway(null, () =>
      rows("SELECT * FROM control.resolve_vendor_key($1)", ["b".repeat(64)]),
    );
    expect(found).toEqual([]);
  });
});

describe("audit events", () => {
  it("can be written by the gateway for the vendor it acts for, into today's partition", async () => {
    await asGateway(VENDOR_A, () => rows(insertEvent(VENDOR_A)));
    const [row] = await rows(
      "SELECT tableoid::regclass::text AS part FROM audit.events WHERE vendor_id = $1 ORDER BY id DESC LIMIT 1",
      [VENDOR_A],
    );
    const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    expect(row).toEqual({ part: `audit.events_${today}` });
  });

  it("cannot be written for another vendor", async () => {
    await expect(asGateway(VENDOR_A, () => rows(insertEvent(VENDOR_B)))).rejects.toThrow(
      /row-level security/,
    );
  });

  it("cannot be read, edited or deleted by the gateway", async () => {
    for (const sql of [
      "SELECT * FROM audit.events",
      "UPDATE audit.events SET reason = 'x'",
      "DELETE FROM audit.events",
    ]) {
      await expect(asGateway(VENDOR_A, () => rows(sql))).rejects.toThrow(/permission denied/);
    }
  });

  it("cannot be edited or deleted even by the admin role", async () => {
    await expect(rows("UPDATE audit.events SET reason = 'edited'")).rejects.toThrow(/append-only/);
    await expect(rows("DELETE FROM audit.events")).rejects.toThrow(/append-only/);
  });

  it("refuse an email address as the end-user reference", async () => {
    await expect(
      rows(
        `INSERT INTO audit.events (vendor_id, request_id, end_user_ref, primitive, action, decision, reason)
         VALUES ($1, gen_random_uuid(), 'jane@acme.com', 'email.get_message', 'read', 'allowed', 'allowed')`,
        [VENDOR_A],
      ),
    ).rejects.toThrow(/events_end_user_ref_not_email/);
  });
});

describe("checkpoints", () => {
  const yesterday = "(date_trunc('day', now() AT TIME ZONE 'UTC') - interval '12 hours') AT TIME ZONE 'UTC'";

  it("chain each vendor's complete days and detect tampering", async () => {
    await pg.exec(insertEvent(VENDOR_A, yesterday));
    await pg.exec(insertEvent(VENDOR_A, yesterday));
    const [w] = await rows(
      "SELECT audit.write_checkpoints(((now() AT TIME ZONE 'UTC')::date - 1)) AS n",
    );
    expect(w).toEqual({ n: 1 });

    const verify = () =>
      asGateway(VENDOR_A, () =>
        rows("SELECT audit.verify_checkpoint((now() AT TIME ZONE 'UTC')::date - 1) AS ok"),
      );
    expect(await verify()).toEqual([{ ok: true }]);

    // Tamper with one event, bypassing the append-only trigger as a superuser would.
    await pg.exec("SET session_replication_role = replica");
    await pg.exec(
      `UPDATE audit.events SET decision = 'denied'
       WHERE id = (SELECT min(id) FROM audit.events WHERE ts < date_trunc('day', now()))`,
    );
    await pg.exec("SET session_replication_role = origin");
    expect(await verify()).toEqual([{ ok: false }]);
  });

  it("are never written for today, which isn't complete yet", async () => {
    await expect(
      rows("SELECT audit.write_checkpoints((now() AT TIME ZONE 'UTC')::date)"),
    ).rejects.toThrow(/complete UTC days/);
  });
});

describe("maintenance", () => {
  it("deletes events past each vendor's retention: 7 days on developer, 1 year on scale", async () => {
    const tenDaysAgo = "now() - interval '10 days'";
    await pg.exec(insertEvent(VENDOR_A, tenDaysAgo));
    await pg.exec(insertEvent(VENDOR_B, tenDaysAgo));

    const result = await asGateway(null, () => rows("SELECT audit.run_maintenance() AS r"));
    expect(result[0]).toMatchObject({ r: { deleted: 1 } });

    const old = await rows(
      "SELECT vendor_id FROM audit.events WHERE ts < now() - interval '9 days' ORDER BY vendor_id",
    );
    expect(old).toEqual([{ vendor_id: VENDOR_B }]);
  });

  it("keeps daily partitions two weeks ahead", async () => {
    const [row] = await rows(
      `SELECT count(*)::int AS n FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'audit.events'::regclass AND c.relname ~ '^events_[0-9]{8}$'`,
    );
    expect((row as { n: number }).n).toBeGreaterThanOrEqual(16);
  });

  it("is the only maintenance the gateway may run", async () => {
    for (const sql of [
      "SELECT audit.ensure_partitions(1)",
      "SELECT audit.apply_retention()",
      "SELECT audit.write_checkpoints(current_date - 5)",
    ]) {
      await expect(asGateway(null, () => rows(sql))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("usage", () => {
  it("is counted by the gateway, per vendor per day", async () => {
    const bump = `INSERT INTO control.usage_daily (vendor_id, day, primitive_calls)
                  VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
                  ON CONFLICT (vendor_id, day)
                  DO UPDATE SET primitive_calls = control.usage_daily.primitive_calls + 1`;
    await asGateway(VENDOR_A, () => rows(bump, [VENDOR_A]));
    await asGateway(VENDOR_A, () => rows(bump, [VENDOR_A]));
    const seen = await asGateway(VENDOR_A, () => rows("SELECT primitive_calls FROM control.usage_daily"));
    expect(seen).toEqual([{ primitive_calls: 2 }]);
  });
});
