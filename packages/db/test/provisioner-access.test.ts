import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../src/testing.js";

// What neuvex_provisioner can do in the control plane (migrations 0004 and 0005).

const VENDOR_A = "00000000-0000-4000-8000-00000000000a";
const VENDOR_B = "00000000-0000-4000-8000-00000000000b";

let pg: PGlite;

/** Runs statements as neuvex_provisioner, acting for `vendorId` (or for nobody). */
async function asProvisioner<T>(vendorId: string | null, fn: () => Promise<T>): Promise<T> {
  await pg.exec("SET ROLE neuvex_provisioner");
  await pg.query("SELECT set_config('app.vendor_id', $1, false)", [vendorId ?? ""]);
  try {
    return await fn();
  } finally {
    await pg.exec("RESET ROLE");
    await pg.query("SELECT set_config('app.vendor_id', '', false)");
  }
}

const rows = async (sql: string, params: unknown[] = []) =>
  (await pg.query<Record<string, unknown>>(sql, params)).rows;

beforeAll(async () => {
  pg = await createTestDatabase();
  await pg.query(
    `INSERT INTO control.vendors (id, slug, name) VALUES ($1, 'acme-mail', 'Acme Mail'), ($2, 'globex-crm', 'Globex CRM')`,
    [VENDOR_A, VENDOR_B],
  );
});

afterAll(async () => {
  await pg?.close();
});

describe("provisioner access", () => {
  it("new vendors start pending at template version 0", async () => {
    expect(await rows("SELECT provision_status, template_version FROM control.vendors WHERE id = $1", [VENDOR_A])).toEqual([
      { provision_status: "pending", template_version: 0 },
    ]);
  });

  it("finds a vendor by slug, and sees only the vendor it acts for", async () => {
    await asProvisioner(null, async () => {
      expect(await rows("SELECT control.vendor_id_for_slug('acme-mail') AS id")).toEqual([{ id: VENDOR_A }]);
      expect(await rows("SELECT control.vendor_id_for_slug('nobody') AS id")).toEqual([{ id: null }]);
      expect(await rows("SELECT id FROM control.vendors")).toEqual([]);
    });
    await asProvisioner(VENDOR_A, async () => {
      expect(await rows("SELECT id FROM control.vendors")).toEqual([{ id: VENDOR_A }]);
    });
  });

  it("updates provisioning columns of its own vendor only", async () => {
    await asProvisioner(VENDOR_A, async () => {
      const updated = await pg.query(
        `UPDATE control.vendors
         SET neon_project_id = 'proj-1', region = 'aws-ap-southeast-1', provision_status = 'ready',
             template_version = 2, gateway_db_url_enc = 'v1.x.y', provisioned_at = now(), updated_at = now()
         WHERE id = $1`,
        [VENDOR_A],
      );
      expect(updated.affectedRows).toBe(1);
      const other = await pg.query("UPDATE control.vendors SET provision_status = 'failed' WHERE id = $1", [VENDOR_B]);
      expect(other.affectedRows).toBe(0);
    });
    expect(await rows("SELECT provision_status FROM control.vendors WHERE id = $1", [VENDOR_B])).toEqual([
      { provision_status: "pending" },
    ]);
  });

  it("cannot rename vendors, change tiers, or create and delete them", async () => {
    await asProvisioner(VENDOR_A, async () => {
      await expect(pg.query("UPDATE control.vendors SET tier = 'scale' WHERE id = $1", [VENDOR_A])).rejects.toThrow(
        /permission denied/,
      );
      await expect(pg.query("UPDATE control.vendors SET name = 'x' WHERE id = $1", [VENDOR_A])).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        pg.query("INSERT INTO control.vendors (id, slug, name) VALUES ($1, 'new-co', 'New')", [VENDOR_A]),
      ).rejects.toThrow(/permission denied/);
      await expect(pg.query("DELETE FROM control.vendors WHERE id = $1", [VENDOR_A])).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  it("cannot read keys or contracts", async () => {
    await asProvisioner(VENDOR_A, async () => {
      await expect(pg.query("SELECT * FROM control.vendor_keys")).rejects.toThrow(/permission denied/);
      await expect(pg.query("SELECT * FROM control.contract_versions")).rejects.toThrow(/permission denied/);
    });
  });

  it("rejects an unknown provisioning status", async () => {
    await expect(
      pg.query("UPDATE control.vendors SET provision_status = 'done' WHERE id = $1", [VENDOR_A]),
    ).rejects.toThrow(/vendors_provision_status_valid/);
  });
});
