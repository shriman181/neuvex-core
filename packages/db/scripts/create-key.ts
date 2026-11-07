// Creates an API key for a vendor and prints it once. Only its SHA-256 hash is stored,
// so a lost key cannot be recovered: revoke it and make a new one.
//
//   set -a; source .env; set +a
//   npm run db:create-key -- inboxly-demo
//   npm run db:create-key -- inboxly-demo --scopes gateway:check,email:read
//
// Default scope: gateway:check (enough to call POST /v1/check).

import { createHash, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { vendorKeys, vendors } from "../src/schema/tables.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { scopes: { type: "string", default: "gateway:check" } },
});
const slug = positionals[0];
if (!slug) throw new Error("Usage: npm run db:create-key -- <vendor-slug> [--scopes a,b]");

const scopes = values.scopes
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (scopes.some((s) => !/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(s))) {
  throw new Error("Scopes look like gateway:check or email:read.");
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set.");

const key = `nvx_live_${randomBytes(32).toString("base64url")}`;
const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool);

try {
  const [vendor] = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.slug, slug));
  if (!vendor) throw new Error(`No vendor with slug "${slug}".`);

  const [row] = await db
    .insert(vendorKeys)
    .values({
      vendorId: vendor.id,
      keyPrefix: key.slice(0, 13),
      keyHash: createHash("sha256").update(key).digest("hex"),
      scopes,
    })
    .returning({ id: vendorKeys.id });

  console.log(`Key ${row?.id} for ${slug}, scopes: ${scopes.join(", ")}`);
  console.log(`\n  ${key}\n`);
  console.log("This is the only time it is shown. Store it somewhere safe.");
} finally {
  await pool.end();
}
