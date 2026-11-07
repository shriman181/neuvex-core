import { q, splitStatements, type Db } from "@neuvex/sql";
import * as neuvex from "./template/0001_neuvex.js";
import * as audit from "./template/0002_audit.js";

// The template every vendor's Neon project runs: its own audit log and the roles
// Neuvex uses there. Applied by the provisioner to each vendor's production and
// fixtures branches, as the project's owner role. Each migration is applied in one
// transaction together with its bookkeeping row, so a failure leaves nothing behind.

export interface TemplateMigration {
  version: number;
  name: string;
  sql: string;
}

export const TEMPLATE: readonly TemplateMigration[] = [
  { version: 1, ...neuvex },
  { version: 2, ...audit },
];

export const TEMPLATE_VERSION = TEMPLATE[TEMPLATE.length - 1]!.version;

const BOOTSTRAP = [
  "CREATE SCHEMA IF NOT EXISTS neuvex",
  `CREATE TABLE IF NOT EXISTS neuvex.template_migrations (
     version integer PRIMARY KEY,
     name text NOT NULL,
     checksum text NOT NULL,
     applied_at timestamptz NOT NULL DEFAULT now()
   )`,
];

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

export async function checksum(sql: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sql));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function appliedMigrations(db: Db): Promise<AppliedMigration[]> {
  await db.transaction(BOOTSTRAP.map((t) => q(t)));
  const rows = await db.query(
    q("SELECT version, name, checksum FROM neuvex.template_migrations ORDER BY version"),
  );
  return rows.map((r) => ({ version: Number(r.version), name: String(r.name), checksum: String(r.checksum) }));
}

/**
 * Applies every template migration the database doesn't have yet. Refuses to run if a
 * migration it already has was changed, or if it has one this code doesn't know.
 */
export async function applyTemplate(
  db: Db,
  template: readonly TemplateMigration[] = TEMPLATE,
): Promise<{ applied: number[]; version: number }> {
  const done = new Map((await appliedMigrations(db)).map((m) => [m.version, m]));

  for (const m of done.values()) {
    const known = template.find((t) => t.version === m.version);
    if (!known) {
      throw new Error(
        `This project has template migration ${m.version} (${m.name}), which this code doesn't know. Deploy newer code first.`,
      );
    }
    if ((await checksum(known.sql)) !== m.checksum) {
      throw new Error(`Template migration ${m.version} (${m.name}) was changed after it was applied. Add a new migration instead.`);
    }
  }

  const applied: number[] = [];
  for (const m of template) {
    if (done.has(m.version)) continue;
    await db.transaction([
      ...splitStatements(m.sql).map((s) => q(s)),
      q(
        "INSERT INTO neuvex.template_migrations (version, name, checksum) VALUES ($1, $2, $3)",
        m.version,
        m.name,
        await checksum(m.sql),
      ),
    ]);
    applied.push(m.version);
  }
  return { applied, version: template[template.length - 1]?.version ?? 0 };
}

/**
 * A schema-only branch copies the schema but none of the rows, including the
 * bookkeeping. This records `migrations` (read from the source branch) as applied,
 * so later template upgrades run on the copy too.
 */
export async function adoptMigrations(db: Db, migrations: AppliedMigration[]): Promise<void> {
  await db.transaction([
    ...BOOTSTRAP.map((t) => q(t)),
    ...migrations.map((m) =>
      q(
        `INSERT INTO neuvex.template_migrations (version, name, checksum) VALUES ($1, $2, $3)
         ON CONFLICT (version) DO NOTHING`,
        m.version,
        m.name,
        m.checksum,
      ),
    ),
  ]);
}

export const AUDIT_RETENTION_DAYS = { developer: 7, startup: 30, scale: 365, enterprise: 365 } as const;
export type Tier = keyof typeof AUDIT_RETENTION_DAYS;

/** Sets which vendor the project belongs to (once) and its settings (any time). */
export async function configure(
  db: Db,
  input: { vendorId: string; slug: string; tier: Tier },
): Promise<void> {
  await db.query(
    q("SELECT neuvex.configure($1, $2, $3)", input.vendorId, input.slug, AUDIT_RETENTION_DAYS[input.tier]),
  );
}

/** Lets neuvex_gateway log in with `password`. */
export async function setGatewayPassword(db: Db, password: string): Promise<void> {
  await db.query(q("SELECT neuvex.set_login_password('neuvex_gateway', $1)", password));
}
