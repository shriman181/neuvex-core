import { evaluate, shape } from "@neuvex/contracts";
import type { AuditEvent, Store } from "./store.js";

/** The scope a vendor key needs to call the gateway. */
export const CHECK_SCOPE = "gateway:check";
const MAX_BODY_BYTES = 1_000_000;

const PRIMITIVE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const ACTION = /^[a-z][a-z0-9_]{0,63}$/;
const FIELD = /^[A-Za-z0-9_]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Deps {
  store: Store;
  /** Runs work after the response is sent (ctx.waitUntil in Workers). */
  waitUntil: (work: Promise<unknown>) => void;
  now?: () => number;
  newId?: () => string;
}

interface CheckBody {
  primitive: string;
  action: string;
  fields?: string[];
  session_id?: string;
  end_user_ref?: string;
  data?: unknown;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseCheckBody(raw: unknown): CheckBody | string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "body must be a JSON object";
  const b = raw as Record<string, unknown>;
  if (typeof b.primitive !== "string" || b.primitive.length > 200 || !PRIMITIVE.test(b.primitive)) {
    return "primitive must look like email.list_messages";
  }
  if (typeof b.action !== "string" || !ACTION.test(b.action)) return "action must be a lowercase word";
  if (b.fields !== undefined) {
    if (!Array.isArray(b.fields) || b.fields.length > 200) return "fields must be a list of up to 200 names";
    if (!b.fields.every((f) => typeof f === "string" && FIELD.test(f))) return "fields must be plain field names";
  }
  if (b.session_id !== undefined && (typeof b.session_id !== "string" || !UUID.test(b.session_id))) {
    return "session_id must be a UUID";
  }
  if (b.end_user_ref !== undefined) {
    if (typeof b.end_user_ref !== "string" || b.end_user_ref.length === 0 || b.end_user_ref.length > 256) {
      return "end_user_ref must be 1 to 256 characters";
    }
    if (b.end_user_ref.includes("@")) {
      return "end_user_ref must be your opaque user ID, never an email address";
    }
  }
  return b as unknown as CheckBody;
}

/** POST /v1/check: decide a call, shape any data for the agent, audit it. */
async function check(request: Request, deps: Deps): Promise<Response> {
  const now = deps.now ?? Date.now;
  const started = now();
  const requestId = (deps.newId ?? (() => crypto.randomUUID()))();

  const auth = request.headers.get("authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!key) return json(401, { error: "missing_key", request_id: requestId });

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json(413, { error: "body_too_large", request_id: requestId });
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return json(413, { error: "body_too_large", request_id: requestId });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json(400, { error: "invalid_request", detail: "body is not valid JSON", request_id: requestId });
  }
  const body = parseCheckBody(raw);
  if (typeof body === "string") return json(400, { error: "invalid_request", detail: body, request_id: requestId });

  const keyRecord = await deps.store.resolveKey(await sha256Hex(key));
  if (!keyRecord) return json(401, { error: "invalid_key", request_id: requestId });
  if (!keyRecord.scopes.includes(CHECK_SCOPE)) {
    return json(403, { error: "missing_scope", detail: CHECK_SCOPE, request_id: requestId });
  }

  const audit = (e: Omit<AuditEvent, "vendorId" | "requestId" | "sessionId" | "endUserRef" | "primitive" | "action" | "scopes" | "latencyMs">) =>
    deps.waitUntil(
      deps.store
        .recordCall(
          {
            vendorId: keyRecord.vendorId,
            requestId,
            sessionId: body.session_id,
            endUserRef: body.end_user_ref,
            primitive: body.primitive,
            action: body.action,
            scopes: keyRecord.scopes,
            latencyMs: Math.max(0, Math.round(now() - started)),
            ...e,
          },
          keyRecord.keyId,
        )
        .catch((err: unknown) =>
          console.error(JSON.stringify({ msg: "audit write failed", request_id: requestId, err: String(err) })),
        ),
    );

  const contract = await deps.store.loadContract(keyRecord.vendorId, body.primitive);
  if (contract.kind !== "found") {
    audit({ contractVersion: undefined, decision: "denied", reason: contract.kind, detail: body.primitive, redactedFields: [] });
    return contract.kind === "unknown_primitive"
      ? json(404, { error: "unknown_primitive", detail: body.primitive, request_id: requestId })
      : json(200, { request_id: requestId, decision: "denied", reason: "no_contract", detail: body.primitive });
  }

  const decision = evaluate(contract.rules, {
    action: body.action,
    scopes: keyRecord.scopes,
    ...(body.fields !== undefined ? { fields: body.fields } : {}),
  });

  if (decision.decision === "denied") {
    audit({
      contractVersion: contract.version,
      decision: "denied",
      reason: decision.reason,
      detail: decision.detail,
      redactedFields: [],
    });
    return json(200, {
      request_id: requestId,
      decision: "denied",
      reason: decision.reason,
      detail: decision.detail,
      contract_version: contract.version,
    });
  }

  audit({
    contractVersion: contract.version,
    decision: "allowed",
    reason: "allowed",
    detail: undefined,
    redactedFields: decision.redact,
  });
  return json(200, {
    request_id: requestId,
    decision: "allowed",
    contract_version: contract.version,
    allowed_fields: decision.allowedFields ?? null,
    redact: decision.redact,
    ...(body.data !== undefined ? { data: shape(body.data, decision) } : {}),
  });
}

export async function handle(request: Request, deps: Deps): Promise<Response> {
  const { pathname } = new URL(request.url);
  try {
    if (pathname === "/" || pathname === "/health") {
      return json(200, { service: "neuvex-gateway", ok: true });
    }
    if (pathname === "/v1/check") {
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
      return await check(request, deps);
    }
    return json(404, { error: "not_found" });
  } catch (err) {
    console.error(JSON.stringify({ msg: "unhandled error", path: pathname, err: String(err) }));
    return json(500, { error: "internal_error" });
  }
}
