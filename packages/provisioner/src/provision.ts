import { encryptSecret, randomPassword } from "@neuvex/crypto";
import type { NeonApi } from "@neuvex/neon-api";
import type { Db } from "@neuvex/sql";
import {
  adoptMigrations,
  appliedMigrations,
  applyTemplate,
  configure,
  setGatewayPassword,
} from "@neuvex/vendor-db";
import type { ControlPlane, VendorRecord } from "./control.js";

// Gives a vendor its own Neon project, step by step, saving each step's result in the
// control plane before the next. Safe to run again at any time: after a failure it
// picks up where it stopped, and on a ready vendor it applies any new template
// migrations and changes nothing else.
//
//   project nvx-<slug>
//   ├── production   root branch: the vendor's audit log and, later, mold state
//   └── fixtures     schema-only root branch: same schema, no real rows; sandboxes
//                    for agent sessions branch from here (Phase 3, part 3)

export const OWNER_ROLE = "neondb_owner";
export const PRODUCTION_BRANCH = "production";
export const FIXTURES_BRANCH = "fixtures";
const REGION = /^(aws|azure)-[a-z0-9-]{3,40}$/;

export type NeonOps = Pick<
  NeonApi,
  "createProject" | "findProjects" | "listBranches" | "createBranch" | "deleteBranch" | "connectionUri"
>;

export interface ProvisionDeps {
  control: ControlPlane;
  neon: NeonOps;
  /** A connection to a vendor branch, from its owner connection string. */
  connect: (uri: string) => Db;
  /** Encrypts the gateway's connection string (AES-256-GCM, bound to the vendor ID). */
  secretKey: CryptoKey;
  defaultRegion: string;
  log?: (message: string) => void;
  newPassword?: () => string;
  now?: () => Date;
}

export interface ProvisionResult {
  vendorId: string;
  slug: string;
  projectId: string;
  region: string;
  productionBranchId: string;
  fixturesBranchId: string;
  templateVersion: number;
  created: { project: boolean; fixtures: boolean; gatewayLogin: boolean };
  applied: { production: number[]; fixtures: number[] };
}

export const projectName = (slug: string) => `nvx-${slug}`;

/** The connection string for `user` on the same host and database as `uri`. */
export function withCredentials(uri: string, user: string, password: string): string {
  const url = new URL(uri);
  url.username = user;
  url.password = password; // the setter percent-encodes anything that needs it
  return url.toString();
}

export async function provisionVendor(
  deps: ProvisionDeps,
  slug: string,
  options: { region?: string } = {},
): Promise<ProvisionResult> {
  const log = deps.log ?? (() => {});
  const vendor = await deps.control.findVendor(slug);
  if (!vendor) throw new Error(`No vendor with slug "${slug}".`);

  await deps.control.updateVendor(vendor.id, { provisionStatus: "provisioning", provisionError: null });
  try {
    return await run(deps, vendor, options, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.control
      .updateVendor(vendor.id, { provisionStatus: "failed", provisionError: message.slice(0, 1000) })
      .catch(() => {});
    throw err;
  }
}

async function run(
  deps: ProvisionDeps,
  vendor: VendorRecord,
  options: { region?: string },
  log: (message: string) => void,
): Promise<ProvisionResult> {
  const { control, neon } = deps;
  const created = { project: false, fixtures: false, gatewayLogin: false };

  // 1. The project, with its production root branch.
  let projectId = vendor.neonProjectId;
  let region = vendor.region;
  let productionBranchId = vendor.neonProductionBranchId;
  if (!projectId) {
    const name = projectName(vendor.slug);
    const existing = (await neon.findProjects(name)).find((p) => p.name === name);
    if (existing) {
      log(`Found project ${name} (${existing.id}) from an earlier run.`);
      projectId = existing.id;
      region = existing.region_id;
    } else {
      const wanted = options.region ?? vendor.region ?? deps.defaultRegion;
      if (!REGION.test(wanted)) throw new Error(`"${wanted}" is not a Neon region ID, like aws-ap-southeast-1.`);
      log(`Creating Neon project ${name} in ${wanted}...`);
      const project = await neon.createProject({ name, regionId: wanted, branchName: PRODUCTION_BRANCH });
      projectId = project.projectId;
      region = project.regionId;
      productionBranchId = project.branch.id;
      created.project = true;
    }
    await control.updateVendor(vendor.id, { neonProjectId: projectId, ...(region ? { region } : {}) });
  } else if (options.region && options.region !== vendor.region) {
    throw new Error(`${vendor.slug} already has a project in ${vendor.region}; Neon projects can't change region.`);
  }
  if (!productionBranchId) {
    const branches = await neon.listBranches(projectId);
    const production = branches.find((b) => b.name === PRODUCTION_BRANCH) ?? branches.find((b) => b.default);
    if (!production) throw new Error(`Project ${projectId} has no production branch.`);
    productionBranchId = production.id;
  }
  await control.updateVendor(vendor.id, { neonProductionBranchId: productionBranchId });

  // 2. The template on production.
  const production = deps.connect(
    await neon.connectionUri(projectId, { branchId: productionBranchId, roleName: OWNER_ROLE }),
  );
  const productionApplied = await applyTemplate(production);
  await configure(production, { vendorId: vendor.id, slug: vendor.slug, tier: vendor.tier });
  log(`Production: template version ${productionApplied.version}, applied [${productionApplied.applied.join(", ")}].`);

  // 3. The gateway's login. Set once; later runs keep the same password.
  if (!vendor.gatewayDbUrlEnc) {
    const password = (deps.newPassword ?? randomPassword)();
    await setGatewayPassword(production, password);
    const pooled = await neon.connectionUri(projectId, {
      branchId: productionBranchId,
      roleName: OWNER_ROLE,
      pooled: true,
    });
    const gatewayUri = withCredentials(pooled, "neuvex_gateway", password);
    await control.updateVendor(vendor.id, {
      gatewayDbUrlEnc: await encryptSecret(deps.secretKey, gatewayUri, vendor.id),
    });
    created.gatewayLogin = true;
    log("Gateway login created and stored encrypted.");
  }

  // 4. Fixtures: a schema-only copy of production. Its bookkeeping rows don't come
  // across, so record the migrations it was copied with. A leftover fixtures branch
  // that was never recorded (an earlier run stopped halfway) is replaced, because what
  // it was copied with can't be known.
  let fixturesBranchId = vendor.neonFixturesBranchId;
  if (!fixturesBranchId) {
    const leftover = (await neon.listBranches(projectId)).find((b) => b.name === FIXTURES_BRANCH);
    if (leftover) {
      log(`Replacing an unrecorded fixtures branch (${leftover.id}).`);
      await neon.deleteBranch(projectId, leftover.id);
    }
    log("Creating the fixtures branch (schema only)...");
    const branch = await neon.createBranch(projectId, {
      name: FIXTURES_BRANCH,
      parentId: productionBranchId,
      initSource: "schema-only",
    });
    const fresh = deps.connect(await neon.connectionUri(projectId, { branchId: branch.id, roleName: OWNER_ROLE }));
    await adoptMigrations(fresh, await appliedMigrations(production));
    fixturesBranchId = branch.id;
    await control.updateVendor(vendor.id, { neonFixturesBranchId: fixturesBranchId });
    created.fixtures = true;
  }
  const fixtures = deps.connect(
    await neon.connectionUri(projectId, { branchId: fixturesBranchId, roleName: OWNER_ROLE }),
  );
  const fixturesApplied = await applyTemplate(fixtures);
  await configure(fixtures, { vendorId: vendor.id, slug: vendor.slug, tier: vendor.tier });
  log(`Fixtures: template version ${fixturesApplied.version}, applied [${fixturesApplied.applied.join(", ")}].`);

  // 5. Done.
  await control.updateVendor(vendor.id, {
    templateVersion: productionApplied.version,
    provisionStatus: "ready",
    provisionError: null,
    provisionedAt: (deps.now ?? (() => new Date()))(),
  });

  return {
    vendorId: vendor.id,
    slug: vendor.slug,
    projectId,
    region: region ?? "",
    productionBranchId,
    fixturesBranchId,
    templateVersion: productionApplied.version,
    created,
    applied: { production: productionApplied.applied, fixtures: fixturesApplied.applied },
  };
}
