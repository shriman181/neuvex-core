import { sql, type SQL } from "drizzle-orm";
import { pgPolicy, timestamp } from "drizzle-orm/pg-core";

/**
 * The vendor the current transaction acts for. Callers set it as the first statement
 * of every transaction:
 *
 *   SELECT set_config('app.vendor_id', '<vendor uuid>', true);
 *
 * When it is unset or empty this evaluates to NULL, and every tenant policy below
 * matches no rows: forgetting to set it hides data instead of leaking it.
 */
export const currentVendorId: SQL = sql.raw(
  "nullif(current_setting('app.vendor_id', true), '')::uuid",
);

/**
 * Row-level security for a vendor-owned table: rows are visible and writable only
 * when `column` equals the current vendor. Applies to every role except table owners
 * and roles with BYPASSRLS (the migrator and Neon's admin role).
 */
export function tenantIsolation(column: "vendor_id" | "id" = "vendor_id") {
  const match = sql.raw(`${column} = nullif(current_setting('app.vendor_id', true), '')::uuid`);
  return pgPolicy("tenant_isolation", {
    as: "permissive",
    for: "all",
    to: "public",
    using: match,
    withCheck: match,
  });
}

/** created_at / updated_at columns shared by most tables. */
export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
