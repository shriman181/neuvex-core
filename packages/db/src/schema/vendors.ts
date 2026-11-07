import { sql } from "drizzle-orm";
import { check, index, integer, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { control } from "./namespace.js";
import { createdAt, tenantIsolation, updatedAt } from "./tenancy.js";

export const VENDOR_TIERS = ["developer", "startup", "scale", "enterprise"] as const;
export type VendorTier = (typeof VENDOR_TIERS)[number];

export const PROVISION_STATUSES = ["pending", "provisioning", "ready", "failed"] as const;
export type ProvisionStatus = (typeof PROVISION_STATUSES)[number];

/** Each software company that uses Neuvex. */
export const vendors = control.table(
  "vendors",
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull(),
    name: text().notNull(),
    tier: text().$type<VendorTier>().notNull().default("developer"),
    /** The vendor's own Neon project (Phase 3). Null until it is provisioned. */
    neonProjectId: text("neon_project_id"),
    /** Neon region of the vendor's project, for example aws-us-east-1. */
    region: text(),
    /** The project's root branch holding live mold state and the audit log. */
    neonProductionBranchId: text("neon_production_branch_id"),
    /** Schema-only copy of production with synthetic data; sandboxes branch from it. */
    neonFixturesBranchId: text("neon_fixtures_branch_id"),
    /**
     * Connection string for neuvex_gateway on the vendor's production branch,
     * encrypted with AES-256-GCM (key in the Workers' secrets, never in the database).
     */
    gatewayDbUrlEnc: text("gateway_db_url_enc"),
    /** The vendor template version applied to production and fixtures. */
    templateVersion: integer("template_version").notNull().default(0),
    provisionStatus: text("provision_status").$type<ProvisionStatus>().notNull().default("pending"),
    provisionError: text("provision_error"),
    provisionedAt: timestamp("provisioned_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("vendors_slug_key").on(t.slug),
    check("vendors_slug_format", sql`${t.slug} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`),
    check("vendors_tier_valid", sql`${t.tier} in ('developer', 'startup', 'scale', 'enterprise')`),
    check(
      "vendors_provision_status_valid",
      sql`${t.provisionStatus} in ('pending', 'provisioning', 'ready', 'failed')`,
    ),
    tenantIsolation("id"),
  ],
);

/**
 * API keys vendors use to call Neuvex. Only a SHA-256 hash of each key is stored;
 * the prefix is kept so a vendor can tell keys apart in the console.
 */
export const vendorKeys = control.table(
  "vendor_keys",
  {
    id: uuid().primaryKey().defaultRandom(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: text().array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    unique("vendor_keys_key_hash_key").on(t.keyHash),
    index("vendor_keys_vendor_idx").on(t.vendorId),
    check("vendor_keys_hash_format", sql`${t.keyHash} ~ '^[0-9a-f]{64}$'`),
    tenantIsolation(),
  ],
);
