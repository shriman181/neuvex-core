// Applies pending migrations to DATABASE_URL, in one transaction.
//
// Same migrator and bookkeeping table as `drizzle-kit migrate` (drizzle.__drizzle_migrations),
// but when a migration fails it prints Postgres's own message, detail and hint, where
// drizzle-kit prints nothing but an exit code.

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set.");

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const pool = new pg.Pool({ connectionString: url, max: 1 });

/** Drizzle wraps driver errors; the Postgres error is the innermost cause. */
function rootCause(err: unknown): unknown {
  let e = err;
  while (e instanceof Error && e.cause !== undefined) e = e.cause;
  return e;
}

try {
  await migrate(drizzle(pool), {
    migrationsFolder,
    migrationsSchema: "drizzle",
    migrationsTable: "__drizzle_migrations",
  });
  const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations");
  console.log(`Migrations up to date: ${rows[0]?.n ?? 0} applied.`);
} catch (err) {
  const e = rootCause(err) as Partial<pg.DatabaseError> & { message?: string };
  console.error(`Migration failed, nothing was applied: ${e.message ?? String(err)}`);
  if (e.code) console.error(`  code:   ${e.code}`);
  if (e.detail) console.error(`  detail: ${e.detail}`);
  if (e.hint) console.error(`  hint:   ${e.hint}`);
  if (e.where) console.error(`  where:  ${e.where}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
