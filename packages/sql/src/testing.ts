import type { PGlite } from "@electric-sql/pglite";
import type { Db, Query, Row } from "./index.js";

// Test-only (imported as @neuvex/sql/testing; never bundled into a Worker).

/**
 * The Db interface over PGlite. With `role`, every statement runs as that role
 * (SET LOCAL ROLE), so grants and row-level security apply as they do on Neon.
 */
export function pgliteDb(pg: PGlite, role?: string): Db {
  const run = (qs: Query[]) =>
    pg.transaction(async (tx) => {
      if (role) await tx.exec(`SET LOCAL ROLE ${role}`);
      const out: Row[][] = [];
      for (const { text, params } of qs) out.push((await tx.query<Row>(text, params)).rows);
      return out;
    });
  return {
    query: async (q) => (await run([q]))[0] ?? [],
    transaction: run,
  };
}
