// Registers an API key you already hold (for example from a CI secret) for a vendor.
// Only its SHA-256 hash is stored. Safe to rerun: an existing key keeps its ID and gets
// the scopes given here. A revoked key is never brought back.
//
//   KEY=nvx_play_... DATABASE_URL=<MIGRATOR_DATABASE_URL> \
//     npm run db:ensure-key -- inboxly-demo --scopes gateway:check,contracts:read,audit:read
//
// Used by the Deploy workflow to register the Playground's demo key.

import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import pg from "pg";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { scopes: { type: "string", default: "gateway:check" } },
});
const slug = positionals[0];
if (!slug) throw new Error("Usage: KEY=... npm run db:ensure-key -- <vendor-slug> [--scopes a,b]");

const key = process.env.KEY?.trim();
if (!key || key.length < 24) throw new Error("KEY must hold the key, at least 24 characters.");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set.");

const scopes = values.scopes.split(",").map((s) => s.trim()).filter(Boolean);
if (!scopes.length || scopes.some((s) => !/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(s))) {
  throw new Error("Scopes look like gateway:check or audit:read.");
}

const hash = createHash("sha256").update(key).digest("hex");
const pool = new pg.Pool({ connectionString: url, max: 1 });

try {
  const vendor = await pool.query<{ id: string }>("SELECT id FROM control.vendors WHERE slug = $1", [slug]);
  const vendorId = vendor.rows[0]?.id;
  if (!vendorId) throw new Error(`No vendor with slug "${slug}".`);

  const existing = await pool.query<{ vendor_id: string; revoked_at: Date | null }>(
    "SELECT vendor_id, revoked_at FROM control.vendor_keys WHERE key_hash = $1",
    [hash],
  );
  const row = existing.rows[0];
  if (row && row.vendor_id !== vendorId) throw new Error("This key is registered for a different vendor.");
  if (row?.revoked_at) throw new Error("This key was revoked. Generate a new one.");

  if (row) {
    await pool.query("UPDATE control.vendor_keys SET scopes = $2 WHERE key_hash = $1", [hash, scopes]);
    console.log(`Key ${key.slice(0, 12)}… already registered for ${slug}; scopes set to ${scopes.join(", ")}.`);
  } else {
    await pool.query(
      "INSERT INTO control.vendor_keys (vendor_id, key_prefix, key_hash, scopes) VALUES ($1, $2, $3, $4)",
      [vendorId, key.slice(0, 12), hash, scopes],
    );
    console.log(`Key ${key.slice(0, 12)}… registered for ${slug} with ${scopes.join(", ")}.`);
  }
} finally {
  await pool.end();
}
