import { PGlite } from "@electric-sql/pglite";
import { decryptSecret, generateKey, importKey } from "@neuvex/crypto";
import { createTestDatabase } from "@neuvex/db/testing";
import type { Branch } from "@neuvex/neon-api";
import { q, splitStatements, type Db } from "@neuvex/sql";
import { pgliteDb } from "@neuvex/sql/testing";
import { appliedMigrations, TEMPLATE, TEMPLATE_VERSION } from "@neuvex/vendor-db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { controlPlane, provisionVendor, type NeonOps, type ProvisionDeps } from "../src/index.js";

// The provisioner end to end: the real control plane (every migration, acting as
// neuvex_provisioner) and a fake Neon in which every branch is its own in-memory
// Postgres.

const VENDOR_A = "00000000-0000-4000-8000-00000000000a";
const VENDOR_B = "00000000-0000-4000-8000-00000000000b";

interface FakeBranch extends Branch {
  pg: PGlite;
}
interface FakeProject {
  id: string;
  name: string;
  region_id: string;
  branches: FakeBranch[];
}

/** A fake Neon: projects and branches in memory, one PGlite per branch. */
function fakeNeon() {
  const projects: FakeProject[] = [];
  const calls: string[] = [];
  const failNext: Partial<Record<keyof NeonOps, Error>> = {};
  let n = 0;
  const project = (id: string) => {
    const p = projects.find((x) => x.id === id);
    if (!p) throw new Error(`no project ${id}`);
    return p;
  };
  const maybeFail = (op: keyof NeonOps) => {
    calls.push(op);
    const err = failNext[op];
    if (err) {
      delete failNext[op];
      throw err;
    }
  };

  /** A schema-only copy: the template's objects (as applied on the source), no rows. */
  async function schemaOnlyCopy(source: PGlite): Promise<PGlite> {
    const copy = new PGlite();
    const versions = new Set((await appliedMigrations(pgliteDb(source))).map((m) => m.version));
    await copy.exec("CREATE SCHEMA neuvex");
    for (const m of TEMPLATE.filter((t) => versions.has(t.version))) {
      for (const s of splitStatements(m.sql)) await copy.exec(s);
    }
    return copy;
  }

  const neon: NeonOps = {
    async createProject(input) {
      maybeFail("createProject");
      const id = `proj-${++n}`;
      const branch: FakeBranch = { id: `br-${++n}`, name: input.branchName ?? "production", default: true, pg: new PGlite() };
      projects.push({ id, name: input.name, region_id: input.regionId, branches: [branch] });
      return { projectId: id, regionId: input.regionId, branch: { id: branch.id, name: branch.name }, operations: [] };
    },
    async findProjects(search) {
      maybeFail("findProjects");
      return projects.filter((p) => p.name.includes(search)).map(({ id, name, region_id }) => ({ id, name, region_id }));
    },
    async listBranches(projectId) {
      maybeFail("listBranches");
      return project(projectId).branches.map(({ id, name, default: d }) => ({ id, name, default: d ?? false }));
    },
    async createBranch(projectId, input) {
      maybeFail("createBranch");
      const p = project(projectId);
      const parent = p.branches.find((b) => b.id === input.parentId);
      if (!parent) throw new Error("no parent");
      if (input.initSource !== "schema-only") throw new Error("fake supports schema-only only");
      const branch: FakeBranch = { id: `br-${++n}`, name: input.name, init_source: "schema-only", pg: await schemaOnlyCopy(parent.pg) };
      p.branches.push(branch);
      return { id: branch.id, name: branch.name };
    },
    async deleteBranch(projectId, branchId) {
      maybeFail("deleteBranch");
      const p = project(projectId);
      p.branches = p.branches.filter((b) => b.id !== branchId);
    },
    async connectionUri(projectId, input) {
      const host = input.pooled ? `${input.branchId}-pooler.fake.neon.tech` : `${input.branchId}.fake.neon.tech`;
      return `postgresql://${input.roleName}:owner-pw@${host}/neondb?sslmode=require&project=${projectId}`;
    },
  };

  /** Owner connections, routed to the branch's PGlite by host. */
  const connect = (uri: string): Db => {
    const branchId = new URL(uri).hostname.split(".")[0]!.replace(/-pooler$/, "");
    for (const p of projects) {
      const b = p.branches.find((x) => x.id === branchId);
      if (b) return pgliteDb(b.pg);
    }
    throw new Error(`no branch for ${uri}`);
  };

  return { neon, connect, projects, calls, failNext };
}

let control: PGlite;
let key: CryptoKey;

beforeAll(async () => {
  control = await createTestDatabase();
  key = await importKey(generateKey());
});

afterAll(async () => {
  await control?.close();
});

beforeEach(async () => {
  await control.exec("TRUNCATE control.vendors CASCADE");
  await control.query(
    `INSERT INTO control.vendors (id, slug, name, tier) VALUES ($1, 'acme-mail', 'Acme Mail', 'developer'), ($2, 'globex-crm', 'Globex CRM', 'startup')`,
    [VENDOR_A, VENDOR_B],
  );
});

function deps(fake: ReturnType<typeof fakeNeon>, extra: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    control: controlPlane(pgliteDb(control, "neuvex_provisioner")),
    neon: fake.neon,
    connect: fake.connect,
    secretKey: key,
    defaultRegion: "aws-ap-southeast-1",
    newPassword: () => "gateway-password-0123456789abcdef",
    now: () => new Date("2026-11-07T15:00:00Z"),
    ...extra,
  };
}

const vendorRow = async (id: string) =>
  (await control.query<Record<string, unknown>>("SELECT * FROM control.vendors WHERE id = $1", [id])).rows[0]!;

describe("provisioning a vendor", () => {
  it("creates the project, applies the template, stores the gateway login and makes fixtures", async () => {
    const fake = fakeNeon();
    const result = await provisionVendor(deps(fake), "acme-mail");

    expect(result).toMatchObject({
      vendorId: VENDOR_A,
      region: "aws-ap-southeast-1",
      templateVersion: TEMPLATE_VERSION,
      created: { project: true, fixtures: true, gatewayLogin: true },
      applied: { production: [1, 2], fixtures: [] },
    });
    expect(fake.projects).toHaveLength(1);
    expect(fake.projects[0]?.name).toBe("nvx-acme-mail");

    const row = await vendorRow(VENDOR_A);
    expect(row).toMatchObject({
      neon_project_id: result.projectId,
      neon_production_branch_id: result.productionBranchId,
      neon_fixtures_branch_id: result.fixturesBranchId,
      template_version: TEMPLATE_VERSION,
      provision_status: "ready",
      provision_error: null,
      region: "aws-ap-southeast-1",
    });

    // The stored login decrypts only for this vendor, and points at the pooled host.
    const uri = await decryptSecret(key, String(row.gateway_db_url_enc), VENDOR_A);
    const url = new URL(uri);
    expect(url.username).toBe("neuvex_gateway");
    expect(url.password).toBe("gateway-password-0123456789abcdef");
    expect(url.hostname).toBe(`${result.productionBranchId}-pooler.fake.neon.tech`);
    await expect(decryptSecret(key, String(row.gateway_db_url_enc), VENDOR_B)).rejects.toThrow();

    // Production and fixtures both know their vendor and template version; the
    // gateway role can log in on production.
    const [prod, fixtures] = fake.projects[0]!.branches;
    for (const b of [prod!, fixtures!]) {
      expect((await b.pg.query("SELECT vendor_id, audit_retention_days FROM neuvex.settings")).rows).toEqual([
        { vendor_id: VENDOR_A, audit_retention_days: 7 },
      ]);
      expect((await appliedMigrations(pgliteDb(b.pg))).map((m) => m.version)).toEqual([1, 2]);
    }
    expect((await prod!.pg.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = 'neuvex_gateway'")).rows).toEqual([
      { rolcanlogin: true },
    ]);
    expect(fixtures!.init_source).toBe("schema-only");
  });

  it("changes nothing on a second run, and keeps the gateway's password", async () => {
    const fake = fakeNeon();
    await provisionVendor(deps(fake), "acme-mail");
    const before = await vendorRow(VENDOR_A);
    fake.calls.length = 0;

    const again = await provisionVendor(deps(fake, { newPassword: () => "a-different-password-0123456789" }), "acme-mail");
    expect(again.created).toEqual({ project: false, fixtures: false, gatewayLogin: false });
    expect(again.applied).toEqual({ production: [], fixtures: [] });
    expect(fake.calls).not.toContain("createProject");
    expect(fake.calls).not.toContain("createBranch");
    const after = await vendorRow(VENDOR_A);
    expect(after.gateway_db_url_enc).toBe(before.gateway_db_url_enc);
    expect(after.provision_status).toBe("ready");
  });

  it("records a failure, then finishes from where it stopped", async () => {
    const fake = fakeNeon();
    fake.failNext.createBranch = new Error("Neon API POST /branches failed (500): try again");
    await expect(provisionVendor(deps(fake), "acme-mail")).rejects.toThrow(/try again/);
    expect(await vendorRow(VENDOR_A)).toMatchObject({
      provision_status: "failed",
      provision_error: "Neon API POST /branches failed (500): try again",
    });
    expect((await vendorRow(VENDOR_A)).neon_project_id).toBeTruthy();

    fake.calls.length = 0;
    const result = await provisionVendor(deps(fake), "acme-mail");
    expect(fake.calls).not.toContain("createProject");
    expect(result.created).toMatchObject({ project: false, fixtures: true, gatewayLogin: false });
    expect(await vendorRow(VENDOR_A)).toMatchObject({ provision_status: "ready", provision_error: null });
    expect(fake.projects).toHaveLength(1);
  });

  it("reuses a project an earlier run created but never recorded, and replaces its fixtures", async () => {
    const fake = fakeNeon();
    // An earlier run got as far as the project and fixtures, then lost its records.
    const p = await fake.neon.createProject({ name: "nvx-globex-crm", regionId: "aws-us-east-1" });
    await fake.neon.createBranch(p.projectId, { name: "fixtures", parentId: p.branch.id, initSource: "schema-only" });
    const stale = fake.projects[0]!.branches[1]!.id;
    fake.calls.length = 0;

    const result = await provisionVendor(deps(fake), "globex-crm");
    expect(fake.calls).not.toContain("createProject");
    expect(fake.calls).toContain("deleteBranch");
    expect(result).toMatchObject({ projectId: p.projectId, region: "aws-us-east-1" });
    expect(result.fixturesBranchId).not.toBe(stale);
    expect(fake.projects[0]!.branches.map((b) => b.name)).toEqual(["production", "fixtures"]);
    // startup tier keeps audit events for 30 days
    expect((await fake.projects[0]!.branches[0]!.pg.query("SELECT audit_retention_days FROM neuvex.settings")).rows).toEqual([
      { audit_retention_days: 30 },
    ]);
  });

  it("creates the project in the region asked for, and refuses to move it later", async () => {
    const fake = fakeNeon();
    const result = await provisionVendor(deps(fake), "acme-mail", { region: "aws-eu-central-1" });
    expect(result.region).toBe("aws-eu-central-1");
    await expect(provisionVendor(deps(fake), "acme-mail", { region: "aws-us-east-1" })).rejects.toThrow(
      /can't change region/,
    );
    await expect(provisionVendor(deps(fakeNeon()), "globex-crm", { region: "mars-1" })).rejects.toThrow(
      /not a Neon region/,
    );
  });

  it("refuses an unknown vendor", async () => {
    await expect(provisionVendor(deps(fakeNeon()), "nobody")).rejects.toThrow(/No vendor with slug "nobody"/);
  });

  it("acts only through the provisioner's own grants", async () => {
    const fake = fakeNeon();
    await provisionVendor(deps(fake), "acme-mail");
    // The same control-plane connection cannot see the other vendor's row.
    const db = pgliteDb(control, "neuvex_provisioner");
    expect(await db.query(q("SELECT id FROM control.vendors"))).toEqual([]);
  });
});
