import { sql } from "drizzle-orm";
import { check, foreignKey, index, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { molds } from "./molds.js";
import { control } from "./namespace.js";
import { createdAt, tenantIsolation, updatedAt } from "./tenancy.js";
import { vendors } from "./vendors.js";

export const SESSION_STATUSES = [
  "provisioning",
  "active",
  "publishing",
  "published",
  "discarded",
  "expired",
  "failed",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** One agent build session and the Neon sandbox branch it works in. */
export const agentSessions = control.table(
  "agent_sessions",
  {
    id: uuid().primaryKey().defaultRandom(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    /** Null until the session's first publish creates or targets a mold. */
    moldId: uuid("mold_id"),
    /** The sandbox branch in the vendor's Neon project (Phase 3). */
    neonBranchId: text("neon_branch_id"),
    status: text().$type<SessionStatus>().notNull().default("provisioning"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    // Composite, so a session can only point at its own vendor's mold. No ON DELETE
    // action: molds are not deleted on their own, and deleting a vendor removes its
    // sessions and molds in the same statement.
    foreignKey({
      name: "agent_sessions_mold_fk",
      columns: [t.vendorId, t.moldId],
      foreignColumns: [molds.vendorId, molds.id],
    }),
    index("agent_sessions_vendor_status_idx").on(t.vendorId, t.status),
    index("agent_sessions_expires_idx").on(t.expiresAt),
    check(
      "agent_sessions_status_valid",
      sql`${t.status} in ('provisioning', 'active', 'publishing', 'published', 'discarded', 'expired', 'failed')`,
    ),
    check("agent_sessions_expiry_after_start", sql`${t.expiresAt} > ${t.createdAt}`),
    tenantIsolation(),
  ],
);
