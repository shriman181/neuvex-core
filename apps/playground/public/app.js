// Neuvex Playground: plays an AI agent for Inboxly, a demo vendor on Neuvex.
// Every request goes to the real gateway, which reads contracts from Neon Postgres
// and writes each decision to the audit log in Neon.
"use strict";

const SAMPLE_INBOX = [
  {
    id: "msg_1042",
    from: { name: "Priya Nair", address: "priya@northwind.example" },
    subject: "Q4 budget review",
    received_at: "2026-11-25T09:14:00Z",
    labels: ["finance"],
    body: "Hi team, the draft budget is attached. Numbers are confidential until Friday.",
    thread_token: "tt_9f2c41d7",
  },
  {
    id: "msg_1043",
    from: { name: "Lucas Martin", address: "lucas@contoso.example" },
    subject: "Lunch on Friday?",
    received_at: "2026-11-25T11:02:00Z",
    labels: [],
    body: "Are you free on Friday? The new place near the office.",
    thread_token: "tt_1a7b88e0",
  },
];

const SCENARIOS = [
  {
    title: "Read the inbox",
    say: "List messages. The body and internal token stay hidden; sender addresses are redacted.",
    expect: "allowed",
    request: { primitive: "email.list_messages", action: "read", data: SAMPLE_INBOX },
  },
  {
    title: "Open one message",
    say: "Read a full message. The body is allowed here, but raw headers are not.",
    expect: "allowed",
    request: {
      primitive: "email.get_message",
      action: "read",
      data: {
        id: "msg_1042",
        from: { name: "Priya Nair", address: "priya@northwind.example" },
        subject: "Q4 budget review",
        body: "Hi team, the draft budget is attached. Numbers are confidential until Friday.",
        received_at: "2026-11-25T09:14:00Z",
        headers: { "Received": "from mx1.northwind.example", "DKIM-Signature": "v=1; a=rsa-sha256; d=northwind.example" },
      },
    },
  },
  {
    title: "Ask for raw headers",
    say: "Request the headers field directly. The contract denies it.",
    expect: "denied",
    request: { primitive: "email.get_message", action: "read", fields: ["id", "headers"] },
  },
  {
    title: "Label a message",
    say: "Change labels, the one thing this primitive allows.",
    expect: "allowed",
    request: { primitive: "email.update_labels", action: "update", fields: ["labels"] },
  },
  {
    title: "Delete a message",
    say: "Try to delete mail. The contract forbids it outright.",
    expect: "denied",
    request: { primitive: "email.update_labels", action: "delete" },
  },
  {
    title: "Send mail as the user",
    say: "Try to send on the user's behalf. Also forbidden.",
    expect: "denied",
    request: { primitive: "email.update_labels", action: "send" },
  },
  {
    title: "Use an unpublished primitive",
    say: "Call something Inboxly never published.",
    expect: "denied",
    request: { primitive: "calendar.create_event", action: "create" },
  },
];

const REASONS = {
  action_denied: "The contract forbids this action outright.",
  action_not_allowed: "This action is not on the contract's allow list.",
  field_denied: "You asked for a field the contract forbids.",
  field_not_allowed: "You asked for a field outside the contract's allow list.",
  missing_scope: "The key lacks a scope the contract requires.",
  no_contract: "This primitive has no published contract yet.",
  unknown_primitive: "Inboxly hasn't published this primitive, so the gateway refuses it.",
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let contracts = new Map();
let selected = 0;
let lastRequestId = null;

/* ---------- scenarios ---------- */

function renderScenarios() {
  $("scenario-list").innerHTML = SCENARIOS.map((s, i) => `
    <li><button class="scenario" type="button" data-i="${i}" aria-pressed="${i === selected}">
      <b>${esc(s.title)}<span class="expect ${s.expect === "allowed" ? "ok" : "no"}">${s.expect === "allowed" ? "allowed" : "denied"}</span></b>
      <span>${esc(s.say)}</span>
      <code>${esc(s.request.primitive)} · ${esc(s.request.action)}</code>
    </button></li>`).join("");
  for (const b of document.querySelectorAll(".scenario")) {
    b.addEventListener("click", () => select(Number(b.dataset.i), true));
  }
}

function select(i, run) {
  selected = i;
  for (const b of document.querySelectorAll(".scenario")) b.setAttribute("aria-pressed", String(Number(b.dataset.i) === i));
  $("request").value = JSON.stringify(SCENARIOS[i].request, null, 2);
  showContract(SCENARIOS[i].request.primitive);
  if (run) send();
}

/* ---------- contract panel ---------- */

function showContract(primitive) {
  const c = contracts.get(primitive);
  $("contract-name").textContent = primitive || "";
  if (!contracts.size) return;
  if (!c) {
    $("contract").textContent = "No contract: Inboxly hasn't published this primitive.";
  } else if (!c.rules) {
    $("contract").textContent = "Published, but no contract version yet.";
  } else {
    $("contract").textContent = `// version ${c.version}\n` + JSON.stringify(c.rules, null, 2);
  }
}

async function loadContracts() {
  try {
    const res = await fetch("/api/contracts");
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    contracts = new Map(body.contracts.map((c) => [c.primitive, c]));
    showContract(currentPrimitive());
  } catch {
    $("contract").textContent = "Couldn't load contracts from Neon right now.";
  }
}

function currentPrimitive() {
  try { return JSON.parse($("request").value).primitive; } catch { return SCENARIOS[selected].request.primitive; }
}

/* ---------- sending ---------- */

function parseTiming(header) {
  const out = {};
  for (const part of (header || "").split(",")) {
    const [name, ...params] = part.trim().split(";");
    const dur = params.find((p) => p.trim().startsWith("dur="));
    if (name && dur) out[name.trim()] = Number(dur.split("=")[1]);
  }
  return out;
}

async function send() {
  let request;
  try {
    request = JSON.parse($("request").value);
  } catch {
    setStatus("That isn't valid JSON yet.", true);
    return;
  }
  showContract(request.primitive);
  $("send").disabled = true;
  setStatus("Asking the gateway…");
  const started = performance.now();
  try {
    const res = await fetch("/api/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    const roundTrip = performance.now() - started;
    const body = await res.json().catch(() => ({}));
    if (res.status === 429) { setStatus(body.detail || "Slow down a little.", true); return; }
    if (res.status >= 500) { setStatus("The gateway couldn't be reached. Try again in a moment.", true); setLive(false); return; }
    setLive(true);
    setStatus("");
    renderResult(request, res.status, body, parseTiming(res.headers.get("server-timing")), roundTrip);
    lastRequestId = body.request_id || null;
    setTimeout(loadAudit, 1200); // the audit row is written just after the answer
  } catch {
    setStatus("Network error. Try again.", true);
  } finally {
    $("send").disabled = false;
  }
}

function setStatus(text, err) {
  $("status").textContent = text;
  $("status").className = "status" + (err ? " err" : "");
}

function setLive(up) {
  $("live").classList.toggle("down", !up);
  $("live").lastChild.textContent = up ? " Live on Neon" : " Gateway unreachable";
}

/* ---------- result ---------- */

function renderResult(request, status, body, timing, roundTrip) {
  $("result").hidden = false;
  const allowed = body.decision === "allowed";
  const reason = status === 404 ? "unknown_primitive" : body.reason || body.error;
  const changes = allowed && request.data !== undefined ? countChanges(request.data, body.data) : null;

  $("decision").className = "decision " + (allowed ? "allowed" : "denied");
  $("decision").innerHTML = allowed
    ? `<div class="verdict">Allowed under contract v${esc(body.contract_version)}</div>
       <p>${changes ? `${changes.removed} field${changes.removed === 1 ? "" : "s"} removed and ${changes.redacted} value${changes.redacted === 1 ? "" : "s"} redacted before the agent saw the data.` : `Allowed fields: ${esc((body.allowed_fields || []).join(", ") || "all")}.`}</p>`
    : `<div class="verdict">Denied · <span class="mono">${esc(reason)}</span></div>
       <p>${esc(REASONS[reason] || "The gateway refused this request.")}${body.detail ? ` <span class="mono">(${esc(body.detail)})</span>` : ""}</p>`;

  const items = [];
  if (timing.neon !== undefined) items.push(`<li class="neon">Neon queries <b>${timing.neon.toFixed(0)} ms</b></li>`);
  if (timing.total !== undefined) items.push(`<li>Gateway total <b>${timing.total.toFixed(0)} ms</b></li>`);
  items.push(`<li>Round trip from you <b>${roundTrip.toFixed(0)} ms</b></li>`);
  if (body.request_id) items.push(`<li>Audit row <b class="mono">${esc(body.request_id.slice(0, 8))}…</b> written to Neon</li>`);
  $("timings").innerHTML = items.join("");

  if (request.data !== undefined && allowed) {
    $("compare").hidden = false;
    $("sent").innerHTML = annotate(request.data, body.data, 0);
    $("got").innerHTML = highlight(body.data, 0);
    document.querySelector(".legend").hidden = false;
  } else {
    $("compare").hidden = true;
    document.querySelector(".legend").hidden = true;
  }
  $("raw").textContent = JSON.stringify(body, null, 2);
}

function countChanges(sent, got) {
  let removed = 0, redacted = 0;
  const walk = (s, g) => {
    if (Array.isArray(s)) { s.forEach((v, i) => walk(v, Array.isArray(g) ? g[i] : undefined)); return; }
    if (s && typeof s === "object") {
      for (const k of Object.keys(s)) {
        if (!g || typeof g !== "object" || !(k in g)) removed++;
        else if (g[k] === "[redacted]" && s[k] !== "[redacted]") redacted++;
        else walk(s[k], g[k]);
      }
    }
  };
  walk(sent, got);
  return { removed, redacted };
}

const pad = (n) => "  ".repeat(n);

/** The sent data, with what the contract removed struck and what it redacted marked. */
function annotate(sent, got, depth) {
  if (Array.isArray(sent)) {
    if (!sent.length) return "[]";
    const lines = sent.map((v, i) => pad(depth + 1) + annotate(v, Array.isArray(got) ? got[i] : undefined, depth + 1));
    return "[\n" + lines.join(",\n") + "\n" + pad(depth) + "]";
  }
  if (sent && typeof sent === "object") {
    const keys = Object.keys(sent);
    if (!keys.length) return "{}";
    const lines = keys.map((k) => {
      const keyText = esc(JSON.stringify(k));
      const kept = got && typeof got === "object" && k in got;
      if (!kept) return pad(depth + 1) + `<span class="removed-key">${keyText}: ${esc(compact(sent[k]))}</span>`;
      if (got[k] === "[redacted]" && sent[k] !== "[redacted]") {
        return pad(depth + 1) + `${keyText}: <span class="redacted-val">${esc(JSON.stringify(sent[k]))}</span>`;
      }
      return pad(depth + 1) + `${keyText}: ${annotate(sent[k], got[k], depth + 1)}`;
    });
    return "{\n" + lines.join(",\n") + "\n" + pad(depth) + "}";
  }
  return esc(JSON.stringify(sent));
}

/** The returned data, with redacted values marked. */
function highlight(value, depth) {
  if (value === undefined) return "";
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return "[\n" + value.map((v) => pad(depth + 1) + highlight(v, depth + 1)).join(",\n") + "\n" + pad(depth) + "]";
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) return "{}";
    return "{\n" + keys.map((k) => pad(depth + 1) + esc(JSON.stringify(k)) + ": " + highlight(value[k], depth + 1)).join(",\n") + "\n" + pad(depth) + "}";
  }
  if (value === "[redacted]") return `<span class="redacted-val">"[redacted]"</span>`;
  return esc(JSON.stringify(value));
}

function compact(v) {
  const s = JSON.stringify(v);
  return s.length > 48 ? s.slice(0, 45) + "…" : s;
}

/* ---------- audit panel ---------- */

async function loadAudit() {
  try {
    const res = await fetch("/api/audit");
    if (!res.ok) throw new Error(String(res.status));
    const a = await res.json();
    setLive(true);
    $("c-allowed").textContent = a.today.allowed;
    $("c-denied").textContent = a.today.denied;
    $("c-total").textContent = a.total;
    $("pg-version").textContent = a.storage.postgres ? a.storage.postgres.split(" ")[0] : "";
    $("partition").textContent = a.storage.partition;

    $("recent").innerHTML = a.recent.length
      ? a.recent.map((e) => `
        <li${lastRequestId && e.ts && isRecent(e.ts) ? ' class="flash"' : ""}>
          <span class="when">${esc(timeOf(e.ts))}</span>
          <span class="what" title="${esc(e.primitive)} · ${esc(e.action)} · ${esc(e.reason)}">${esc(e.primitive)} · ${esc(e.action)}</span>
          <span class="pill ${e.decision === "allowed" ? "allowed" : "denied"}">${e.decision === "allowed" ? "allowed" : esc(e.reason)}</span>
        </li>`).join("")
      : `<li class="empty">No decisions yet today. Send one.</li>`;

    $("checkpoints").innerHTML = a.checkpoints.length
      ? a.checkpoints.map((c) => `
        <li>
          <span class="when">${esc(c.day)}</span>
          <span class="what mono">${esc(c.events)} events · ${esc(c.hash)}…</span>
          <span class="pill ${c.verified === false ? "broken" : "verified"}">${c.verified === false ? "mismatch" : "verified"}</span>
        </li>`).join("")
      : `<li class="empty">The first checkpoint is written after a full day of events.</li>`;
  } catch {
    $("recent").innerHTML = `<li class="empty">Couldn't reach Neon just now.</li>`;
  }
}

function timeOf(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

function isRecent(ts) {
  return Date.now() - new Date(ts).getTime() < 15000;
}

/* ---------- start ---------- */

renderScenarios();
select(0, false);
$("send").addEventListener("click", send);
$("refresh").addEventListener("click", loadAudit);
$("request").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
});
loadContracts();
loadAudit();
