import { actAs, neonDb, q, type Db } from "@neuvex/sql";
import { isContractRules, type ContractRules } from "@neuvex/contracts";

export interface KeyRecord {
  vendorId: string;
  keyId: string;
  scopes: string[];
}

export type ContractLookup =
  | { kind: "found"; version: number; rules: ContractRules }
  | { kind: "no_contract" }
  | { kind: "unknown_primitive" };

export interface AuditEvent {
  vendorId: string;
  requestId: string;
  sessionId: string | undefined;
  endUserRef: string | undefined;
  primitive: string;
  action: string;
  contractVersion: number | undefined;
  decision: "allowed" | "denied";
  reason: string;
  detail: string | undefined;
  scopes: string[];
  redactedFields: string[];
  latencyMs: number;
}

export interface ContractSummary {
  primitive: string;
  description: string | null;
  version: number | null;
  rules: ContractRules | null;
}

/** What audit.vendor_summary() returns (migration 0006). */
export interface AuditSummary {
  today: { date: string; allowed: number; denied: number };
  total: number;
  recent: Array<{
    id: number;
    ts: string;
    primitive: string;
    action: string;
    decision: "allowed" | "denied";
    reason: string;
    contract_version: number | null;
    latency_ms: number | null;
  }>;
  checkpoints: Array<{ day: string; events: number; hash: string; verified: boolean | null }>;
  storage: { table: string; partition: string; postgres: string };
}

/** Everything the gateway needs from the database. */
export interface Store {
  resolveKey(keyHash: string): Promise<KeyRecord | null>;
  loadContract(vendorId: string, primitive: string): Promise<ContractLookup>;
  /** Every primitive of the vendor with its latest contract, by name. */
  listContracts(vendorId: string): Promise<ContractSummary[]>;
  /** The vendor's own audit numbers, recent decisions and verified checkpoints. */
  auditSummary(vendorId: string, recent: number): Promise<AuditSummary>;
  /** Writes the audit event, bumps daily usage and marks the key as used, atomically. */
  recordCall(event: AuditEvent, keyId: string): Promise<void>;
  runMaintenance(): Promise<unknown>;
}

export function createStore(db: Db): Store {
  return {
    async resolveKey(keyHash) {
      const [row] = await db.query(
        q("SELECT vendor_id, key_id, scopes FROM control.resolve_vendor_key($1)", keyHash),
      );
      return row
        ? { vendorId: String(row.vendor_id), keyId: String(row.key_id), scopes: row.scopes as string[] }
        : null;
    },

    async loadContract(vendorId, primitive) {
      const [, rows] = await db.transaction([
        actAs(vendorId),
        q(
          `SELECT cv.version, cv.rules
           FROM control.primitives p
           LEFT JOIN LATERAL (
             SELECT c.version, c.rules FROM control.contract_versions c
             WHERE c.vendor_id = p.vendor_id AND c.primitive_id = p.id
             ORDER BY c.version DESC LIMIT 1
           ) cv ON true
           WHERE p.name = $1`,
          primitive,
        ),
      ]);
      const row = rows?.[0];
      if (!row) return { kind: "unknown_primitive" };
      if (row.version === null || !isContractRules(row.rules)) return { kind: "no_contract" };
      return { kind: "found", version: Number(row.version), rules: row.rules };
    },

    async listContracts(vendorId) {
      const [, rows] = await db.transaction([
        actAs(vendorId),
        q(
          `SELECT p.name, p.description, cv.version, cv.rules
           FROM control.primitives p
           LEFT JOIN LATERAL (
             SELECT c.version, c.rules FROM control.contract_versions c
             WHERE c.vendor_id = p.vendor_id AND c.primitive_id = p.id
             ORDER BY c.version DESC LIMIT 1
           ) cv ON true
           ORDER BY p.name`,
        ),
      ]);
      return (rows ?? []).map((r) => ({
        primitive: String(r.name),
        description: (r.description as string | null) ?? null,
        version: r.version === null || r.version === undefined ? null : Number(r.version),
        rules: isContractRules(r.rules) ? r.rules : null,
      }));
    },

    async auditSummary(vendorId, recent) {
      const [, rows] = await db.transaction([
        actAs(vendorId),
        q("SELECT audit.vendor_summary($1) AS summary", recent),
      ]);
      const summary = rows?.[0]?.summary as AuditSummary | undefined;
      if (!summary) throw new Error("audit.vendor_summary returned nothing");
      // Counts come back as JSON numbers; keep them numbers whatever the driver does.
      return {
        ...summary,
        total: Number(summary.total),
        today: { ...summary.today, allowed: Number(summary.today.allowed), denied: Number(summary.today.denied) },
      };
    },

    async recordCall(e, keyId) {
      await db.transaction([
        actAs(e.vendorId),
        q(
          `INSERT INTO audit.events (
             vendor_id, request_id, session_id, end_user_ref, primitive, action,
             contract_version, decision, reason, detail, scopes, redacted_fields, latency_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          e.vendorId,
          e.requestId,
          e.sessionId ?? null,
          e.endUserRef ?? null,
          e.primitive,
          e.action,
          e.contractVersion ?? null,
          e.decision,
          e.reason,
          e.detail ?? null,
          e.scopes,
          e.redactedFields,
          e.latencyMs,
        ),
        q(
          `INSERT INTO control.usage_daily (vendor_id, day, primitive_calls)
           VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
           ON CONFLICT (vendor_id, day)
           DO UPDATE SET primitive_calls = control.usage_daily.primitive_calls + 1`,
          e.vendorId,
        ),
        q("SELECT control.touch_vendor_key($1)", keyId),
      ]);
    },

    async runMaintenance() {
      const [row] = await db.query(q("SELECT audit.run_maintenance() AS result"));
      return row?.result;
    },
  };
}

/** `databaseUrl` must be the neuvex_gateway role's connection string. */
export type { Db };

export const neonStore = (databaseUrl: string): Store => createStore(neonDb(databaseUrl));
