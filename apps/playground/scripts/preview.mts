// Local preview of the Playground, no Neon or Cloudflare needed:
//   npm run preview -w @neuvex/playground   →  http://localhost:8790
// Serves the page, runs the real Playground and gateway code, and every migration on
// in-memory Postgres seeded with the Inboxly demo vendor.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { createTestDatabase } from "@neuvex/db/testing";
import { pgliteDb } from "@neuvex/sql/testing";
import { handle as gatewayHandle, sha256Hex } from "../../gateway/src/app.ts";
import { createStore } from "../../gateway/src/store.ts";
import { handle as playgroundHandle } from "../src/app.ts";

const KEY = "nvx_play_local_preview";
const pg = await createTestDatabase();
await pg.exec(`
WITH v AS (INSERT INTO control.vendors (slug, name) VALUES ('inboxly-demo', 'Inboxly (demo)') RETURNING id),
p AS (INSERT INTO control.primitives (vendor_id, name, description)
  SELECT v.id, x.n, x.d FROM v, (VALUES ('email.list_messages','List messages in a folder, newest first.'),('email.get_message','Read one message, including its body.'),('email.update_labels','Add or remove labels on a message. Cannot send, move or delete.')) x(n,d) RETURNING id, vendor_id, name)
INSERT INTO control.contract_versions (vendor_id, primitive_id, version, rules)
SELECT p.vendor_id, p.id, 1, r.rules::jsonb FROM p JOIN (VALUES
 ('email.list_messages','{"allow":{"actions":["read"],"fields":["id","from","subject","received_at","labels"]},"redact":["from.address"],"rateLimit":120}'),
 ('email.get_message','{"allow":{"actions":["read"],"fields":["id","from","subject","body","received_at"]},"deny":{"fields":["headers"]},"redact":["from.address"],"rateLimit":60}'),
 ('email.update_labels','{"allow":{"actions":["update"],"fields":["labels"]},"deny":{"actions":["send","delete","move"]},"rateLimit":30}')) r(n, rules) ON r.n = p.name;`);
const { rows } = await pg.query<{ id: string }>("SELECT id FROM control.vendors WHERE slug = 'inboxly-demo'");
const vid = rows[0]!.id;
await pg.query("INSERT INTO control.vendor_keys (vendor_id, key_prefix, key_hash, scopes) VALUES ($1, 'nvx_play_loc', $2, '{gateway:check,contracts:read,audit:read}')", [vid, await sha256Hex(KEY)]);
// A few decisions yesterday and a checkpoint, like a day of real traffic.
for (const [d, r] of [["allowed","allowed"],["denied","action_denied"],["allowed","allowed"],["denied","field_denied"]]) {
  await pg.query(`INSERT INTO audit.events (vendor_id, ts, request_id, primitive, action, decision, reason, contract_version) VALUES ($1, now() - interval '1 day', gen_random_uuid(), 'email.list_messages', 'read', $2, $3, 1)`, [vid, d, r]);
}
await pg.query("SELECT audit.write_checkpoints((now() AT TIME ZONE 'UTC')::date - 1)");

const store = createStore(pgliteDb(pg, "neuvex_gateway"));
const env = {
  PLAYGROUND_KEY: KEY,
  ASSETS: { fetch: async () => new Response("unused") },
  GATEWAY: { fetch: (input: string | Request, init?: RequestInit) => gatewayHandle(new Request(input, init), { store, waitUntil: (p) => void p }) },
};
const types: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2" };
http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost:8790");
  if (url.pathname.startsWith("/api/")) {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const r = await playgroundHandle(new Request(url, { method: req.method, headers: req.headers as Record<string, string>, ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}) }), env as never);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text()); return;
  }
  const file = url.pathname === "/" ? "/index.html" : url.pathname;
  try { const data = await readFile(join(import.meta.dirname, "../public", file)); res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }); res.end(data); }
  catch { res.writeHead(404); res.end(); }
}).listen(8790, () => console.log("preview ready"));
