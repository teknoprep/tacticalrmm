// live-hub.js - the AI session lives on the SERVER; a browser is a reflection of it.
//
// Owner's brief (2026-09-15): "the AI runs on the server and the connection to the user is
// just a reflection of that; if you disconnect, the AI keeps running for N minutes (a
// Global Setting, 0 = never stop); anyone else viewing sees it read-only; take-over needs a
// permission."
//
// Before this, the device chat and the ticket chat created one AI session PER SOCKET and
// disposed it in ws.on("close"). A dropped Wi-Fi link mid-turn killed the turn; a second
// tab on the same ticket was a second conversation; a phone could only ever be a
// "remote" bolted on the side. The Odoo panel already worked the right way (one session
// per conversation, sockets fan-in/out, 5-minute dispose grace) - this generalises that.
//
// One HUB per live conversation, keyed on (scope, sessionId):
//   * `send(frame)` fans a frame out to every attached socket (the AI's output, tool
//     cards, approvals, cost). The chat code calls hub.send where it used to call ws.send.
//   * `attach(ws, blob)` joins a socket: presence (live-presence.js) decides whether it
//     DRIVES or WATCHES; a reconnect by the same person within the reclaim grace gets the
//     seat straight back, which is what a refresh looks like.
//   * `detach(ws)` leaves; when the LAST socket leaves the grace timer starts. The turn
//     in flight keeps running. If nobody comes back within `graceMs` the session is
//     aborted and disposed; graceMs 0 means never.
//   * `canDrive(ws)` is the authority check every mutating frame goes through. A viewer's
//     "prompt" is refused ON THE SERVER with a read-only notice - hiding the text box in
//     the browser is a courtesy, not a permission.
//
// The registry is process-local. The bridge is one process, so that is the whole truth.
import {
  newPresence, join, leave, canDrive as presenceCanDrive, isOwner,
  requestTakeover, markPending, respondTakeover, presenceFrame, CONSENT_TIMEOUT_MS,
} from "./live-presence.js";

export const LIVE = new Map(); // key -> hub

// A hub being BUILT. createAgentSession() takes about a second; when a bridge restart makes
// every open window reconnect at once, two sockets for the same conversation both looked in
// LIVE, both found nothing, and both built a hub - two AIs on one conversation, and a
// viewer whose queue never changed. The first arrival now leaves a promise here; anyone
// else arriving in that second awaits it and attaches to the same hub.
export const LIVE_PENDING = new Map(); // key -> Promise<hub>

export function claimPending(key, timeoutMs = 30_000) {
  let resolve, reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  p.catch(() => {}); // a failed build is reported to the waiters, not as an unhandled rejection
  LIVE_PENDING.set(key, p);
  // If the builder dies (createAgentSession threw, socket vanished) nobody would ever
  // resolve this; waiters must fall through to building their own instead of hanging.
  const t = setTimeout(() => { if (LIVE_PENDING.get(key) === p) { LIVE_PENDING.delete(key); reject(new Error("build timed out")); } }, timeoutMs);
  if (t.unref) t.unref();
  return {
    resolve: (hub) => { clearTimeout(t); if (LIVE_PENDING.get(key) === p) LIVE_PENDING.delete(key); resolve(hub); },
    fail: (e) => { clearTimeout(t); if (LIVE_PENDING.get(key) === p) LIVE_PENDING.delete(key); reject(e); },
  };
}

/**
 * WHO IS ON THIS SOCKET.
 *
 * A live session is shared - one driver, any number of watchers, a seat that gets handed
 * over, and a paired phone that is just another socket. So "the operator" is not one
 * person for the life of a conversation, and the queue history (queue.js) records the
 * person behind each prompt, answer and stop so an admin reading it later can see who did
 * what. Presence is the authority on that: it is the same map the driving check uses.
 *
 * Falls back to the person the session was opened for when there is no socket to ask
 * (a queued prompt firing on its own, a bridge-side retry) - attribution is never blank
 * when we know the answer.
 */
export function actorOn(hub, sock, blob) {
  const m = sock && hub?.presence ? hub.presence.members.get(sock) : null;
  if (m) return { user: m.username || "", display: m.display || m.username || "" };
  return {
    user: String(blob?.username || "").toLowerCase(),
    display: blob?.user_display || blob?.username || "",
  };
}

export function liveKey(scope, sessionId) {
  return `${scope}::${sessionId}`;
}

/**
 * @param {object} o
 * @param {string}   o.key        liveKey(scope, sessionId)
 * @param {number}   o.graceMs    how long the session survives with no viewer; 0 = forever
 * @param {function} o.log
 * @param {function} o.onDispose  tear the AI session down (abort, dispose, queue.detach...)
 * @param {function} [o.onOwnerChange] (ownerIdentOrNull, reason) -> void
 */
export function makeHub({ key, graceMs, log, onDispose, onOwnerChange = () => {}, aliases = [] }) {
  const sockets = new Set();
  // ALIASES: every key that refers to THIS conversation. A session resumed from disk gets a
  // NEW id from the runtime, but the browser, the inbox and AI History still hold the OLD
  // one. Without the alias a viewer asking for the old id missed the live hub and the
  // bridge opened a second copy from disk - two AIs, one conversation, and the viewer's
  // queue never changed when the driver answered. Both keys now find the same hub.
  const keys = [key, ...aliases.filter((k) => k && k !== key)];
  const presence = newPresence();
  let graceTimer = null;
  let disposed = false;
  let streaming = false; // mirrored by the chat code so a late joiner knows the state
  // Frames of the turn currently in flight, replayed to whoever attaches mid-answer.
  // Capped: a very long turn (hundreds of tool calls) must not grow without bound, and
  // the newcomer only needs what is on screen - the transcript has the rest once the
  // turn ends. At the cap the OLDEST frames are dropped rather than the newest, so the
  // most recent context always survives.
  const turnBuffer = [];
  const TURN_BUFFER_MAX = 4000;
  // PINNED: the driver has asked for the session to survive with no viewer at all. The
  // phone app does this while it drives, because a phone in the background drops its
  // socket within seconds and the work must not stop with it. A pinned session ignores the
  // grace; it is still torn down after PIN_MAX_MS with nobody ever coming back, so a
  // forgotten phone cannot hold a session forever.
  let pinned = false;
  let pinnedBy = "";
  let pinTimer = null;
  const PIN_MAX_MS = Number(process.env.PI_LIVE_PIN_MAX_HOURS || 24) * 3600 * 1000;

  const raw = (frame) => (typeof frame === "string" ? frame : JSON.stringify(frame));

  const hub = {
    key,
    presence,
    // STATE REPLAY. A hub outlives the socket that created it, so a socket that attaches
    // LATER (a refresh, a second tab, the phone, a viewer, a reconnect after a drop) missed
    // every state frame that was sent when the session started. The session registers
    // providers here - the prompt queue and the cost meter both expose a snapshot() - and
    // each new socket is caught up on attach.
    //
    // This is why a long-running window could come back with its "History" button greyed
    // out and its spend showing nothing: the data was on the server the whole time, but
    // nothing ever re-sent it to the newcomer.
    stateProviders: [],
    replayState(ws) {
      for (const provide of this.stateProviders) {
        let frame;
        try { frame = provide(); } catch { frame = null; }
        if (frame) this.sendTo(ws, frame);
      }
      // ...and the part of the CURRENT turn that already happened (see noteTurnEvent).
      for (const frame of turnBuffer) {
        try { this.sendTo(ws, frame); } catch { /* gone */ }
      }
    },

    /** Every model event of the turn IN FLIGHT, so a socket that joins mid-answer is not
     *  missing the first half of it.
     *
     *  The transcript is only written when a turn ENDS, so `ready.history` cannot contain
     *  an answer that is still being streamed. A window opened (or reconnected, or woken
     *  from background on a phone) while the AI was mid-sentence therefore saw the tail of
     *  the message and nothing before it - text the technician had already acted on,
     *  silently absent. Owner's bar: no data missing, ever.
     *
     *  Cleared when the turn ends, because from then on the transcript is the record. */
    noteTurnEvent(frame, event) {
      const t = event && event.type;
      if (t === "agent_start" || t === "turn_start") turnBuffer.length = 0;
      turnBuffer.push(frame);
      if (turnBuffer.length > TURN_BUFFER_MAX) turnBuffer.splice(0, turnBuffer.length - TURN_BUFFER_MAX);
      // agent_end: the answer is in session.messages and will be persisted, so ready.history
      // carries it from here on and replaying these frames too would double it up.
      if (t === "agent_end" || t === "agent_abort" || t === "turn_end") turnBuffer.length = 0;
    },
    /** Belt and braces: an aborted/failed turn that never emits an end event. */
    clearTurnBuffer() { turnBuffer.length = 0; },
    get size() { return sockets.size; },
    get disposed() { return disposed; },
    set streaming(v) { streaming = !!v; },
    get streaming() { return streaming; },

    /** Fan out to everyone watching. Same signature as ws.send, so it drops in. */
    send(frame) {
      const payload = raw(frame);
      for (const ws of sockets) {
        if (ws.readyState === 1) { try { ws.send(payload); } catch { /* gone */ } }
      }
    },
    /** Everyone except one socket (what the driver typed goes to the viewers). */
    sendExcept(skip, frame) {
      const payload = raw(frame);
      for (const ws of sockets) {
        if (ws !== skip && ws.readyState === 1) { try { ws.send(payload); } catch { /* gone */ } }
      }
    },
    /** One socket only (its own presence frame, its own refusal). */
    sendTo(ws, frame) {
      if (ws && ws.readyState === 1) { try { ws.send(raw(frame)); } catch { /* gone */ } }
    },
    /** Tell everyone who is driving now. `you` differs per socket, so one frame each. */
    broadcastPresence() {
      for (const ws of sockets) hub.sendTo(ws, presenceFrame(presence, ws));
    },

    get pinned() { return pinned; },
    get pinnedBy() { return pinnedBy; },
    /** Only the driver may pin/unpin. Returns the new state. */
    setPin(ws, value) {
      if (!hub.canDrive(ws)) return { ok: false, pinned, reason: "only the driver can pin a session" };
      pinned = !!value;
      const who = presence.members.get(ws);
      pinnedBy = pinned ? ((who && who.display) || "the driver") : "";
      if (!pinned && pinTimer) { clearTimeout(pinTimer); pinTimer = null; }
      log?.("live_pin", key, pinned ? `pinned by ${pinnedBy}` : "unpinned");
      hub.send({ type: "pin_state", pinned, by: pinnedBy });
      return { ok: true, pinned };
    },

    attach(ws, blob) {
      if (disposed) throw new Error("session already disposed");
      if (pinTimer) { clearTimeout(pinTimer); pinTimer = null; }
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; log?.("live_reattach", key, "grace cancelled - a viewer is back"); }
      sockets.add(ws);
      const res = join(presence, ws, blob);
      log?.("live_attach", key, `${blob.username || "?"} as ${res.role}${res.reclaimed ? " (reclaimed)" : ""}; ${sockets.size} socket(s)`);
      hub.broadcastPresence();
      return res;
    },

    detach(ws) {
      if (!sockets.has(ws)) return;
      sockets.delete(ws);
      const l = leave(presence, ws, (held) => {
        // Reclaim grace expired with the owner still gone: the seat is vacant.
        onOwnerChange(null, `${held.display} did not return`);
        hub.broadcastPresence();
      });
      log?.("live_detach", key, `${sockets.size} socket(s) left${l.wasOwner ? "; owner gone, seat held" : ""}`);
      hub.broadcastPresence();
      if (sockets.size > 0 || disposed) return;
      if (pinned) {
        log?.("live_unwatched", key, `no viewers; PINNED by ${pinnedBy} - kept alive (hard cap ${Math.round(PIN_MAX_MS / 3600000)}h)`);
        if (!pinTimer) {
          pinTimer = setTimeout(() => { pinTimer = null; if (sockets.size === 0) hub.dispose("pinned session: nobody returned within the hard cap"); }, PIN_MAX_MS);
          if (pinTimer.unref) pinTimer.unref();
        }
        return;
      }
      if (graceMs <= 0) { log?.("live_unwatched", key, "no viewers; kept alive (grace = never)"); return; }
      log?.("live_unwatched", key, `no viewers; disposing in ${Math.round(graceMs / 1000)}s unless someone returns`);
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (sockets.size === 0) hub.dispose("no viewer returned within the grace period");
      }, graceMs);
      if (graceTimer.unref) graceTimer.unref();
    },

    canDrive(ws) { return presenceCanDrive(presence, ws); },
    isOwner(ws) { return isOwner(presence, ws); },
    ownerDisplay() { return presence.owner ? presence.owner.display : null; },

    /** A viewer sent a frame that would drive the session. Say no, on the server. */
    refuse(ws, what) {
      hub.sendTo(ws, {
        type: "readonly_refused",
        what,
        owner: hub.ownerDisplay(),
        message: presence.owner
          ? `Read-only: ${presence.owner.display} is driving this session. Use Take over to drive it yourself.`
          : "Read-only: nobody is driving this session yet - press Take over to drive it.",
      });
    },

    /** Take-over request from a viewer. Enforces live-presence rules 3-7. */
    takeover(ws) {
      const r = requestTakeover(presence, ws);
      if (r.result === "granted") {
        onOwnerChange(presence.owner, r.reason || "took over");
        hub.broadcastPresence();
      } else if (r.result === "pending") {
        // Ask the admin owner. No answer = denied (rule 6).
        markPending(presence, ws, () => {
          hub.sendTo(ws, { type: "takeover_result", result: "denied", reason: "the current driver did not answer" });
          hub.broadcastPresence();
        });
        hub.sendTo(presence.ownerSocket, {
          type: "takeover_request",
          from: { username: presence.pending.from.username, display: presence.pending.from.display },
          timeout_s: Math.round(CONSENT_TIMEOUT_MS / 1000),
        });
        hub.broadcastPresence();
      }
      hub.sendTo(ws, { type: "takeover_result", result: r.result, reason: r.reason || "" });
      return r;
    },

    /** The admin owner answered a pending request. */
    respondTakeover(ws, approve) {
      const before = presence.pending ? presence.pending.ws : null;
      const r = respondTakeover(presence, ws, !!approve);
      if (r && r.result === "granted") onOwnerChange(presence.owner, "hand-over approved");
      if (before) hub.sendTo(before, { type: "takeover_result", result: r?.result || "denied", reason: r?.reason || "" });
      hub.broadcastPresence();
      return r;
    },

    dispose(reason) {
      if (disposed) return;
      disposed = true;
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      if (pinTimer) { clearTimeout(pinTimer); pinTimer = null; }
      for (const k of keys) LIVE.delete(k);
      log?.("live_dispose", key, reason || "");
      try { onDispose(reason); } catch (e) { log?.("live_dispose_error", key, String(e?.message || e)); }
      for (const ws of sockets) { try { ws.close(1000, "session ended"); } catch {} }
      sockets.clear();
    },
  };
  for (const k of keys) LIVE.set(k, hub);
  return hub;
}

/** Frames that DRIVE the session. Everything else (queue_history, takeover...) is a viewer's right. */
export const DRIVING_FRAMES = new Set([
  "prompt", "steer", "abort", "approve", "deny", "compact",
  "set_autoapprove", "set_readonly", "set_model", "set_group", "set_label",
  "set_autocredential", "set_allow_email",
  "queue_add", "queue_edit", "queue_remove", "queue_run_next", "queue_set_auto",
  "queue_set_auto_clear", "queue_pause", "queue_resume", "queue_clear_done", "queue_clear",
  "queue_answer", "queue_dismiss", "queue_clear_history", "queue_set_status",
]);
