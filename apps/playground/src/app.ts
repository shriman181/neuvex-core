// The Neuvex Playground's server side. The page in ./public plays an AI agent for
// Inboxly, a demo vendor. Its requests come here, and this Worker passes them to the
// real gateway through a Cloudflare service binding (no public hop), using a demo key
// that never reaches the browser. The gateway then reads contracts from Neon and writes
// every decision to the audit log in Neon.

/** What this Worker uses of a service or assets binding. */
export interface FetcherLike {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

/** What this Worker uses of the rate-limiting binding. */
export interface RateLimiterLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** Service binding to the neuvex-gateway Worker. */
  GATEWAY: FetcherLike;
  /** Static assets (the page). */
  ASSETS: FetcherLike;
  /** Per-visitor limit, so public traffic can't run up Neon compute. */
  LIMITER?: RateLimiterLike;
  /** Key for the demo vendor: scopes gateway:check, contracts:read, audit:read. */
  PLAYGROUND_KEY: string;
}

const MAX_BODY_BYTES = 64 * 1024;
// Fixed and opaque: what visitors type never becomes an end-user reference in the log.
const END_USER_REF = "playground_visitor";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

async function overLimit(request: Request, env: Env): Promise<boolean> {
  if (!env.LIMITER) return false;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.LIMITER.limit({ key: ip });
  return !success;
}

/** Calls the gateway and passes its answer through, with timing headers. */
async function toGateway(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const started = Date.now();
  const res = await env.GATEWAY.fetch(`https://neuvex-gateway${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      authorization: `Bearer ${env.PLAYGROUND_KEY}`,
    },
  });
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-gateway-ms": String(Date.now() - started),
  };
  const timing = res.headers.get("server-timing");
  if (timing) headers["server-timing"] = timing;
  return new Response(await res.text(), { status: res.status, headers });
}

/** Keeps only what an agent would send; the rest of the request is the gateway's call. */
function agentRequest(raw: unknown): Record<string, unknown> | string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "The request must be a JSON object.";
  const b = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { end_user_ref: END_USER_REF };
  for (const key of ["primitive", "action", "fields", "data"] as const) {
    if (b[key] !== undefined) out[key] = b[key];
  }
  return out;
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

  try {
    if (await overLimit(request, env)) {
      return json(429, { error: "rate_limited", detail: "Slow down: the playground allows 30 requests a minute." });
    }

    if (url.pathname === "/api/check") {
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
        return json(413, { error: "body_too_large", detail: "Keep playground requests under 64 KB." });
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return json(400, { error: "invalid_request", detail: "The request is not valid JSON." });
      }
      const body = agentRequest(raw);
      if (typeof body === "string") return json(400, { error: "invalid_request", detail: body });
      return await toGateway(env, "/v1/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    if (url.pathname === "/api/contracts" && request.method === "GET") {
      return await toGateway(env, "/v1/contracts");
    }

    if (url.pathname === "/api/audit" && request.method === "GET") {
      return await toGateway(env, "/v1/audit/summary?recent=10");
    }

    return json(404, { error: "not_found" });
  } catch (err) {
    console.error(JSON.stringify({ msg: "playground error", path: url.pathname, err: String(err) }));
    return json(502, { error: "gateway_unreachable" });
  }
}
