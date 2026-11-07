import { neon } from "@neondatabase/serverless";

// The one database interface every Neuvex component uses. Production code talks to
// Neon over HTTPS with the serverless driver (works in Workers and Node); tests use
// PGlite through the same interface (see ./testing.ts).

export interface Query {
  text: string;
  params: unknown[];
}

export type Row = Record<string, unknown>;

export interface Db {
  query(q: Query): Promise<Row[]>;
  /** Runs the queries in one transaction and returns each one's rows. */
  transaction(qs: Query[]): Promise<Row[][]>;
}

/** A query with positional parameters ($1, $2, ...). */
export const q = (text: string, ...params: unknown[]): Query => ({ text, params });

/**
 * Sets app.vendor_id for the rest of the transaction only (is_local = true), so it
 * can never leak into another request. Row-level security keys on it.
 */
export const actAs = (vendorId: string): Query =>
  q("SELECT set_config('app.vendor_id', $1, true)", vendorId);

/** Neon's serverless driver: one HTTPS round trip per query or transaction. */
export function neonDb(databaseUrl: string): Db {
  const sql = neon(databaseUrl);
  return {
    query: ({ text, params }) => sql.query(text, params),
    transaction: (qs) => sql.transaction(qs.map(({ text, params }) => sql.query(text, params))),
  };
}

/**
 * Splits a migration into single statements at drizzle's `--> statement-breakpoint`
 * markers. Neon's HTTP driver runs one statement per query.
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.replace(/--[^\n]*/g, "").trim().length > 0);
}
