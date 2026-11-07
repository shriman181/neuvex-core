import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";

// Test-only (imported as @neuvex/db/testing; never bundled into a Worker).

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * An in-memory Postgres set up the way the Neon project is: the hand-made `control`
 * schema and roles from the README, then every migration applied as neuvex_migrator
 * with only its real grants. The connection itself is the admin role (bypasses RLS).
 */
export async function createTestDatabase(): Promise<PGlite> {
  const pg = new PGlite();
  const { rows } = await pg.query<{ d: string }>("SELECT current_database() AS d");
  await pg.exec(`
    CREATE SCHEMA control;
    CREATE ROLE neuvex_gateway LOGIN PASSWORD 'test';
    CREATE ROLE neuvex_migrator LOGIN PASSWORD 'test';
    CREATE ROLE neuvex_provisioner LOGIN PASSWORD 'test';
    GRANT CREATE ON DATABASE ${rows[0]!.d} TO neuvex_migrator;
    GRANT USAGE, CREATE ON SCHEMA control TO neuvex_migrator;
    GRANT USAGE ON SCHEMA control TO neuvex_migrator WITH GRANT OPTION;
  `);
  await pg.exec("SET ROLE neuvex_migrator");
  await migrate(drizzle(pg), { migrationsFolder, migrationsSchema: "drizzle" });
  await pg.exec("RESET ROLE");
  return pg;
}
