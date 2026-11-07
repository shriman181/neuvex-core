import { actAs, q, type Db } from "@neuvex/sql";

// The provisioner's view of the control plane, as neuvex_provisioner: find a vendor by
// slug, then read and update only its provisioning columns (migration 0005).

export type Tier = "developer" | "startup" | "scale" | "enterprise";
export type ProvisionStatus = "pending" | "provisioning" | "ready" | "failed";

export interface VendorRecord {
  id: string;
  slug: string;
  tier: Tier;
  region: string | null;
  neonProjectId: string | null;
  neonProductionBranchId: string | null;
  neonFixturesBranchId: string | null;
  gatewayDbUrlEnc: string | null;
  templateVersion: number;
  provisionStatus: ProvisionStatus;
}

export interface VendorPatch {
  neonProjectId?: string;
  region?: string;
  neonProductionBranchId?: string;
  neonFixturesBranchId?: string;
  gatewayDbUrlEnc?: string;
  templateVersion?: number;
  provisionStatus?: ProvisionStatus;
  provisionError?: string | null;
  provisionedAt?: Date;
}

export interface ControlPlane {
  findVendor(slug: string): Promise<VendorRecord | null>;
  updateVendor(id: string, patch: VendorPatch): Promise<void>;
}

const COLUMNS: Record<keyof VendorPatch, string> = {
  neonProjectId: "neon_project_id",
  region: "region",
  neonProductionBranchId: "neon_production_branch_id",
  neonFixturesBranchId: "neon_fixtures_branch_id",
  gatewayDbUrlEnc: "gateway_db_url_enc",
  templateVersion: "template_version",
  provisionStatus: "provision_status",
  provisionError: "provision_error",
  provisionedAt: "provisioned_at",
};

export function controlPlane(db: Db): ControlPlane {
  return {
    async findVendor(slug) {
      const [found] = await db.query(q("SELECT control.vendor_id_for_slug($1) AS id", slug));
      const id = found?.id;
      if (typeof id !== "string") return null;
      const [, rows] = await db.transaction([
        actAs(id),
        q(
          `SELECT id, slug, tier, region, neon_project_id, neon_production_branch_id,
                  neon_fixtures_branch_id, gateway_db_url_enc, template_version, provision_status
           FROM control.vendors WHERE id = $1`,
          id,
        ),
      ]);
      const r = rows?.[0];
      if (!r) return null;
      return {
        id: String(r.id),
        slug: String(r.slug),
        tier: r.tier as Tier,
        region: (r.region as string | null) ?? null,
        neonProjectId: (r.neon_project_id as string | null) ?? null,
        neonProductionBranchId: (r.neon_production_branch_id as string | null) ?? null,
        neonFixturesBranchId: (r.neon_fixtures_branch_id as string | null) ?? null,
        gatewayDbUrlEnc: (r.gateway_db_url_enc as string | null) ?? null,
        templateVersion: Number(r.template_version),
        provisionStatus: r.provision_status as ProvisionStatus,
      };
    },

    async updateVendor(id, patch) {
      const entries = (Object.keys(patch) as Array<keyof VendorPatch>).filter((k) => patch[k] !== undefined);
      const sets = entries.map((k, i) => `${COLUMNS[k]} = $${i + 2}`);
      const values = entries.map((k) => {
        const v = patch[k];
        return v instanceof Date ? v.toISOString() : v;
      });
      const [, rows] = await db.transaction([
        actAs(id),
        q(
          `UPDATE control.vendors SET ${[...sets, "updated_at = now()"].join(", ")} WHERE id = $1 RETURNING id`,
          id,
          ...values,
        ),
      ]);
      if (!rows?.length) throw new Error(`Vendor ${id} was not updated (not found, or not visible to this role).`);
    },
  };
}
