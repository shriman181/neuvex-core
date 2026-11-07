// Provisions (or upgrades) one vendor's Neon project. Run by the "Provision vendor"
// workflow; also runnable by hand:
//
//   NEON_API_KEY=... DATABASE_URL=<neuvex_provisioner on production> VENDOR_DB_KEY=... \
//     npm run provision -- inboxly-demo [--region aws-ap-southeast-1]
//
// Prints what it did. Never prints keys, passwords or connection strings.

import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { importKey } from "@neuvex/crypto";
import { createNeonApi } from "@neuvex/neon-api";
import { neonDb } from "@neuvex/sql";
import { controlPlane, provisionVendor } from "../src/index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { region: { type: "string" } },
});

const slug = positionals[0]?.trim();
if (!slug || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
  throw new Error("Usage: npm run provision -- <vendor-slug> [--region aws-ap-southeast-1]");
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

const neon = createNeonApi({ apiKey: env("NEON_API_KEY"), orgId: process.env.NEON_ORG_ID?.trim() || undefined });

const result = await provisionVendor(
  {
    control: controlPlane(neonDb(env("DATABASE_URL"))),
    neon,
    connect: neonDb,
    secretKey: await importKey(env("VENDOR_DB_KEY")),
    defaultRegion: process.env.DEFAULT_REGION?.trim() || "aws-ap-southeast-1",
    log: (message) => console.log(message),
  },
  slug,
  values.region?.trim() ? { region: values.region.trim() } : {},
);

const summary = [
  `### Vendor ${result.slug} is ready`,
  "",
  "| | |",
  "| --- | --- |",
  `| Vendor ID | \`${result.vendorId}\` |`,
  `| Neon project | \`${result.projectId}\` (${result.region})${result.created.project ? ", new" : ""} |`,
  `| production branch | \`${result.productionBranchId}\` |`,
  `| fixtures branch | \`${result.fixturesBranchId}\`${result.created.fixtures ? ", new" : ""} |`,
  `| Template version | ${result.templateVersion} (applied now: production [${result.applied.production.join(", ")}], fixtures [${result.applied.fixtures.join(", ")}]) |`,
  `| Gateway login | ${result.created.gatewayLogin ? "created, stored encrypted" : "unchanged"} |`,
].join("\n");

console.log(`\n${summary}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
