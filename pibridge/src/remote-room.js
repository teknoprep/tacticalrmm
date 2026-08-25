// remote-room.js
//
// Pair a phone to ONE open AI window, so the technician can keep working the same
// conversation after they walk away from the desk.
//
// WHY THIS IS NOT THE `remote-pi` EXTENSION
// -----------------------------------------
// `remote-pi` ships a Pi extension that does exactly this for a terminal Pi, and the SDK
// would happily load it into our sessions via DefaultResourceLoader. We deliberately do
// not, for three reasons that all come from the same root: that extension assumes ONE Pi
// per OS process, and we run N technicians' windows inside one bridge.
//
//   1. Its state is module scope - the relay handle, the bound session, the peer map. The
//      second window to enable Remote would take the first one's connection away.
//   2. Identity and pairing live in $HOME (`~/.pi/remote/{identity,peers}.json`) and its
//      own README says a paired device is accepted by EVERY Pi process on the machine.
//      Here that would mean one technician's phone reaching another's ticket. No.
//   3. It would put `list_peers`/`agent_send` in the model's tool belt. Our tool belt is
//      capability-gated on purpose; an agent-mesh tool has no business in a device chat.
//
// So we speak the app's wire protocol ourselves and reuse only the parts of the package
// that are genuinely transport: the relay client, the peer channel, the Ed25519 identity
// and the QR token session. The bridge is already the thing the phone wants to talk to -
// it owns the session, the stream, the approval gates and the permissions.
//
// ROOMS, AND WHY ONE PROCESS CAN HOLD MANY
// ----------------------------------------
// The relay multiplexes on (pubkey, room_id). One Ed25519 identity for this server plus a
// distinct room id per window gives every open window its own connection with no identity
// juggling and no per-process $HOME games. A room is owned by the browser WebSocket that
// opened it: when that socket closes, the room closes. Nothing outlives the window, which
// is what keeps the audit story honest - a room existed exactly as long as a named
// technician had that chat open.
//
// WHAT THE PHONE CAN AND CANNOT DO
// --------------------------------
// It joins a session that already exists, at the state it is already in. Everything it
// sends is funnelled through `onClient` into the SAME switch the browser's socket feeds,
// so read-only, Write mode, auto-approve, auto-credential and the allowed-model list are
// enforced in exactly one place for both surfaces. It cannot start a new chat, cannot
// discard this one, and cannot raise a permission.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { CONFIG } from "./config.js";

// Resolved lazily: the package is an optional capability. A deployment with no relay
// configured must not fail to boot because remote-pi is not installed.
let _mods = null;
async function mods() {
  if (_mods) return _mods;
  const [relay, channel, crypto, qr] = await Promise.all([
    import("remote-pi/dist/transport/relay_client.js"),
    import("remote-pi/dist/transport/peer_channel.js"),
    import("remote-pi/dist/pairing/crypto.js"),
    import("remote-pi/dist/pairing/qr.js"),
  ]);
  _mods = {
    RelayClient: relay.RelayClient,
    PlainPeerChannel: channel.PlainPeerChannel,
    generateEd25519Keypair: crypto.generateEd25519Keypair,
    buildQRUri: qr.buildQRUri,
  };
  return _mods;
}

/** Is the mobile capability installed on this server at all? */
export async function remoteAvailable() {
  try {
    await mods();
    return true;
  } catch {
    return false;
  }
}

const STATE_DIR = path.join(path.dirname(CONFIG.sessionsRoot), "remote");
const IDENTITY_FILE = path.join(STATE_DIR, "identity.json");
const PEERS_FILE = path.join(STATE_DIR, "peers.json");

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

// ---- identity ---------------------------------------------------------------------
// One Ed25519 keypair for this SERVER, not one per window: it is the bridge that the
// relay authenticates, and rooms are what separate the windows. Deliberately ours rather
// than the `tactical` user's `~/.pi/remote/identity.json` - the human's terminal Pi and
// the RMM's bridge should not share an identity or a pairing list.
let _keypair = null;
async function identity() {
  if (_keypair) return _keypair;
  ensureStateDir();
  try {
    const raw = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf8"));
    _keypair = {
      publicKey: Buffer.from(raw.publicKey, "base64"),
      secretKey: Buffer.from(raw.secretKey, "base64"),
    };
    return _keypair;
  } catch {
    /* first run */
  }
  const { generateEd25519Keypair } = await mods();
  const kp = generateEd25519Keypair();
  fs.writeFileSync(
    IDENTITY_FILE,
    JSON.stringify({
      publicKey: Buffer.from(kp.publicKey).toString("base64"),
      secretKey: Buffer.from(kp.secretKey).toString("base64"),
    }),
    { mode: 0o600 },
  );
  _keypair = kp;
  return _keypair;
}

// ---- peer store -------------------------------------------------------------------
// Keyed by RMM username, which is the whole point: a phone paired by one technician can
// never attach to another's window. `remote-pi`'s own machine-wide peers.json is exactly
// the model we are refusing here, so we do not touch it.
function readPeers() {
  try {
    return JSON.parse(fs.readFileSync(PEERS_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function writePeers(all) {
  ensureStateDir();
  const tmp = `${PEERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, PEERS_FILE);
}

/** Devices this technician has paired, newest first. */
export function pairedDevices(username) {
  const list = readPeers()[String(username || "").toLowerCase()] || [];
  return list
    .slice()
    .sort((a, b) => String(b.paired_at || "").localeCompare(String(a.paired_at || "")))
    .map((p) => ({ name: p.name, paired_at: p.paired_at, id: String(p.remote_epk || "").slice(0, 8) }));
}

function rememberPeer(username, record) {
  const all = readPeers();
  const key = String(username || "").toLowerCase();
  const list = (all[key] || []).filter((p) => p.remote_epk !== record.remote_epk);
  list.push(record);
  all[key] = list;
  writePeers(all);
}

function knowsPeer(username, epk) {
  const list = readPeers()[String(username || "").toLowerCase()] || [];
  return list.some((p) => p.remote_epk === epk);
}

export function revokeDevice(username, shortId) {
  const all = readPeers();
  const key = String(username || "").toLowerCase();
  const before = (all[key] || []).length;
  all[key] = (all[key] || []).filter((p) => !String(p.remote_epk || "").startsWith(shortId));
  writePeers(all);
  return before !== (all[key] || []).length;
}

// ---- pairing tokens ---------------------------------------------------------------
// Short-lived and single-use. The QR is the only way into a room, so its window is the
// window of exposure: a code photographed off a screen an hour ago must be worthless.
const TOKEN_TTL_MS = 60 * 1000;

function newToken() {
  return randomBytes(16).toString("base64url");
}

/**
 * Open a relay room for one AI window.
 *
 * @param {object} o
 * @param {string} o.relayUrl   http(s):// - converted to ws(s):// by the transport
 * @param {string} o.username   RMM username; owns the pairing records
 * @param {string|function} o.label  what the phone shows as the session name. A FUNCTION
 *                              when the caller has a name that can change under it - see
 *                              `resolveLabel` below.
 * @param {string} o.key        history key (agent id / decision:<ticket>) - room scoping + logs
 * @param {function} o.onClient (ClientMessage) => void, from a paired device only
 * @param {function} o.onState  ({state, device}) => void, for the browser's chip
 * @param {function} o.log
 */
export async function openRemoteRoom({ relayUrl, username, label, key, onClient, onState, log }) {
  const { RelayClient, PlainPeerChannel, buildQRUri } = await mods();
  const kp = await identity();

  // The window's own Label field is the name a technician gives this piece of work, and it
  // is editable at any moment - including after Remote is switched on. So the label is
  // resolved every time it actually goes on the wire (room meta, QR payload, pair_ok)
  // rather than being frozen when the room opened. A phone list showing "DC01 - BlueCloud"
  // three times is useless; "Exchange migration - HQ" is the whole point of the field.
  const resolveLabel = () => {
    let v = "";
    try { v = typeof label === "function" ? label() : label; } catch { v = ""; }
    return String(v || "").replace(/\s+/g, " ").trim().slice(0, 120) || "RMM session";
  };

  // Room id: this window, not this directory. `remote-pi` derives it from cwd because one
  // terminal Pi is one folder; our windows all share a cwd, so cwd would collide every
  // one of them into a single room. Random per room, 12 chars base64url like theirs.
  const roomId = createHash("sha256")
    .update(`${key}\0${username}\0${randomBytes(8).toString("hex")}`)
    .digest("base64url")
    .slice(0, 12);

  const relay = new RelayClient(relayUrl, kp);
  await relay.connect({
    roomId,
    roomMeta: { name: resolveLabel(), cwd: CONFIG.sessionsRoot },
  });

  /** @type {Map<string, {channel: any, name: string}>} */
  const peers = new Map();
  let token = null;
  let tokenExpires = 0;
  let closed = false;

  function state() {
    if (peers.size) {
      return { state: "paired", device: [...peers.values()].map((p) => p.name).join(", ") };
    }
    return { state: "waiting", device: "" };
  }

  function announce() {
    try { onState?.(state()); } catch { /* browser gone */ }
  }

  /** Send one ServerMessage to every attached device. */
  function send(msg) {
    for (const { channel } of peers.values()) {
      try { channel.send(msg); } catch { /* one bad channel must not stop the rest */ }
    }
  }

  function attach(appPeerId, name) {
    const channel = new PlainPeerChannel(
      relay,
      appPeerId,
      roomId,
      (msg) => handleClient(appPeerId, msg),
      () => {
        peers.delete(appPeerId);
        log?.("remote device detached", key, username, name);
        announce();
      },
    );
    peers.set(appPeerId, { channel, name });
    announce();
    return channel;
  }

  function handleClient(appPeerId, msg) {
    if (closed || !msg || typeof msg !== "object") return;
    // Everything except pairing requires an attached (therefore paired) peer. A device
    // that never paired has no channel, so it can only ever reach the branch below.
    if (msg.type === "pair_request") return;
    onClient?.(msg, { peerId: appPeerId, name: peers.get(appPeerId)?.name || "phone" });
  }

  // Raw relay lines: pairing happens before a peer has a channel, so it is handled here
  // rather than in PlainPeerChannel.
  relay.on("message", (line) => {
    if (closed) return;
    let outer;
    try { outer = JSON.parse(line); } catch { return; }
    const appPeerId = outer?.peer;
    if (!appPeerId || !outer?.ct) return;

    let inner;
    try { inner = JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8")); } catch { return; }

    if (inner?.type === "pair_request") {
      const reply = (m) => {
        try {
          // Same outer envelope PlainPeerChannel writes: { peer, ct }. Pairing happens
          // before a channel exists, so this one frame is hand-rolled.
          relay.send(JSON.stringify({
            peer: appPeerId,
            ct: Buffer.from(JSON.stringify(m)).toString("base64"),
          }));
        } catch { /* relay gone */ }
      };
      const now = Date.now();
      if (!token || inner.token !== token) {
        log?.("remote pair rejected", key, username, "token unknown");
        reply({ type: "pair_error", in_reply_to: inner.id, code: "token_unknown", message: "Pairing code not recognised. Press Remote again for a fresh code." });
        return;
      }
      if (now > tokenExpires) {
        token = null;
        log?.("remote pair rejected", key, username, "token expired");
        reply({ type: "pair_error", in_reply_to: inner.id, code: "token_expired", message: "That pairing code has expired. Press Remote again for a fresh one." });
        return;
      }
      token = null; // single use
      const name = String(inner.device_name || "phone").slice(0, 60);
      rememberPeer(username, { name, remote_epk: appPeerId, paired_at: new Date().toISOString() });
      attach(appPeerId, name);
      log?.("remote device paired", key, username, name);
      reply({
        type: "pair_ok",
        in_reply_to: inner.id,
        session_name: resolveLabel(),
        session_started_at: Date.now(),
        room_id: roomId,
        harness: { name: "BlueCloud RMM (pi-trmm-bridge)", version: "1" },
        hostname: process.env.RMM_PUBLIC_HOST || "rmm",
      });
      return;
    }

    // A device this technician already paired, reconnecting into a NEW room (a new
    // window). It has no channel here yet, so promote it without a fresh QR - that is
    // what makes the second and every later use one tap instead of a scan.
    if (!peers.has(appPeerId) && knowsPeer(username, appPeerId)) {
      const known = (readPeers()[String(username).toLowerCase()] || []).find((p) => p.remote_epk === appPeerId);
      const channel = attach(appPeerId, known?.name || "phone");
      log?.("remote device reattached", key, username, known?.name || "phone");
      channel.send({
        type: "pair_ok",
        in_reply_to: inner?.id || "reattach",
        session_name: resolveLabel(),
        session_started_at: Date.now(),
        room_id: roomId,
        harness: { name: "BlueCloud RMM (pi-trmm-bridge)", version: "1" },
        hostname: process.env.RMM_PUBLIC_HOST || "rmm",
      });
      if (inner?.type) handleClient(appPeerId, inner);
    }
  });

  relay.on("error", (e) => log?.("remote relay error", key, username, String(e?.message || e)));

  /** Issue a fresh pairing code + QR payload. */
  function pairingCode() {
    token = newToken();
    tokenExpires = Date.now() + TOKEN_TTL_MS;
    const name = resolveLabel();
    const uri = buildQRUri(token, kp.publicKey, name, roomId);
    return { uri, expires_in_ms: TOKEN_TTL_MS, label: name };
  }

  function close(reason = "peer_stop") {
    if (closed) return;
    closed = true;
    token = null;
    for (const { channel } of peers.values()) {
      try { channel.send({ type: "bye", reason: "peer_stop" }); } catch {}
      try { channel.detach(); } catch {}
    }
    peers.clear();
    try { relay.close(); } catch {}
    log?.("remote room closed", key, username, reason);
  }

  log?.("remote room opened", key, username, `room=${roomId}`);
  return {
    roomId,
    send,
    pairingCode,
    close,
    get pairedCount() { return peers.size; },
    get label() { return resolveLabel(); },
    state,
  };
}

// ---- the seam both chat surfaces use -----------------------------------------------
// Pi Chat and the AI Decision chat differ in what a prompt DOES (watchdogs, liveness,
// work recording, ticket assignment), so the binding takes those as callbacks instead of
// reaching into either. What it owns is everything that is identical: the toggle, the
// pairing handshake, the fan-out, and the guarantee that the room dies with the window.
//
// `blob.remote_allowed` is the only authority. It was computed by Django when the session
// token was minted, so a browser that sends `set_remote` on a window whose role does not
// carry the permission gets told no - exactly like Auto-approve and Auto-credential.
export function makeRemoteBinding({
  blob,
  key,
  label,
  log,
  toBrowser,
  submitPrompt,
  abort,
  resolveApproval,
  transcript,
  startedAt = Date.now(),
}) {
  const allowed = !!blob.remote_allowed && !!blob.remote_relay_url;
  const username = blob.username || "";
  let room = null;
  let turnId = "turn-0";
  let turnSeq = 0;
  // Per-turn scratchpad for the translation - see `toWireMessages`.
  const seen = { streamed: false };

  function tell(frame) {
    try { toBrowser(frame); } catch { /* browser gone */ }
  }

  function pushState(extra = {}) {
    tell({
      type: "remote_state",
      enabled: !!room,
      allowed,
      label: room ? room.label : "",
      devices: allowed ? pairedDevices(username) : [],
      ...(room ? room.state() : { state: "off", device: "" }),
      ...extra,
    });
  }

  /** Issue a code and hand it to the browser's pairing dialog. */
  function emitPairing() {
    if (!room) return false;
    const code = room.pairingCode();
    tell({
      type: "remote_pairing",
      uri: code.uri,
      expires_in_ms: code.expires_in_ms,
      label: code.label,
    });
    return true;
  }

  async function open() {
    if (room) return;
    room = await openRemoteRoom({
      relayUrl: blob.remote_relay_url,
      username,
      label,
      key,
      log,
      onState: () => pushState(),
      onClient: (msg, who) => { void handlePhone(msg, who); },
    });
  }

  function close(reason) {
    if (!room) return;
    try { room.close(reason); } catch { /* already gone */ }
    room = null;
  }

  async function handlePhone(msg, who) {
    try {
      switch (msg.type) {
        case "user_message": {
          // The phone's message id becomes the turn id, which is what the app correlates
          // its streaming chunks against.
          turnId = String(msg.id || `turn-${++turnSeq}`);
          log?.("remote prompt", key, username, `${who.name}: ${String(msg.text || "").slice(0, 120)}`);
          // Mirror it into the browser transcript. Someone watching the RMM window must
          // see what was said from the phone - a conversation with invisible turns is
          // how two people end up giving the same machine contradictory instructions.
          tell({ type: "remote_user_message", text: String(msg.text || ""), device: who.name });
          await submitPrompt(String(msg.text || ""), msg.images || []);
          break;
        }
        case "cancel":
          log?.("remote abort", key, username, who.name);
          await abort();
          room?.send({ type: "cancelled", in_reply_to: String(msg.id || ""), target_id: String(msg.target_id || turnId) });
          break;
        case "approve_tool":
          resolveApproval(String(msg.tool_call_id || ""), msg.decision === "allow");
          break;
        case "extension_ui_response":
          // How an approval prompt comes back: the app renders it as a confirm dialog.
          resolveApproval(String(msg.id || ""), msg.confirmed === true);
          break;
        case "session_sync": {
          // The phone joined a conversation already in progress. This is the whole of it.
          const events = toWireHistory(transcript?.() || [], startedAt);
          log?.("remote sync", key, username, `${events.length} events to ${who.name}`);
          room?.send({
            type: "session_history",
            in_reply_to: String(msg.id || ""),
            session_started_at: startedAt,
            events,
            eos: true,
            truncated: false,
          });
          break;
        }
        case "ping":
          room?.send({ type: "pong", in_reply_to: String(msg.id || "") });
          break;
        // Refused on purpose. A phone must not be able to discard or fork a session that
        // a technician - possibly a different one - is watching in the browser.
        case "session_new":
        case "session_compact":
          room?.send({
            type: "action_error",
            in_reply_to: String(msg.id || ""),
            action: msg.type,
            error: "Not available from mobile. This window belongs to an RMM session; start or compact it there.",
          });
          break;
        case "model_set":
        case "thinking_set":
          room?.send({
            type: "action_error",
            in_reply_to: String(msg.id || ""),
            action: msg.type,
            error: "Model and thinking level are set in the RMM window.",
          });
          break;
        case "list_models":
          // Truthful and harmless: the one model this session is actually running.
          room?.send({
            type: "models_list",
            in_reply_to: String(msg.id || ""),
            models: [],
            current: {
              id: blob.model_id || "",
              name: blob.model_id || "",
              provider: blob.provider || "",
              reasoning: false,
              context_window: 0,
              vision: false,
            },
          });
          break;
        default:
          break;
      }
    } catch (e) {
      log?.("remote handler error", key, username, String(e?.message || e));
      room?.send({ type: "error", code: "internal_error", message: String(e?.message || e).slice(0, 300) });
    }
  }

  return {
    get active() { return !!room; },

    /** Browser frames this binding owns. Returns true when it consumed the message. */
    async handleBrowser(msg) {
      if (msg?.type === "set_remote") {
        if (!allowed) {
          // Never silently ignore it: the switch has to snap back, or the technician
          // believes their conversation is on their phone when it is not.
          pushState({ error: "Mobile access is not enabled for your role, or no relay is configured." });
          return true;
        }
        if (msg.value) {
          try {
            await open();
            pushState();
            // Switching Remote on IS the request for a code. The browser opens its
            // dialog on the click and sits on a spinner until a `remote_pairing` frame
            // arrives, so making the FIRST code wait for a second click leaves the
            // technician staring at "Opening the relay..." forever - which is exactly
            // what it did. One code, issued here, the moment the room is up.
            emitPairing();
          } catch (e) {
            log?.("remote open failed", key, username, String(e?.message || e));
            close("open failed");
            pushState({ error: `Could not reach the relay: ${String(e?.message || e).slice(0, 200)}` });
          }
        } else {
          close("technician switched Remote off");
          pushState();
        }
        return true;
      }
      if (msg?.type === "remote_pair") {
        if (!room) {
          // Asking for a code with no room is not an error worth refusing - it is the
          // same intent as switching Remote on. Open, then hand back the code.
          if (!allowed) {
            pushState({ error: "Mobile access is not enabled for your role, or no relay is configured." });
            return true;
          }
          try {
            await open();
            pushState();
          } catch (e) {
            log?.("remote open failed", key, username, String(e?.message || e));
            close("open failed");
            pushState({ error: `Could not reach the relay: ${String(e?.message || e).slice(0, 200)}` });
            return true;
          }
        }
        emitPairing();
        return true;
      }
      if (msg?.type === "remote_status") {
        pushState();
        return true;
      }
      return false;
    },

    /** A turn started from the browser - give the phone a turn id to hang chunks on. */
    beginBrowserTurn(text) {
      turnId = `turn-${++turnSeq}`;
      room?.send({ type: "user_input", id: turnId, text: String(text || "") });
    },

    /** Every SDK event, already being sent to the browser. */
    onAgentEvent(event) {
      if (!room) return;
      for (const m of toWireMessages(event, turnId, seen)) room.send(m);
    },

    /**
     * A frame the BROWSER is being sent, mirrored to the phone when it carries something
     * the window puts on screen. Errors, compaction notices, cost warnings and switch
     * changes are all things a technician reads and acts on; a phone that silently misses
     * them is showing a different conversation from the one at the desk.
     *
     * The app's decoder REJECTS unknown types, so everything lands as `error` or
     * `agent_message` - the two shapes it will render.
     */
    mirrorToPhone(frame) {
      if (!room) return;
      const wire = browserFrameToPhone(frame, turnId);
      if (wire) room.send(wire);
    },

    /** An approval the model is waiting on - the phone can answer it. */
    onApprovalRequest(id, summary) {
      room?.send({
        type: "extension_ui_request",
        id,
        method: "confirm",
        title: "Approve this action?",
        message: String(summary || "").slice(0, 1500),
      });
    },

    /** Anything the window shows as an error should reach the phone too. */
    onError(message) {
      room?.send({ type: "error", code: "internal_error", message: String(message || "").slice(0, 800) });
    },

    pushState,
    close,
  };
}

/**
 * A frame bound for the browser, as the phone should hear it - or null for the ones it
 * has no business seeing (cost meters ticking, working pings, toggle echoes it already
 * got as a sentence).
 *
 * The app's decoder REJECTS unknown server types, so everything has to land as one of the
 * shapes it renders: `error` or `agent_message`.
 */
export function browserFrameToPhone(frame, turnId = "turn-0") {
  if (!frame || typeof frame !== "object") return null;
  const t = frame.type;
  if (t === "error") {
    const text = String(frame.message || "").trim();
    return text ? { type: "error", code: "internal_error", message: text.slice(0, 800) } : null;
  }
  const line =
    t === "system_note" ? String(frame.text || "")
    : t === "compacted" ? `\u{1F5DC} ${frame.message || "Conversation summarised."}`
    : t === "cost_warning" ? `\u26a0 ${frame.message || ""}`
    : t === "info" ? String(frame.message || "")
    : t === "model_changed" ? `Switched model to ${frame.display || frame.model_id || ""}`
    : "";
  return line.trim() ? { type: "agent_message", in_reply_to: turnId, text: line.trim() } : null;
}

// ---- SDK shapes -> text -------------------------------------------------------------
// The phone is a small screen on a slow link, so tool output is an indicator here and
// the full thing stays in the browser transcript. Everything else must match what the
// window shows, word for word: two people reading different accounts of the same turn is
// the failure this file exists to prevent.
const TOOL_RESULT_MAX = 2000;

/** Join the text blocks of an SDK content array (or pass a plain string through). */
function blockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c && c.type === "text" ? String(c.text ?? "") : "")).join("");
}

/**
 * One tool result, one string - whether it arrived as the LIVE event's wrapper
 * (`{content:[…], details}`) or as the stored message's bare content array. They used to
 * be read by two different bits of code, which is how the phone ended up showing
 * "[object Object]" live and the real output after a re-sync.
 */
function toolResultText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return blockText(value);
  if (value && typeof value === "object") {
    if (Array.isArray(value.content)) return blockText(value.content);
    if (typeof value.text === "string") return value.text;
    try { return JSON.stringify(value); } catch { return ""; }
  }
  return value === null || value === undefined ? "" : String(value);
}

function clipForPhone(text) {
  const t = String(text || "");
  return t.length > TOOL_RESULT_MAX
    ? `${t.slice(0, TOOL_RESULT_MAX)}\n…(truncated - see the RMM window)`
    : t;
}

/** Photos the technician attached, in the shape the app rebuilds a bubble from. */
function imagesFromContent(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    if (c && c.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string") {
      out.push({ data: c.data, mime: c.mimeType });
    }
  }
  return out;
}

// ---- SDK event -> app wire ---------------------------------------------------------
// The browser gets the raw SDK event and renders it; the phone speaks a flatter protocol.
// One translation, in one place, so a protocol bump is a single file to fix.
//
// Returns an array because one SDK event can be zero or more wire messages.
//
// `seen` is the per-turn scratchpad the caller owns (see `onAgentEvent`). It exists for
// one case: an assistant message that arrives with NO text deltas - a replayed turn, a
// recovery, a provider that does not stream. The browser renders it from the finished
// message and the phone, which only ever saw deltas, showed an empty bubble. Now the end
// of the turn fills it in.
export function toWireMessages(event, turnId, seen = null) {
  const out = [];
  switch (event?.type) {
    case "message_update": {
      const ev = event.assistantMessageEvent;
      if (ev?.type === "text_delta" && ev.delta) {
        if (seen) seen.streamed = true;
        out.push({ type: "agent_chunk", in_reply_to: turnId, delta: ev.delta });
      }
      break;
    }
    case "tool_execution_start":
      out.push({
        type: "tool_request",
        tool_call_id: event.toolCallId,
        tool: event.toolName,
        args: event.args || {},
      });
      break;
    case "tool_execution_end": {
      const text = clipForPhone(toolResultText(event.result));
      out.push(
        event.isError
          ? { type: "tool_result", tool_call_id: event.toolCallId, error: text || "failed" }
          : { type: "tool_result", tool_call_id: event.toolCallId, result: text },
      );
      break;
    }
    case "message_end":
      if (event.message?.role === "assistant") {
        const usage = event.message.usage
          ? {
              input_tokens: Number(event.message.usage.input || 0),
              output_tokens: Number(event.message.usage.output || 0),
            }
          : undefined;
        // Nothing streamed, but the finished message has words in it: send them whole,
        // or the phone shows a turn that answered nothing.
        if (seen && !seen.streamed) {
          const text = blockText(event.message.content);
          if (text.trim()) out.push({ type: "agent_message", in_reply_to: turnId, text });
        }
        if (seen) seen.streamed = false;
        out.push({ type: "agent_done", in_reply_to: turnId, ...(usage ? { usage } : {}) });
      }
      break;
    default:
      break;
  }
  return out;
}

/**
 * The conversation so far, in the shape `session_sync` expects.
 *
 * A phone pairs into a chat that is already running, so this IS the phone's view of
 * everything that happened before it arrived. It takes the SAME transcript the browser
 * renders (`uiTranscript`) - SDK messages with content BLOCKS, not flat strings.
 *
 * The previous version read `m.text`, which no message has: every synced bubble came out
 * empty, tool calls were dropped entirely, and a reply was threaded to its own timestamp
 * instead of the question. A technician pairing mid-ticket got a blank conversation and
 * had to walk back to the desk to read it - the exact thing Remote exists to avoid.
 *
 * @param {Array} transcript  uiTranscript() output: {role, content, toolCallId, isError}
 * @param {number} startedAt  session start, so the ordering clock is real
 */
export function toWireHistory(transcript, startedAt = 0) {
  const events = [];
  // Anchor the clock to the first REAL timestamp when the SDK kept one, so a resumed
  // conversation is not stamped as if it all happened in the last few seconds.
  const firstStamp = (transcript || [])
    .map((m) => (typeof m?.timestamp === "number" ? m.timestamp : 0))
    .find((t) => t > 0);
  let clock = firstStamp
    ? firstStamp - 1
    : (Number(startedAt) > 0 ? Number(startedAt) : Date.now() - (transcript?.length || 0) * 1000);
  let lastUserId = null;

  for (const m of transcript || []) {
    // Real timestamps when the SDK kept them, monotonic filler when it did not. Order is
    // the thing that must never be wrong; exact times are a bonus.
    const stamped = typeof m?.timestamp === "number" && m.timestamp > 0 ? m.timestamp : 0;
    clock = Math.max(clock + 1, stamped);
    const ts = clock;

    if (!m || typeof m !== "object") continue;

    if (m.role === "user") {
      const text = blockText(m.content);
      const images = imagesFromContent(m.content);
      if (!text.trim() && !images.length) continue;
      const id = `sync_${ts}`;
      lastUserId = id;
      events.push({ ts, type: "user_input", id, text, ...(images.length ? { images } : {}) });
      continue;
    }

    if (m.role === "assistant") {
      const content = Array.isArray(m.content) ? m.content : [];
      const usage = m.usage
        ? { input_tokens: Number(m.usage.input || 0), output_tokens: Number(m.usage.output || 0) }
        : undefined;
      if (!content.length) {
        const text = blockText(m.content);
        if (text.trim()) {
          events.push({ ts, type: "agent_message", in_reply_to: lastUserId || `sync_${ts}`, text });
        }
        continue;
      }
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text") {
          const text = String(block.text ?? "");
          if (!text.trim()) continue;
          events.push({
            ts,
            type: "agent_message",
            in_reply_to: lastUserId || `sync_${ts}`,
            text,
            ...(usage ? { usage } : {}),
          });
        } else if (block.type === "toolCall") {
          // The window shows what Pi RAN, not just what it said about it. Without these
          // the phone reads like a monologue with unexplained gaps.
          events.push({
            ts,
            type: "tool_request",
            tool_call_id: String(block.id ?? ""),
            tool: String(block.name ?? ""),
            args: block.arguments ?? {},
          });
        }
      }
      continue;
    }

    if (m.role === "toolResult") {
      const text = clipForPhone(toolResultText(m.content));
      const id = String(m.toolCallId ?? "");
      events.push(
        m.isError
          ? { ts, type: "tool_result", tool_call_id: id, error: text || "failed" }
          : { ts, type: "tool_result", tool_call_id: id, result: text },
      );
      continue;
    }

    if (m.role === "system") {
      // The bridge's own divider at a compaction point. The app renders this natively,
      // so a resumed chat explains its own gap on the phone exactly as it does on screen.
      const text = blockText(m.content);
      if (text.trim()) events.push({ ts, type: "compaction", summary: text, tokens_before: 0 });
    }
  }
  return events;
}
