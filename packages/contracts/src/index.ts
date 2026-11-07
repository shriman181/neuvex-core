/**
 * Neuvex contract engine: decides whether a call to a primitive is allowed, and
 * shapes the data that goes back to the agent. Pure functions, no I/O, so the same
 * code runs in the gateway, in tests and in a vendor's own SDK.
 */

/**
 * What a contract allows. Anything not in `allow` is denied, `deny` always wins over
 * `allow`, and `redact` names fields that are masked before data reaches an agent.
 */
export interface ContractRules {
  allow: {
    /** Actions the primitive may perform, for example "read" or "update". */
    actions: string[];
    /** Top-level fields an agent may request or receive. Omit to allow any. */
    fields?: string[];
    /** Scopes the caller's key must hold, all of them. */
    scopes?: string[];
  };
  deny?: {
    actions?: string[];
    fields?: string[];
  };
  /** Dotted paths masked in returned data, for example "from.address". */
  redact?: string[];
  /** Calls per minute per end user. Recorded now, enforced in a later phase. */
  rateLimit?: number;
}

export interface CheckRequest {
  action: string;
  /** Top-level fields the caller wants. Omit to ask for everything the contract allows. */
  fields?: string[];
  /** Scopes held by the calling key. */
  scopes?: string[];
}

export type DenyReason =
  | "action_denied"
  | "action_not_allowed"
  | "field_denied"
  | "field_not_allowed"
  | "missing_scope";

export type Decision =
  | {
      decision: "allowed";
      reason: "allowed";
      /** Fields the response may contain. Undefined means no field restriction. */
      allowedFields: string[] | undefined;
      /** Fields always removed from the response. */
      deniedFields: string[];
      redact: string[];
    }
  | {
      decision: "denied";
      reason: DenyReason;
      /** The action, field or scope that caused the denial. */
      detail: string;
    };

export const REDACTED = "[redacted]";

/** Decide one call. Deny rules are checked first, then allow rules, then scopes. */
export function evaluate(rules: ContractRules, request: CheckRequest): Decision {
  const { action } = request;
  const fields = request.fields ?? [];

  if (rules.deny?.actions?.includes(action)) {
    return { decision: "denied", reason: "action_denied", detail: action };
  }
  if (!rules.allow.actions.includes(action)) {
    return { decision: "denied", reason: "action_not_allowed", detail: action };
  }

  const deniedField = fields.find((f) => rules.deny?.fields?.includes(f));
  if (deniedField !== undefined) {
    return { decision: "denied", reason: "field_denied", detail: deniedField };
  }

  const allowList = rules.allow.fields;
  if (allowList) {
    const outside = fields.find((f) => !allowList.includes(f));
    if (outside !== undefined) {
      return { decision: "denied", reason: "field_not_allowed", detail: outside };
    }
  }

  const held = new Set(request.scopes ?? []);
  const missing = (rules.allow.scopes ?? []).find((s) => !held.has(s));
  if (missing !== undefined) {
    return { decision: "denied", reason: "missing_scope", detail: missing };
  }

  // Requested fields narrow the allow list; never widen it. Denied fields are
  // removed even when the caller asked for everything.
  const base = fields.length > 0 ? fields : allowList;
  const allowedFields = base?.filter((f) => !rules.deny?.fields?.includes(f));

  return {
    decision: "allowed",
    reason: "allowed",
    allowedFields,
    deniedFields: [...(rules.deny?.fields ?? [])],
    redact: [...(rules.redact ?? [])],
  };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Apply an allowed decision to data on its way to an agent: keep only allowed
 * top-level fields, drop denied ones, and mask redacted paths. Arrays are handled
 * element by element, so a list of messages is shaped message by message.
 * The input is never modified.
 */
export function shape(data: unknown, decision: Extract<Decision, { decision: "allowed" }>): Json {
  const copy = structuredClone(data) as Json;
  const picked = pickFields(copy, decision.allowedFields, decision.deniedFields);
  for (const path of decision.redact) redactPath(picked, path.split("."));
  return picked;
}

function pickFields(value: Json, allowed: string[] | undefined, denied: string[]): Json {
  if (Array.isArray(value)) return value.map((v) => pickFields(v, allowed, denied));
  if (value === null || typeof value !== "object") return value;
  const out: { [key: string]: Json } = {};
  for (const [key, v] of Object.entries(value)) {
    if (denied.includes(key)) continue;
    if (allowed && !allowed.includes(key)) continue;
    out[key] = v;
  }
  return out;
}

function redactPath(value: Json, path: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) redactPath(item, path);
    return;
  }
  if (value === null || typeof value !== "object" || path.length === 0) return;
  const [head, ...rest] = path as [string, ...string[]];
  if (!(head in value)) return;
  if (rest.length === 0) {
    value[head] = REDACTED;
  } else {
    redactPath(value[head] as Json, rest);
  }
}

/** Basic shape check for rules read from the database or written by a vendor. */
export function isContractRules(value: unknown): value is ContractRules {
  if (value === null || typeof value !== "object") return false;
  const allow = (value as { allow?: unknown }).allow;
  if (allow === null || typeof allow !== "object") return false;
  const actions = (allow as { actions?: unknown }).actions;
  return Array.isArray(actions) && actions.every((a) => typeof a === "string");
}
