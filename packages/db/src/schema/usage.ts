import { sql } from "drizzle-orm";
import { bigint, check, date, integer, primaryKey, uuid } from "drizzle-orm/pg-core";
import { control } from "./namespace.js";
import { tenantIsolation } from "./tenancy.js";
import { vendors } from "./vendors.js";

/** Daily usage per vendor, for billing by molded sessions and primitive calls. */
export const usageDaily = control.table(
  "usage_daily",
  {
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    day: date().notNull(),
    moldedSessions: integer("molded_sessions").notNull().default(0),
    primitiveCalls: bigint("primitive_calls", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    primaryKey({ name: "usage_daily_pkey", columns: [t.vendorId, t.day] }),
    check(
      "usage_daily_counts_non_negative",
      sql`${t.moldedSessions} >= 0 and ${t.primitiveCalls} >= 0`,
    ),
    tenantIsolation(),
  ],
);
