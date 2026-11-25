import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/app.js";

// The playground's server side, with a fake gateway and a fake rate limiter.

function setup(opts: { limited?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
  const env: Env = {
    PLAYGROUND_KEY: "nvx_play_secret",
    ASSETS: { fetch: async () => new Response("<html>playground</html>", { headers: { "content-type": "text/html" } }) },
    GATEWAY: {
      async fetch(input, init) {
        const url = typeof input === "string" ? input : input.url;
        const headers = new Headers(init?.headers);
        calls.push({
          url,
          method: init?.method ?? "GET",
          auth: headers.get("authorization"),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(JSON.stringify({ decision: "allowed", from: url }), {
          status: 200,
          headers: { "server-timing": 'neon;dur=12.5;desc="Neon Postgres", total;dur=20.0' },
        });
      },
    },
    LIMITER: { limit: async () => ({ success: !opts.limited }) },
  };
  const req = (path: string, init?: RequestInit) =>
    handle(new Request(`https://playground.test${path}`, init), env);
  return { env, calls, req };
}

describe("playground", () => {
  it("serves the page from static assets", async () => {
    const { req, calls } = setup();
    const res = await req("/");
    expect(await res.text()).toContain("playground");
    expect(calls).toHaveLength(0);
  });

  it("forwards a check to the gateway with the server-side key, passing Neon timing through", async () => {
    const { req, calls } = setup();
    const res = await req("/api/check", {
      method: "POST",
      body: JSON.stringify({ primitive: "email.list_messages", action: "read", data: [{ id: "m1" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("server-timing")).toContain("neon;dur=12.5");
    expect(res.headers.get("x-gateway-ms")).toMatch(/^\d+$/);
    expect(calls[0]).toMatchObject({
      url: "https://neuvex-gateway/v1/check",
      method: "POST",
      auth: "Bearer nvx_play_secret",
    });
  });

  it("sends only what an agent would send, under a fixed end-user reference", async () => {
    const { req, calls } = setup();
    await req("/api/check", {
      method: "POST",
      body: JSON.stringify({
        primitive: "email.get_message",
        action: "read",
        fields: ["id"],
        end_user_ref: "someone typed this",
        session_id: "x",
        extra: true,
      }),
    });
    expect(calls[0]?.body).toEqual({
      primitive: "email.get_message",
      action: "read",
      fields: ["id"],
      end_user_ref: "playground_visitor",
    });
  });

  it("never returns the key", async () => {
    const { req } = setup();
    const res = await req("/api/contracts");
    expect(await res.text()).not.toContain("nvx_play_secret");
  });

  it("reads contracts and the audit summary through the gateway", async () => {
    const { req, calls } = setup();
    await req("/api/contracts");
    await req("/api/audit");
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", "https://neuvex-gateway/v1/contracts"],
      ["GET", "https://neuvex-gateway/v1/audit/summary?recent=10"],
    ]);
  });

  it("rate-limits each visitor", async () => {
    const { req, calls } = setup({ limited: true });
    const res = await req("/api/check", { method: "POST", body: "{}" });
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(0);
  });

  it("rejects bad requests before they reach the gateway", async () => {
    const { req, calls } = setup();
    expect((await req("/api/check", { method: "POST", body: "not json" })).status).toBe(400);
    expect((await req("/api/check", { method: "POST", body: "[1,2]" })).status).toBe(400);
    expect((await req("/api/check", { method: "POST", body: JSON.stringify({ data: "x".repeat(70_000) }) })).status).toBe(413);
    expect((await req("/api/check")).status).toBe(405);
    expect((await req("/api/nothing")).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("answers 502 when the gateway can't be reached", async () => {
    const { env } = setup();
    env.GATEWAY = { fetch: async () => { throw new Error("down"); } };
    const res = await handle(new Request("https://playground.test/api/contracts"), env);
    expect(res.status).toBe(502);
  });
});
