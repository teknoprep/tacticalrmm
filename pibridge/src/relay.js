// PI RELAY (owner, 2026-09-27) - see docs/PI-RELAY.md.
//
// Lets a pi running ANYWHERE (a laptop, another server) use one RMM agent group through
// this bridge: the RMM's provider keys, its group config and its spend ledger. The client
// is a pi extension (relay-client/index.ts) that registers a provider "rmm" whose
// streamSimple() POSTs pi's own request (transcript + options) here; the bridge runs it
// with ITS pi runtime and streams pi's own events back as NDJSON. pi on both ends means
// nothing is translated - provider quirks (DeepSeek reasoning round-trip, Anthropic
// caching, thinking levels) behave exactly as in the RMM's own chats.
//
// PUBLIC through nginx at https://api.blueuc.com/pi/relay/v1/ (every other /pi/ path stays
// localhost-only). Auth: HTTP Basic = RMM username (or email) + AIRelayKey. Credentials are
// checked by Django (POST /core/ai/relay/verify/, guarded by the bridge's TRMM API key AND
// PI_RELAY_INTERNAL_SECRET) and cached for 30s, so a revoked key / disabled user / spent
// budget stops working within 30 seconds.
//
// Defences here: generic 401s (no oracle), per-IP failure lockout, per-key concurrency cap,
// body size cap, no client control over api keys / headers / base URLs, thinking level
// capped at the group's setting, every call on the spend ledger as surface "relay".
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import { makeCostMeter } from "./cost-meter.js";
import { ledgerSink } from "./spend-ledger.js";

// 2 (2026-09-27): one key can reach SEVERAL groups. whoami returns `groups: [...]` (was
// `group: {...}`) and /stream takes `group` (the slug) alongside `role`.
export const RELAY_PROTOCOL = 2;
const PREFIX = "/pi/relay/v1";
const MAX_BODY = Number(process.env.PI_RELAY_MAX_BODY || 32 * 1024 * 1024);
const CACHE_MS = 30_000;
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_LIMIT = 20;
const MAX_CONCURRENT_PER_KEY = Number(process.env.PI_RELAY_MAX_CONCURRENT || 6);
const HEARTBEAT_MS = 15_000;
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const CLIENT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "relay-client");


// ------------------------------------------------------------------ small helpers
function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders });
  res.end(JSON.stringify(body));
}

export function clientIp(req) {
  const peer = String(req.socket?.remoteAddress || "");
  const local = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  // Only trust the proxy's header when the connection really came from the local proxy.
  if (local) {
    const real = String(req.headers["x-real-ip"] || "").trim();
    if (real) return real;
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (fwd) return fwd;
  }
  return peer.replace(/^::ffff:/, "");
}

export function parseBasic(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(String(header || ""));
  if (!m) return null;
  let raw = "";
  try { raw = Buffer.from(m[1], "base64").toString("utf8"); } catch { return null; }
  const i = raw.indexOf(":");
  if (i <= 0) return null;
  const username = raw.slice(0, i).trim();
  const key = raw.slice(i + 1).trim();
  if (!username || !key || username.length > 254 || key.length > 200) return null;
  return { username, key };
}

export function effectiveReasoning(requested, roleLevel, model) {
  if (!model?.reasoning) return undefined;
  const cap = LEVELS.indexOf(String(roleLevel || "medium"));
  const want = requested == null ? cap : LEVELS.indexOf(String(requested));
  const idx = want < 0 ? cap : Math.min(want, cap < 0 ? LEVELS.length - 1 : cap);
  const level = LEVELS[Math.max(0, idx)];
  return level === "off" ? undefined : level;
}

// Strip the delta events' `partial` (the whole answer-so-far) for the two high-volume event
// types; the client rebuilds it. Everything else goes as pi produced it.
export function wireEvent(ev) {
  if (ev && (ev.type === "text_delta" || ev.type === "thinking_delta")) {
    const { partial, ...rest } = ev;
    return rest;
  }
  return ev;
}

async function readBody(req, limit) {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ------------------------------------------------------------------ verification
async function djangoVerify(username, key, ip, client = "") {
  const secret = process.env.PI_RELAY_INTERNAL_SECRET || "";
  if (!secret) return { ok: false, status: 503, reason: "PI_RELAY_INTERNAL_SECRET not set", message: "Relay is not configured on the server." };
  const res = await fetch(`${CONFIG.trmmApiUrl}/core/ai/relay/verify/`, {
    method: "POST",
    headers: { "X-API-KEY": CONFIG.trmmApiKey, "X-Relay-Internal": secret, "Content-Type": "application/json" },
    // client: the X-Relay-Client header ("rmm-relay/1.2.1"), kept with the key's usage history.
    body: JSON.stringify({ username, key, ip, client }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { ok: false, status: 503, reason: `verify HTTP ${res.status}`, message: "Relay authentication service unavailable." };
  return await res.json();
}

export function makeRelay({ log = () => {}, piRuntime, verify = djangoVerify, ledger = null } = {}) {
  const sink = ledger || ledgerSink(log);
  // Per-instance state (one relay per bridge process).
  const verifyCache = new Map();   // sha256(user\0key\0ip) -> { at, result }
  const failures = new Map();      // ip -> [timestamps]
  const inFlight = new Map();      // key_id -> count
  const runtimes = new Map();      // sha256(provider keys) -> { at, rt }
  function locked(ip) {
    const now = Date.now();
    const list = (failures.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
    if (list.length) failures.set(ip, list); else failures.delete(ip);
    return list.length >= FAIL_LIMIT;
  }
  function recordFailure(ip) {
    const list = failures.get(ip) || [];
    list.push(Date.now());
    failures.set(ip, list.slice(-FAIL_LIMIT * 2));
  }
  async function authenticate(req, res) {
    const ip = clientIp(req);
    if (locked(ip)) {
      json(res, 429, { error: "Too many failed sign-ins from this address. Try again in 15 minutes." });
      return null;
    }
    const cred = parseBasic(req.headers.authorization);
    if (!cred) {
      recordFailure(ip);
      json(res, 401, { error: "Relay credentials required (username + relay key)." }, { "WWW-Authenticate": 'Basic realm="pi-relay"' });
      return null;
    }
    const ck = crypto.createHash("sha256").update(`${cred.username.toLowerCase()}\0${cred.key}\0${ip}`).digest("hex");
    const hit = verifyCache.get(ck);
    let result = hit && Date.now() - hit.at < CACHE_MS ? hit.result : null;
    if (!result) {
      const client = String(req.headers["x-relay-client"] || "").slice(0, 64);
      try { result = await verify(cred.username, cred.key, ip, client); }
      catch (e) {
        log("relay_verify_error", ip, String(e?.message || e).slice(0, 200));
        json(res, 503, { error: "Relay authentication service unavailable." });
        return null;
      }
      if (result?.ok) verifyCache.set(ck, { at: Date.now(), result });
    }
    if (!result?.ok) {
      const status = Number(result?.status || 401);
      if (status === 401) recordFailure(ip);
      log("relay_denied", ip, cred.username, result?.reason || "?");
      // Credential problems all look the same to the caller; budget/disabled/IP say why.
      json(res, status, { error: status === 401 ? "Invalid, expired or revoked relay credentials." : (result?.message || "Denied.") });
      return null;
    }
    return { ...result, ip };
  }

  async function runtimeFor(providerKeys) {
    const h = crypto.createHash("sha256").update(JSON.stringify(Object.entries(providerKeys || {}).sort())).digest("hex");
    const hit = runtimes.get(h);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.rt;
    const rt = await piRuntime(providerKeys || {});
    runtimes.set(h, { at: Date.now(), rt });
    for (const [k, v] of runtimes) if (Date.now() - v.at > 10 * 60_000) runtimes.delete(k);
    return rt;
  }

  function modelInfo(rt, role) {
    const m = rt.findModel(role.provider, role.model_id);
    if (!m) return null;
    return {
      provider: m.provider, model_id: m.id, name: m.name || role.display_name || m.id,
      reasoning: !!m.reasoning, input: m.input || ["text"], cost: m.cost || null,
      contextWindow: m.contextWindow || 128000, maxTokens: m.maxTokens || 16384,
      thinkingLevelMap: m.thinkingLevelMap || null,
    };
  }

  async function whoami(auth, res) {
    const rt = await runtimeFor(auth.provider_keys);
    const groups = (auth.groups || []).map((g) => ({
      id: g.id, name: g.name, slug: g.slug, kind: g.kind, description: g.description,
      auto_summarize_tokens: g.auto_summarize_tokens,
      roles: (g.roles || []).map((r) => ({
        role: r.role, provider: r.provider, model_id: r.model_id, display_name: r.display_name,
        thinking_level: r.thinking_level, definition: r.definition || "", model: modelInfo(rt, r),
      })),
    }));
    json(res, 200, {
      protocol: RELAY_PROTOCOL,
      user: auth.user,
      key: { key_id: auth.key.key_id, label: auth.key.label, expires_at: auth.key.expires_at,
        daily_budget_usd: auth.key.daily_budget_usd, monthly_budget_usd: auth.key.monthly_budget_usd, spend: auth.key.spend },
      groups,
    });
  }

  async function stream(auth, req, res) {
    let body;
    try { body = JSON.parse(await readBody(req, MAX_BODY)); }
    catch (e) { json(res, e?.status || 400, { error: e?.status === 413 ? "Request too large." : "Body must be JSON." }); return; }
    if (Number(body?.protocol) !== RELAY_PROTOCOL) {
      json(res, 400, { error: `Relay protocol mismatch: server speaks ${RELAY_PROTOCOL}, client sent ${body?.protocol}. Update the rmm-relay extension.` });
      return;
    }
    const wanted = String(body.group || "").trim();
    const grp = wanted
      ? (auth.groups || []).find((g) => g.slug === wanted)
      : (auth.groups || [])[0];
    if (!grp) {
      json(res, 404, { error: `This key does not reach the group '${wanted}'. It reaches: ${(auth.groups || []).map((g) => g.slug).join(", ")}` });
      return;
    }
    const roleName = String(body.role || "orchestrator");
    const role = (grp.roles || []).find((r) => r.role === roleName);
    if (!role) {
      json(res, 404, { error: `Group '${grp.slug}' has no role '${roleName}'. Roles: ${(grp.roles || []).map((r) => r.role).join(", ")}` });
      return;
    }
    const messages = body?.context?.messages;
    if (!Array.isArray(messages) || !messages.length) { json(res, 400, { error: "context.messages is required." }); return; }

    const keyId = auth.key.key_id;
    const n = inFlight.get(keyId) || 0;
    if (n >= MAX_CONCURRENT_PER_KEY) { json(res, 429, { error: `Too many simultaneous requests for this key (max ${MAX_CONCURRENT_PER_KEY}).` }); return; }
    inFlight.set(keyId, n + 1);

    const abort = new AbortController();
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    res.on("close", onClose);
    let heartbeat = null;
    const requestId = crypto.randomUUID();
    try {
      const rt = await runtimeFor(auth.provider_keys);
      const model = rt.findModel(role.provider, role.model_id);
      if (!model) { json(res, 502, { error: `The server cannot run ${role.provider}/${role.model_id} (group '${grp.slug}', role '${roleName}').` }); return; }
      const o = body.options || {};
      const options = {
        signal: abort.signal,
        reasoning: effectiveReasoning(o.reasoning, role.thinking_level, model),
        maxTokens: Math.min(Number(o.maxTokens) || model.maxTokens || 16384, model.maxTokens || 16384),
        ...(typeof o.temperature === "number" ? { temperature: o.temperature } : {}),
        ...(o.cacheRetention ? { cacheRetention: String(o.cacheRetention) } : {}),
        ...(o.toolChoice ? { toolChoice: o.toolChoice } : {}),
        // Scoped by key so two users can never share a provider-side cache session.
        sessionId: `relay-${keyId}-${String(o.sessionId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}`,
      };

      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      const write = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };
      write({ type: "relay_start", protocol: RELAY_PROTOCOL, request_id: requestId, group: grp.slug,
        provider: model.provider, model: model.id, reasoning: options.reasoning || "off" });
      let last = Date.now();
      heartbeat = setInterval(() => { if (Date.now() - last > HEARTBEAT_MS) { write({ type: "relay_ping" }); last = Date.now(); } }, 5000);

      let final = null;
      const s = rt.raw.streamSimple(model, { messages }, options);
      for await (const ev of s) {
        write(wireEvent(ev));
        last = Date.now();
        if (ev.type === "done") final = ev.message;
        if (ev.type === "error") final = ev.error;
      }
      if (!final) { try { final = await s.result(); } catch { /* reported as an error event already */ } }

      if (final?.usage) {
        const meter = makeCostMeter({
          send: () => {}, visible: false, log, key: `relay:${keyId}`,
          sessionId: `relay-${keyId}-${requestId}`,
          ledger: sink,
          context: { surface: "relay", role: roleName === "orchestrator" ? "chat" : roleName, actorUsername: auth.user.username },
        });
        meter.record(final);
      }
      log("relay", auth.user.username, keyId, grp.slug, roleName, `${model.provider}/${model.id}`,
          `stop=${final?.stopReason || "?"}`, `$${Number(final?.usage?.cost?.total || 0).toFixed(5)}`, auth.ip);
      write({ type: "relay_end", request_id: requestId });
      res.end();
    } catch (e) {
      log("relay_error", auth.user?.username, keyId, String(e?.message || e).slice(0, 300));
      if (!res.headersSent) json(res, 500, { error: String(e?.message || e).slice(0, 300) });
      else { try { res.write(JSON.stringify({ type: "relay_error", error: String(e?.message || e).slice(0, 300) }) + "\n"); res.end(); } catch { /* gone */ } }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      res.off("close", onClose);
      inFlight.set(keyId, Math.max(0, (inFlight.get(keyId) || 1) - 1));
    }
  }

  function serveClient(url, res) {
    const files = {
      "/client/index.ts": ["index.ts", "text/plain; charset=utf-8"],
      "/client/install.sh": ["install.sh", "text/x-shellscript; charset=utf-8"],
      "/client/install.ps1": ["install.ps1", "text/plain; charset=utf-8"],
    };
    const f = files[url.pathname.slice(PREFIX.length)];
    if (!f) return false;
    try {
      const body = fs.readFileSync(path.join(CLIENT_DIR, f[0]));
      res.writeHead(200, { "Content-Type": f[1], "Cache-Control": "no-cache" });
      res.end(body);
    } catch { json(res, 404, { error: "not found" }); }
    return true;
  }

  /** Returns true if the request was a relay request (handled). */
  async function handle(req, res, url) {
    if (!url.pathname.startsWith(PREFIX + "/") && url.pathname !== PREFIX) return false;
    try {
      if (url.pathname === `${PREFIX}/health` && req.method === "GET") {
        // Advertise the client version the installer is serving so a running client can tell
        // its user "a newer extension is available - re-run the installer" without an admin
        // having to chase everyone. Public and secret-free (the file is served publicly too).
        let clientVersion = "";
        try {
          const m = /const CLIENT_VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(CLIENT_DIR, "index.ts"), "utf8"));
          if (m) clientVersion = m[1];
        } catch { /* no client shipped on this deployment */ }
        json(res, 200, { ok: true, protocol: RELAY_PROTOCOL, client_version: clientVersion });
        return true;
      }
      if (req.method === "GET" && url.pathname.startsWith(`${PREFIX}/client/`)) { if (serveClient(url, res)) return true; }
      const auth = await authenticate(req, res);
      if (!auth) return true;
      if (url.pathname === `${PREFIX}/whoami` && req.method === "GET") { await whoami(auth, res); return true; }
      if (url.pathname === `${PREFIX}/stream` && req.method === "POST") { await stream(auth, req, res); return true; }
      json(res, 404, { error: "Unknown relay endpoint." });
    } catch (e) {
      log("relay_error", "-", String(e?.message || e).slice(0, 300));
      if (!res.headersSent) json(res, 500, { error: "Relay error." });
    }
    return true;
  }

  return { handle, _test: { verifyCache, failures, inFlight } };
}
