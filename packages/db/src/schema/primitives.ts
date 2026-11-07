import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { ContractRules } from "@neuvex/contracts";
import { control } from "./namespace.js";
import { createdAt, tenantIsolation } from "./tenancy.js";
import { vendors } from "./vendors.js";

export type { ContractRules };

/** Each capability a vendor exposes, for example `email.list_messages`. */
export const primitives = control.table(
  "primitives",
  {
    id: uuid().primaryKey().defaultRandom(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("primitives_vendor_name_key").on(t.vendorId, t.name),
    // Lets child tables point at (vendor_id, id), so a row can never reference
    // another vendor's primitive.
    unique("primitives_vendor_id_id_key").on(t.vendorId, t.id),
    check("primitives_name_format", sql`${t.name} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'`),
    tenantIsolation(),
  ],
);

/**
 * The rules for one version of a primitive. Rows never change once written
 * (enforced by a trigger): a contract edit is a new version, so any past call can be
 * checked against the exact rules it ran under.
 */
export const contractVersions = control.table(
  "contract_versions",
  {
    id: uuid().primaryKey().defaultRandom(),
    vendorId: uuid("vendor_id").notNull(),
    primitiveId: uuid("primitive_id").notNull(),
    version: integer().notNull(),
    rules: jsonb().$type<ContractRules>().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "contract_versions_primitive_fk",
      columns: [t.vendorId, t.primitiveId],
      foreignColumns: [primitives.vendorId, primitives.id],
    }).onDelete("cascade"),
    unique("contract_versions_primitive_version_key").on(t.vendorId, t.primitiveId, t.version),
    check("contract_versions_version_positive", sql`${t.version} > 0`),
    check("contract_versions_rules_shape", sql`coalesce(jsonb_typeof(${t.rules} -> 'allow'), 'missing') = 'object'`),
    tenantIsolation(),
  ],
);
