import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, text, unique, uuid } from "drizzle-orm/pg-core";
import { control } from "./namespace.js";
import { createdAt, tenantIsolation, updatedAt } from "./tenancy.js";
import { vendors } from "./vendors.js";

/** An interface a coding agent built for one end user of a vendor. */
export const molds = control.table(
  "molds",
  {
    id: uuid().primaryKey().defaultRandom(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    /** The vendor's opaque ID for the end user. Never an email address or a name. */
    endUserRef: text("end_user_ref").notNull(),
    name: text().notNull(),
    /** The live version, or null before the first publish. */
    currentVersion: integer("current_version"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("molds_vendor_id_id_key").on(t.vendorId, t.id),
    index("molds_vendor_user_idx").on(t.vendorId, t.endUserRef),
    check("molds_end_user_ref_not_email", sql`position('@' in ${t.endUserRef}) = 0`),
    tenantIsolation(),
  ],
);

/**
 * Each published change to a mold: where its built bundle lives, and the SQL that
 * applied and can undo its changes to the mold's own tables in the vendor project.
 */
export const moldVersions = control.table(
  "mold_versions",
  {
    id: uuid().primaryKey().defaultRandom(),
    vendorId: uuid("vendor_id").notNull(),
    moldId: uuid("mold_id").notNull(),
    version: integer().notNull(),
    /** Storage location of the built interface bundle. */
    bundleRef: text("bundle_ref").notNull(),
    migrationUp: text("migration_up"),
    migrationDown: text("migration_down"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "mold_versions_mold_fk",
      columns: [t.vendorId, t.moldId],
      foreignColumns: [molds.vendorId, molds.id],
    }).onDelete("cascade"),
    unique("mold_versions_mold_version_key").on(t.vendorId, t.moldId, t.version),
    check("mold_versions_version_positive", sql`${t.version} > 0`),
    tenantIsolation(),
  ],
);
