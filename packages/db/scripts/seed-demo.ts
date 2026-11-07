// Seeds the demo vendor used for the email-as-task-list / email-as-calendar demo:
// one vendor, three email primitives, and version 1 of each contract.
//
// Run against the dev branch only:
//   set -a; source .env; set +a
//   npm run db:seed:demo
//
// Safe to run more than once: existing rows are left as they are.

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { ContractRules } from "../src/schema/primitives.js";
import { contractVersions, primitives, vendors } from "../src/schema/tables.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set. Point it at the dev branch.");
if (/ep-wispy-brook-aort84i4/.test(url)) {
  throw new Error("Refusing to seed production. Use the dev branch's connection string.");
}

const DEMO: Array<{ name: string; description: string; rules: ContractRules }> = [
  {
    name: "email.list_messages",
    description: "List messages in a folder, newest first.",
    rules: {
      allow: { actions: ["read"], fields: ["id", "from", "subject", "received_at", "labels"] },
      redact: ["from.address"],
      rateLimit: 120,
    },
  },
  {
    name: "email.get_message",
    description: "Read one message, including its body.",
    rules: {
      allow: { actions: ["read"], fields: ["id", "from", "subject", "body", "received_at"] },
      deny: { fields: ["headers"] },
      redact: ["from.address"],
      rateLimit: 60,
    },
  },
  {
    name: "email.update_labels",
    description: "Add or remove labels on a message. Cannot send, move or delete.",
    rules: {
      allow: { actions: ["update"], fields: ["labels"] },
      deny: { actions: ["send", "delete", "move"] },
      rateLimit: 30,
    },
  },
];

const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool);

try {
  const [vendor] = await db
    .insert(vendors)
    .values({ slug: "inboxly-demo", name: "Inboxly (demo)", tier: "developer" })
    .onConflictDoUpdate({ target: vendors.slug, set: { name: sql`excluded.name` } })
    .returning({ id: vendors.id });
  if (!vendor) throw new Error("Could not create the demo vendor.");

  for (const p of DEMO) {
    const [primitive] = await db
      .insert(primitives)
      .values({ vendorId: vendor.id, name: p.name, description: p.description })
      .onConflictDoUpdate({
        target: [primitives.vendorId, primitives.name],
        set: { description: sql`excluded.description` },
      })
      .returning({ id: primitives.id });
    if (!primitive) throw new Error(`Could not create ${p.name}.`);

    await db
      .insert(contractVersions)
      .values({ vendorId: vendor.id, primitiveId: primitive.id, version: 1, rules: p.rules })
      .onConflictDoNothing();
  }

  console.log(`Demo vendor ready: inboxly-demo (${vendor.id}) with ${DEMO.length} primitives.`);
} finally {
  await pool.end();
}
