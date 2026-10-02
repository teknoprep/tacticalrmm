// PI RELAY (2026-09-27). A real HTTP server + the real relay handler + pi's faux provider, with
// Django's credential check and the spend ledger injected. Checks what actually crosses the
// wire: auth, lockout, protocol, group+role routing, thinking cap, option whitelisting, NDJSON
// events (with the delta `partial` stripped) and the ledger row.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { makeRelay, parseBasic, clientIp, effectiveReasoning, wireEvent, RELAY_PROTOCOL } from "../src/relay.js";

const USER = "sean@blueuc.com";
const KEY = "pirk_ABCDEFGHIJKL_" + "x".repeat(48);
const coding = {
  id: 9, name: "Coding", slug: "coding", kind: "coding", description: "code work", auto_summarize_tokens: 100000,
  roles: [
    { role: "orchestrator", provider: "fauxrelay", model_id: "m1", display_name: "Faux One", thinking_level: "low", definition: "" },
    { role: "coder", provider: "fauxrelay", model_id: "m1", display_name: "Faux One", thinking_level: "high", definition: "write code" },
  ],
};
const it = {
  id: 2, name: "IT", slug: "it", kind: "it", description: "tickets", auto_summarize_tokens: 100000,
  roles: [
    { role: "orchestrator", provider: "fauxrelay", model_id: "m1", display_name: "Faux One", thinking_level: "medium", definition: "" },
    { role: "scout", provider: "fauxrelay", model_id: "m1", display_name: "Faux One", thinking_level: "low", definition: "look" },
  ],
};
const GROUPS = [coding, it];

async function setup({ verifyImpl, groups = GROUPS } = {}) {
  const core = createFauxCore({ api: "faux-relay", provider: "fauxrelay", models: [{ id: "m1", reasoning: true }] });
  const seen = [];
  const rt = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  rt.registerProvider("fauxrelay", {
    api: "faux-relay", apiKey: "server-side-key", baseUrl: "http://faux.invalid",
    streamSimple: (m, c, o) => { seen.push({ m, c, o }); return core.streamSimple(m, c, o); },
    models: [{ id: "m1", name: "Faux One", reasoning: true, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }],
  });
  const piRuntime = async () => ({ raw: rt, findModel: (p, id) => rt.getModel(p, id) });
  const ledgerRows = [];
  const verifyCalls = [];
  const verify = verifyImpl || (async (u, k, ip) => {
    verifyCalls.push({ u, k, ip });
    if (u === USER && k === KEY) {
      return { ok: true, user: { username: "sean", email: USER, display: "Sean" },
        key: { key_id: "ABCDEFGHIJKL", label: "laptop", expires_at: null, daily_budget_usd: null, monthly_budget_usd: null, spend: { today_usd: 0, month_usd: 0 } },
        groups, provider_keys: { fauxrelay: "server-side-key" } };
    }
    return { ok: false, status: 401, reason: "bad" };
  });
  const relay = makeRelay({ log: () => {}, piRuntime, verify, ledger: (row) => ledgerRows.push(row) });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (!(await relay.handle(req, res, url))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/pi/relay/v1`;
  return { core, seen, ledgerRows, verifyCalls, relay, server, base, close: () => new Promise((r) => server.close(r)) };
}

const auth = (u = USER, k = KEY) => ({ Authorization: "Basic " + Buffer.from(`${u}:${k}`).toString("base64") });
const ctx = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
const post = (base, body, headers = {}) =>
  fetch(`${base}/stream`, { method: "POST", headers: { ...auth(), "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
async function ndjson(res) { return (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l)); }

test("health is public; everything else needs Basic auth", async () => {
  const s = await setup();
  try {
    assert.equal((await fetch(`${s.base}/health`)).status, 200);
    const r = await fetch(`${s.base}/whoami`);
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") || "", /Basic/);
  } finally { await s.close(); }
});

test("bad credentials get one generic message, and an address is locked out after repeated failures", async () => {
  const s = await setup();
  try {
    const r = await fetch(`${s.base}/whoami`, { headers: auth(USER, KEY.slice(0, -1) + "y") });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error, "Invalid, expired or revoked relay credentials.");
    for (let i = 0; i < 25; i++) await fetch(`${s.base}/whoami`, { headers: auth("x", "y") });
    const locked = await fetch(`${s.base}/whoami`, { headers: auth() });   // even the RIGHT key, from that address
    assert.equal(locked.status, 429);
  } finally { await s.close(); }
});

test("whoami returns EVERY group the key reaches, with model metadata and no provider keys", async () => {
  const s = await setup();
  try {
    const r = await fetch(`${s.base}/whoami`, { headers: auth() });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.protocol, RELAY_PROTOCOL);
    assert.equal(body.protocol, 2);
    assert.deepEqual(body.groups.map((g) => g.slug), ["coding", "it"]);
    assert.equal(body.groups[0].roles[0].model.contextWindow, 100000);
    assert.equal(body.groups[0].roles[1].definition, "write code", "the specialist's instructions travel so delegate can use them");
    assert.ok(!JSON.stringify(body).includes("server-side-key"), "provider keys never leave the server");
  } finally { await s.close(); }
});

test("stream: routes by group + role, strips partial from text deltas, records spend", async () => {
  const s = await setup();
  s.core.setResponses([fauxAssistantMessage([fauxText("hello from the relay")])]);
  try {
    const r = await post(s.base, { protocol: 2, group: "it", role: "orchestrator", context: ctx,
      options: { reasoning: "high", apiKey: "EVIL", headers: { x: 1 }, baseUrl: "http://evil" } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /ndjson/);
    const evs = await ndjson(r);
    assert.equal(evs[0].type, "relay_start");
    assert.equal(evs[0].group, "it");
    assert.equal(evs[0].reasoning, "medium", "thinking capped at the group's role level, client asked high");
    const deltas = evs.filter((e) => e.type === "text_delta");
    assert.ok(deltas.length > 0 && deltas.every((d) => !("partial" in d)), "text deltas carry no partial");
    const done = evs.find((e) => e.type === "done");
    assert.equal(done.message.content[0].text, "hello from the relay");
    assert.equal(evs.at(-1).type, "relay_end");
    const o = s.seen[0].o;
    // The provider gets the SERVER's key (added by the runtime); nothing the client sent.
    assert.equal(o.apiKey, "server-side-key");
    assert.ok(!JSON.stringify(o).includes("EVIL") && !JSON.stringify(o).includes("http://evil"));
    assert.equal(o.reasoning, "medium");
    assert.match(o.sessionId, /^relay-ABCDEFGHIJKL-/);
    await new Promise((r2) => setTimeout(r2, 20));
    assert.equal(s.ledgerRows.length, 1);
    assert.equal(s.ledgerRows[0].surface, "relay");
    assert.equal(s.ledgerRows[0].role, "chat");
    assert.equal(s.ledgerRows[0].actor_username, "sean");
    assert.match(s.ledgerRows[0].session_id, /^relay-ABCDEFGHIJKL-[0-9a-f-]{36}$/);
  } finally { await s.close(); }
});

test("stream: tool calls come through intact, and a specialist runs at ITS group's level", async () => {
  const s = await setup();
  s.core.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" }), { stopReason: "toolUse" })]);
  try {
    const r = await post(s.base, { protocol: 2, group: "coding", role: "coder", context: ctx, options: {} });
    const evs = await ndjson(r);
    const done = evs.find((e) => e.type === "done");
    assert.equal(done.reason, "toolUse");
    assert.equal(done.message.content[0].name, "read");
    assert.deepEqual(done.message.content[0].arguments, { path: "a.ts" });
    assert.equal(evs[0].reasoning, "high", "coder role runs at its own level");
    await new Promise((r2) => setTimeout(r2, 20));
    assert.equal(s.ledgerRows[0].role, "coder");
  } finally { await s.close(); }
});

test("a group the key does not reach is refused, and the reason lists what it does reach", async () => {
  const s = await setup();
  try {
    const r = await post(s.base, { protocol: 2, group: "finance", role: "orchestrator", context: ctx });
    assert.equal(r.status, 404);
    assert.match((await r.json()).error, /does not reach the group 'finance'.*coding, it/);
  } finally { await s.close(); }
});

test("a key that reaches ONE group still works when the client omits `group`", async () => {
  const s = await setup({ groups: [coding] });
  s.core.setResponses([fauxAssistantMessage("only one group")]);
  try {
    const r = await post(s.base, { protocol: 2, role: "orchestrator", context: ctx });
    assert.equal(r.status, 200);
    const evs = await ndjson(r);
    assert.equal(evs[0].group, "coding");
  } finally { await s.close(); }
});

test("an old client (protocol 1) gets a clear 'update the extension' message", async () => {
  const s = await setup();
  try {
    const r = await post(s.base, { protocol: 1, role: "orchestrator", context: ctx });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /protocol mismatch: server speaks 2, client sent 1/i);
  } finally { await s.close(); }
});

test("unknown role and empty context are refused with a clear reason", async () => {
  const s = await setup();
  try {
    let r = await post(s.base, { protocol: 2, group: "it", role: "ceo", context: ctx });
    assert.equal(r.status, 404); assert.match((await r.json()).error, /no role 'ceo'/);
    r = await post(s.base, { protocol: 2, group: "it", role: "orchestrator", context: { messages: [] } });
    assert.equal(r.status, 400);
  } finally { await s.close(); }
});

test("budget refusals pass their message through (and are not rate-limit shaped)", async () => {
  const s = await setup({ verifyImpl: async () => ({ ok: false, status: 429, reason: "daily budget", message: "Daily budget of $5 for this key is used up (resets at midnight)." }) });
  try {
    const r = await fetch(`${s.base}/whoami`, { headers: auth() });
    assert.equal(r.status, 429);
    assert.match((await r.json()).error, /Daily budget of \$5/);
  } finally { await s.close(); }
});

test("verification is cached briefly per credential", async () => {
  const s = await setup();
  try {
    await fetch(`${s.base}/whoami`, { headers: auth() });
    await fetch(`${s.base}/whoami`, { headers: auth() });
    assert.equal(s.verifyCalls.length, 1);
  } finally { await s.close(); }
});

test("helpers: Basic parsing, trusted client IP, thinking cap, wire events", () => {
  assert.deepEqual(parseBasic("Basic " + Buffer.from("a@b.c:pirk_x").toString("base64")), { username: "a@b.c", key: "pirk_x" });
  assert.equal(parseBasic("Bearer abc"), null);
  assert.equal(parseBasic("Basic " + Buffer.from("nocolon").toString("base64")), null);
  assert.equal(clientIp({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-real-ip": "8.8.8.8" } }), "8.8.8.8");
  assert.equal(clientIp({ socket: { remoteAddress: "5.5.5.5" }, headers: { "x-real-ip": "8.8.8.8" } }), "5.5.5.5", "spoofed header from a non-proxy peer is ignored");
  const m = { reasoning: true };
  assert.equal(effectiveReasoning("max", "medium", m), "medium");
  assert.equal(effectiveReasoning("low", "high", m), "low");
  assert.equal(effectiveReasoning("off", "high", m), undefined);
  assert.equal(effectiveReasoning(undefined, "high", m), "high");
  assert.equal(effectiveReasoning("high", "high", { reasoning: false }), undefined);
  assert.ok(!("partial" in wireEvent({ type: "text_delta", delta: "a", partial: {} })));
  assert.ok("partial" in wireEvent({ type: "toolcall_delta", delta: "a", partial: {} }));
});
