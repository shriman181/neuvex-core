import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs every migration against an in-memory Postgres set up the way the Neon project
// is: a hand-made `control` schema, migrations applied as neuvex_migrator with only
// its real grants, and an app role (like the future gateway) that is subject to RLS.

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const VENDOR_A = "00000000-0000-4000-8000-00000000000a";
const VENDOR_B = "00000000-0000-4000-8000-00000000000b";

let pg: PGlite;

/** Run statements as the app role, acting for `vendorId` (or for nobody). */
async function asApp<T>(vendorId: string | null, fn: () => Promise<T>): Promise<T> {
  await pg.exec("SET ROLE app_user");
  await pg.query("SELECT set_config('app.vendor_id', $1, false)", [vendorId ?? ""]);
  try {
    return await fn();
  } finally {
    await pg.exec("RESET ROLE");
    await pg.query("SELECT set_config('app.vendor_id', '', false)");
  }
}

const rows = async (sql: string, params: unknown[] = []) => (await pg.query(sql, params)).rows;

beforeAll(async () => {
  pg = new PGlite();
  const { rows: db } = await pg.query<{ d: string }>("SELECT current_database() AS d");
  const database = db[0]!.d;

  // The one-time manual setup from the README.
  await pg.exec(`
    CREATE SCHEMA control;
    CREATE ROLE neuvex_gateway LOGIN PASSWORD 'test';
    CREATE ROLE neuvex_migrator LOGIN PASSWORD 'test';
    GRANT CREATE ON DATABASE ${database} TO neuvex_migrator;
    GRANT USAGE, CREATE ON SCHEMA control TO neuvex_migrator;
    GRANT USAGE ON SCHEMA control TO neuvex_migrator WITH GRANT OPTION;
  `);

  await pg.exec("SET ROLE neuvex_migrator");
  await migrate(drizzle(pg), { migrationsFolder, migrationsSchema: "drizzle" });
  await pg.exec("RESET ROLE");

  await pg.exec(`
    CREATE ROLE app_user LOGIN PASSWORD 'test';
    GRANT USAGE ON SCHEMA control TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA control TO app_user;
  `);

  // Seed two vendors as the admin role, which bypasses RLS.
  await pg.query(
    `INSERT INTO control.vendors (id, slug, name) VALUES ($1, 'acme-mail', 'Acme Mail'), ($2, 'globex-crm', 'Globex CRM')`,
    [VENDOR_A, VENDOR_B],
  );
  await pg.query(
    `INSERT INTO control.primitives (vendor_id, name) VALUES ($1, 'email.list_messages'), ($2, 'crm.list_contacts')`,
    [VENDOR_A, VENDOR_B],
  );
});

afterAll(async () => {
  await pg?.close();
});

describe("migrations", () => {
  it("run as neuvex_migrator and are recorded", async () => {
    const [row] = await rows("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations");
    expect(row).toEqual({ n: 4 });
  });

  it("make neuvex_migrator the owner of every control table", async () => {
    const owners = await rows(
      "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'control'",
    );
    expect(owners).toEqual([{ tableowner: "neuvex_migrator" }]);
  });

  it("enable row-level security on every control table", async () => {
    const unprotected = await rows(
      `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'control' AND c.relkind = 'r' AND NOT c.relrowsecurity`,
    );
    expect(unprotected).toEqual([]);
  });
});

describe("tenant isolation", () => {
  it("shows a vendor only its own rows", async () => {
    const seen = await asApp(VENDOR_A, async () => ({
      vendors: await rows("SELECT slug FROM control.vendors"),
      primitives: await rows("SELECT name FROM control.primitives"),
    }));
    expect(seen.vendors).toEqual([{ slug: "acme-mail" }]);
    expect(seen.primitives).toEqual([{ name: "email.list_messages" }]);
  });

  it("shows nothing when no vendor is set", async () => {
    const seen = await asApp(null, () => rows("SELECT id FROM control.vendors"));
    expect(seen).toEqual([]);
  });

  it("rejects writing a row for another vendor", async () => {
    await expect(
      asApp(VENDOR_A, () =>
        rows("INSERT INTO control.primitives (vendor_id, name) VALUES ($1, 'crm.delete_all')", [
          VENDOR_B,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot move a row to another vendor", async () => {
    await expect(
      asApp(VENDOR_A, () =>
        rows("UPDATE control.primitives SET vendor_id = $1 WHERE name = 'email.list_messages'", [
          VENDOR_B,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("blocks linking to another vendor's primitive, even for the admin role", async () => {
    const [b] = await rows("SELECT id FROM control.primitives WHERE vendor_id = $1", [VENDOR_B]);
    await expect(
      rows(
        `INSERT INTO control.contract_versions (vendor_id, primitive_id, version, rules)
         VALUES ($1, $2, 1, '{"allow": {"actions": ["read"]}}')`,
        [VENDOR_A, (b as { id: string }).id],
      ),
    ).rejects.toThrow(/contract_versions_primitive_fk/);
  });
});

describe("contract versions", () => {
  it("are immutable once published, but go when their vendor is deleted", async () => {
    await pg.query(
      `INSERT INTO control.vendors (id, slug, name) VALUES ('00000000-0000-4000-8000-0000000000cc', 'temp-co', 'Temp Co')`,
    );
    const [p] = await rows(
      `INSERT INTO control.primitives (vendor_id, name)
       VALUES ('00000000-0000-4000-8000-0000000000cc', 'files.read') RETURNING id`,
    );
    const primitiveId = (p as { id: string }).id;
    await pg.query(
      `INSERT INTO control.contract_versions (vendor_id, primitive_id, version, rules)
       VALUES ('00000000-0000-4000-8000-0000000000cc', $1, 1, '{"allow": {"actions": ["read"]}}')`,
      [primitiveId],
    );

    await expect(
      rows("UPDATE control.contract_versions SET rules = '{\"allow\": {}}' WHERE primitive_id = $1", [
        primitiveId,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      rows("DELETE FROM control.contract_versions WHERE primitive_id = $1", [primitiveId]),
    ).rejects.toThrow(/immutable/);

    await pg.query("DELETE FROM control.vendors WHERE slug = 'temp-co'");
    const left = await rows("SELECT id FROM control.contract_versions WHERE primitive_id = $1", [
      primitiveId,
    ]);
    expect(left).toEqual([]);
  });

  it("require an allow block", async () => {
    const [a] = await rows("SELECT id FROM control.primitives WHERE vendor_id = $1", [VENDOR_A]);
    await expect(
      rows(
        `INSERT INTO control.contract_versions (vendor_id, primitive_id, version, rules)
         VALUES ($1, $2, 1, '{"deny": {}}')`,
        [VENDOR_A, (a as { id: string }).id],
      ),
    ).rejects.toThrow(/contract_versions_rules_shape/);
  });
});

describe("data rules", () => {
  it("never store an email address as a mold's end-user reference", async () => {
    await expect(
      rows(
        "INSERT INTO control.molds (vendor_id, end_user_ref, name) VALUES ($1, 'jane@acme.com', 'Inbox')",
        [VENDOR_A],
      ),
    ).rejects.toThrow(/molds_end_user_ref_not_email/);
  });

  it("only accept lowercase, hyphenated vendor slugs", async () => {
    await expect(
      rows("INSERT INTO control.vendors (slug, name) VALUES ('Acme Mail!', 'Bad')"),
    ).rejects.toThrow(/vendors_slug_format/);
  });

  it("only accept dotted primitive names", async () => {
    await expect(
      rows("INSERT INTO control.primitives (vendor_id, name) VALUES ($1, 'listMessages')", [
        VENDOR_A,
      ]),
    ).rejects.toThrow(/primitives_name_format/);
  });
});
