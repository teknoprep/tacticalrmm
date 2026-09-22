// PROMPT QUEUE - a per-conversation to-do list that can drive the chat.
//
// The technician writes down what they want done next while the current turn runs.
// Each entry is a plain prompt; with Auto-Next on, the head of the queue is sent as soon
// as the conversation is idle, and the next one after that, until the queue is empty or
// something needs a human:
//
//   * the model calls `pause_queue(question)` because it cannot proceed without a
//     decision (the ONLY reliable signal - a trailing "?" in prose is not one: "Fixed.
//     Want me to restart the spooler too?" ends most successful turns);
//   * the provider rejected the turn (the bridge's non-recoverable error path);
//   * the operator pressed Stop.
//
// Approvals and the credential gate need no special case: they block INSIDE a turn, and
// the queue only ever advances between turns.
//
// Scope is the CONVERSATION (session id), stored next to the session index so it
// survives refresh, reconnect and "Continue" from AI History, and is empty for a new
// chat. On reopen the queue never fires by itself - it comes back paused with a reason
// the panel shows, and one click resumes it. A window that vanished mid-run must not
// keep sending prompts nobody is watching: approvals would hang until idle disposal.
//
// Persistence is a JSON file per session (sessions/<scope>/queue/<session>.json), same
// pattern as window-memory.js. Side-effect free apart from that file, so it is testable.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CONFIG } from "./config.js";

export const QUEUE_MAX_ITEMS = Number(process.env.PI_QUEUE_MAX_ITEMS || 100);
export const QUEUE_MAX_TEXT = Number(process.env.PI_QUEUE_MAX_TEXT || 8000);
// The history is no longer only "what the queue did": since 2026-09-14 it records EVERY
// prompt that reached the model in this conversation, whoever sent it and from where (see
// notePrompt). That is what an operator means by "the history" - a chat that scrolled
// past, or was summarised away by /compact, still has to be answerable for what it was
// asked. Hence a much larger cap; it is only ever read by a human, never by the model.
export const QUEUE_MAX_HISTORY = Number(process.env.PI_QUEUE_MAX_HISTORY || 5000);
// Per entry. Prompts can be long; the history is a record of WHAT was asked, and 4k of a
// pasted log adds nothing a human will read.
export const QUEUE_HISTORY_TEXT = Number(process.env.PI_QUEUE_HISTORY_TEXT || 2000);
// A name, not an essay. Long enough for "Firstname Lastname (username)" shapes.
const ACTOR_MAX = 150;

/**
 * WHO DID IT.
 *
 * A live session is shared: one person drives, others watch, the seat is handed over, and
 * a paired phone is another socket on the same conversation. So "the operator" is not one
 * person over the life of a chat, and a history that only says WHAT was asked cannot
 * answer the question an admin actually has - who asked it. Every row therefore carries
 * the person responsible for it: `user` (the login, stable, what you search on) and `by`
 * (their display name, what a human reads).
 *
 * Rows with no actor are the AI's own or the bridge's (a question from the model, a
 * provider failure) and are left blank rather than being attributed to whoever was
 * watching at the time.
 */
function actorOf(a) {
  if (!a || typeof a !== "object") return null;
  const user = String(a.user || a.username || "").slice(0, ACTOR_MAX);
  const display = String(a.display || a.user_display || user || "").slice(0, ACTOR_MAX);
  if (!user && !display) return null;
  return { user, display };
}

// "waiting" = the assistant asked a question on this item and is waiting for the answer.
// It is the one state auto-clear never touches: the question IS the work in progress.
const STATUSES = new Set(["pending", "running", "waiting", "done", "failed", "skipped"]);

function queuePath(root, scopeKey, sessionId) {
  const dir = path.join(root, scopeKey, "queue");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.json`);
}

// WHERE A QUEUED ITEM'S IMAGES LIVE.
//
// Images are kept in a per-item sidecar file, NOT in the queue state, because the state
// file is rewritten on every publish (a queue tick, a status change, an answer) and a
// couple of 8 MB screenshots inlined there would turn each of those into a multi-megabyte
// disk write. Text attachments need no storage at all: they are inlined into the prompt
// text at queue time, exactly as they are for a typed prompt.
function attachPath(root, scopeKey, sessionId, itemId) {
  const dir = path.join(root, scopeKey, "queue", "attachments");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.${itemId}.json`);
}

// An item that no longer exists must not leave megabytes of screenshots behind.
function dropAttachments(root, scopeKey, sessionId, itemId) {
  try { fs.unlinkSync(attachPath(root, scopeKey, sessionId, itemId)); } catch { /* none, or already gone */ }
}

// AUTO-CLEAR DEFAULTS ON (owner, 2026-09-22): "auto clear should always be selected by
// default unless that chat window turned it off, which should be persistent".
//
// It only decides whether a FINISHED item leaves the list, so ON is the tidy default and
// OFF is the deliberate choice - which means the stored value alone is not enough to go
// on. `auto_clear_set` records that a PERSON chose; without it the default applies, so
// state written before this change (when the default was OFF and every file therefore
// said false) does not read as forty windows having asked for it off.
function emptyState(autoClearDefault = true) {
  return { version: 1, auto_next: false, auto_clear_done: !!autoClearDefault, auto_clear_set: false, paused: null, items: [], questions: [], history: [], prompts_backfilled: false };
}

function sanitize(raw, autoClearDefault = true) {
  const st = emptyState(autoClearDefault);
  if (!raw || typeof raw !== "object") return st;
  st.auto_next = !!raw.auto_next;
  // Only an explicit choice survives; anything else takes this window's default.
  st.auto_clear_set = !!raw.auto_clear_set;
  st.auto_clear_done = st.auto_clear_set ? !!raw.auto_clear_done : !!autoClearDefault;
  st.paused = raw.paused && typeof raw.paused === "object" && raw.paused.reason
    ? { reason: String(raw.paused.reason).slice(0, 1000), at: raw.paused.at || null, by: raw.paused.by || "system", who: typeof raw.paused.who === "string" ? raw.paused.who.slice(0, ACTOR_MAX) : "" }
    : null;
  for (const it of Array.isArray(raw.items) ? raw.items : []) {
    if (!it || typeof it !== "object" || !it.id || typeof it.text !== "string") continue;
    st.items.push({
      id: String(it.id),
      text: it.text.slice(0, QUEUE_MAX_TEXT),
      // Who queued (or typed) it - carried so the history rows this item generates later
      // (started, done, failed) name the person whose work it is, not whoever is watching
      // the window when it eventually runs.
      by: typeof it.by === "string" ? it.by.slice(0, ACTOR_MAX) : "",
      user: typeof it.user === "string" ? it.user.slice(0, ACTOR_MAX) : "",
      compact_first: !!it.compact_first,
      status: STATUSES.has(it.status) ? it.status : "pending",
      added_at: it.added_at || null,
      started_at: it.started_at || null,
      ended_at: it.ended_at || null,
      note: typeof it.note === "string" ? it.note.slice(0, 500) : "",
      // The conversation ON this item: the assistant's questions and the operator's
      // answers, in order, so "where are we with this one" is answered in the list.
      thread: Array.isArray(it.thread)
        ? it.thread
            .filter((t) => t && typeof t.text === "string" && (t.role === "assistant" || t.role === "operator"))
            .map((t) => ({ role: t.role, text: t.text.slice(0, 4000), at: t.at || null, via: t.via || undefined, by: typeof t.by === "string" ? t.by.slice(0, ACTOR_MAX) : undefined }))
        : [],
    });
  }
  // OPEN QUESTIONS - what the assistant is waiting on. Shown at the top of the queue
  // panel, each with its own answer box. `item_id` ties it to a queued item when the
  // question came up while that item ran; null when it came up in ordinary chat.
  for (const q of Array.isArray(raw.questions) ? raw.questions : []) {
    if (!q || typeof q !== "object" || !q.id || typeof q.text !== "string") continue;
    st.questions.push({
      id: String(q.id),
      item_id: q.item_id ? String(q.item_id) : null,
      text: q.text.slice(0, 4000),
      at: q.at || null,
    });
  }
  // HISTORY - everything the queue did, for the human. Never reaches the model: it is
  // only ever in this file and in queue_state frames to the window.
  for (const h of Array.isArray(raw.history) ? raw.history : []) {
    if (!h || typeof h !== "object" || typeof h.event !== "string") continue;
    st.history.push({
      at: h.at || null,
      event: h.event.slice(0, 40),
      text: typeof h.text === "string" ? h.text.slice(0, 4000) : "",
      detail: typeof h.detail === "string" ? h.detail.slice(0, 4000) : "",
      item_id: h.item_id ? String(h.item_id) : null,
      // Blank on rows written before the history recorded who sent them, and on the AI's
      // own rows. The window shows "unknown" rather than guessing.
      by: typeof h.by === "string" ? h.by.slice(0, ACTOR_MAX) : "",
      user: typeof h.user === "string" ? h.user.slice(0, ACTOR_MAX) : "",
    });
  }
  if (st.history.length > QUEUE_MAX_HISTORY) st.history = st.history.slice(-QUEUE_MAX_HISTORY);
  st.prompts_backfilled = !!raw.prompts_backfilled;
  return st;
}

/** Prompt paragraph that tells the model the queue exists and how to stop it. */
export function queuePromptSection() {
  return (
    "\n\nQUESTIONS FOR THE OPERATOR: whenever you cannot continue without a decision or a piece " +
    "of information from the operator, call pause_queue with the exact question (one call per " +
    "question). It posts the question to the operator's Queue panel, where they answer it in a " +
    "form, and it holds any queued follow-up prompts until they do. Still state the question " +
    "in your reply as well. Do not call it when you have simply finished; do not call it for " +
    "rhetorical or optional offers (\"want me to also...\")."
  );
}

/**
 * @param {object}   o
 * @param {string}   o.scopeKey     agent_id (device chat) or ticket key (decision chat)
 * @param {function} o.send         push a frame to the window
 * @param {function} o.log
 * @param {function} o.runPrompt    (text) => Promise; resolves when the turn has settled
 * @param {function} o.compact      (reason) => Promise; summarise & clear before a prompt
 * @param {function} o.isStreaming  () => boolean
 * @param {string}   [o.root]       sessions root (tests override)
 */
export function makePromptQueue({ scopeKey, send, log, runPrompt, compact, isStreaming, root = CONFIG.sessionsRoot,
  // The SAME intake the composer uses (attachments.js): byte-sniffing, size caps, images
  // only when the model accepts them, and a spoken refusal for anything it will not take.
  // Injected rather than imported so the queue keeps no opinion about attachments.
  intake = null, compose = (text) => text,
  // AUTO-CLEAR. On unless THIS window has been told otherwise - the caller reads that from
  // window-memory.js (recallSwitch) so the choice outlives the session, the socket and the
  // bridge, and reports it back through onSwitch when someone flips it.
  autoClearDefault = true, onSwitch = null }) {
  let sessionId = null;
  let inherited = "";        // the session id this queue was carried over from, if any
  let file = null;
  let st = emptyState(autoClearDefault);
  let detached = false;
  let engineBusy = false;
  let runningId = null;

  const now = () => new Date().toISOString();
  const key = () => `${scopeKey} ${sessionId || "-"}`;

  function persist() {
    if (!file) return;
    try { fs.writeFileSync(file, JSON.stringify(st, null, 2)); }
    catch (e) { log?.("queue_persist_error", key(), String(e?.message || e).slice(0, 200)); }
  }

  function snapshot() {
    const pending = st.items.filter((i) => i.status === "pending").length;
    return {
      type: "queue_state",
      auto_next: st.auto_next,
      auto_clear_done: st.auto_clear_done,
      paused: st.paused,
      running_id: runningId,
      pending,
      items: st.items.map(({ pending_question, ...i }) => ({ ...i })),
      questions: st.questions.map((q) => ({ ...q })),
      // COUNT ONLY. queue_state is sent on every queue change, and the history now holds
      // every prompt of the conversation - shipping all of it on each frame would put
      // hundreds of KB on the socket repeatedly, which is exactly what once starved the
      // heartbeat and made chats "keep disconnecting" (see transcript-bound.js). The
      // window asks for the list when the operator opens it, and gets it fresh.
      history_count: st.history.length,
    };
  }

  function publish() {
    persist();
    try { send(snapshot()); } catch { /* socket gone */ }
  }

  /** The full history, on request. Oldest first; the window reverses it for display. */
  function sendHistory() {
    try {
      send({
        type: "queue_history",
        count: st.history.length,
        history: st.history.map((h) => ({ ...h })),
      });
    } catch { /* socket gone */ }
  }

  /**
   * Append to the human-facing history. `text` is what it was about (the prompt or the
   * question), `detail` how it went (the answer, the failure, who did it). Capped so a
   * long-lived conversation cannot grow the file without bound.
   */
  function record(event, { text = "", detail = "", item = null, actor = null } = {}) {
    // Explicit actor first (the socket that sent this frame), then the item's owner - so
    // "started/done/failed" on a queued prompt is attributed to whoever queued it, hours
    // later and whoever is watching by then. `actor: false` means "nobody": the row is
    // the AI's or the bridge's, and must not borrow the item owner's name.
    const who = actor === false
      ? null
      : actorOf(actor) || actorOf(item ? { user: item.user, display: item.by } : null);
    st.history.push({
      at: now(),
      event,
      text: String(text || "").slice(0, QUEUE_HISTORY_TEXT),
      detail: String(detail || "").slice(0, QUEUE_HISTORY_TEXT),
      item_id: item ? item.id : null,
      by: who ? who.display : "",
      user: who ? who.user : "",
    });
    if (st.history.length > QUEUE_MAX_HISTORY) st.history.splice(0, st.history.length - QUEUE_MAX_HISTORY);
  }

  function pause(reason, by = "system", actor = null) {
    if (st.paused && !(by === "assistant" && st.paused.by === "assistant")) return;
    const who = actorOf(actor);
    st.paused = { reason: String(reason || "paused").slice(0, 1000), at: now(), by, who: who ? who.display : "" };
    log?.("queue_paused", key(), `${who ? who.display : by}: ${st.paused.reason.slice(0, 200)}`);
    if (by !== "assistant") record("paused", { text: st.paused.reason, detail: `by ${who ? who.display : by}`, actor: who });
  }

  function nextPending() {
    return st.items.find((i) => i.status === "pending") || null;
  }

  /**
   * Send one prompt on behalf of an item and settle its status afterwards. `text` is the
   * item's own prompt the first time, and the operator's answer when the item was
   * waiting on a question.
   */
  async function runItem(item, text = item.text, { isReply = false } = {}) {
    engineBusy = true;
    runningId = item.id;
    item.status = "running";
    if (!isReply) item.started_at = now();
    item.note = "";
    item.pending_question = null;
    const position = st.items.indexOf(item) + 1;
    log?.("queue_run", key(), `${position}/${st.items.length}${isReply ? " (reply)" : ""}: ${text.slice(0, 120)}`);
    record(isReply ? "answer_sent" : "started", { text, detail: isReply ? `continuing: ${item.text.slice(0, 200)}` : (item.compact_first ? "compact & clear first" : ""), item });
    publish();
    try {
      if (item.compact_first && !isReply) {
        // "Compact & clear first": the technician wants this item to start from a
        // summary, not from the whole transcript. compact() reports its own outcome to
        // the window; "nothing to compact" is not a failure for us.
        await compact(`queue: ${item.text.slice(0, 80)}`);
      }
      if (detached) throw new Error("window closed");
      send({ type: "queue_started", id: item.id, text, reply: isReply });
      // The files queued WITH this prompt, read back at the moment it runs.
      let images = [];
      if (!isReply && item.images) {
        try { images = JSON.parse(fs.readFileSync(attachPath(root, scopeKey, sessionId, item.id), "utf8")); }
        catch { images = []; }
        if (!images.length) {
          // Never silent: the operator queued a screenshot and the model is about to answer
          // without it, which is worse than refusing.
          send({ type: "error", message: `The ${item.images} image(s) queued with "${item.text.slice(0, 40)}" could not be read back - answering without them.` });
        }
      }
      await runPrompt(text, images);
      if (item.status === "failed") {
        // noteError() already marked it and paused the queue.
      } else if (st.questions.some((q) => q.item_id === item.id)) {
        // The assistant asked. The item is not finished - it is waiting for the answer
        // (the question itself sits at the top of the panel, with its answer box).
        item.status = "waiting";
        item.note = "";
      } else {
        item.status = "done";
        record("done", { text: item.text, item });
      }
    } catch (e) {
      const why = String(e?.message || e).slice(0, 300);
      item.status = "failed";
      item.note = why;
      record("failed", { text: item.text, detail: why, item });
      pause(`"${item.text.slice(0, 60)}" failed: ${why}`);
    } finally {
      item.pending_question = null;
      item.ended_at = now();
      runningId = null;
      engineBusy = false;
      // Auto-clear: a finished item leaves the list on its own. Only a plain "done" goes -
      // failed, skipped and waiting ones still need the technician.
      //
      // A done item that carried a question-and-answer USED to be kept back, so its trail
      // stayed visible. That is why "auto clear is on, but it doesn't auto clear" (owner,
      // 2026-09-22): most finished work has a question in it somewhere, so most items sat
      // there with the switch on, and enabling the switch swept them anyway (below) - the
      // two paths disagreed. The trail is not lost by clearing: the question, the answer,
      // the time and who gave it are all in the history, which is one click away.
      if (st.auto_clear_done && item.status === "done") {
        st.items = st.items.filter((i) => i.id !== item.id);
        if (item.images) dropAttachments(root, scopeKey, sessionId, item.id);
        record("auto_cleared", { text: item.text, item });
      }
      publish();
    }
  }

  /**
   * Try to send the next queued prompt. Safe to call any time: it does nothing unless
   * Auto-Next is on, nothing is paused, the conversation is idle and an item is pending.
   */
  async function advance(trigger = "") {
    if (detached || engineBusy) return false;
    if (!st.auto_next || st.paused) return false;
    if (typeof isStreaming === "function" && isStreaming()) return false;
    const item = nextPending();
    if (!item) return false;
    if (trigger) log?.("queue_advance", key(), trigger);
    await runItem(item);
    // Chain: the item settled; if nothing paused us, go again.
    setImmediate(() => { advance("chain").catch(() => {}); });
    return true;
  }

  const queue = {
    /** Two-phase start: the session id exists only after createAgentSession(). */
    /**
     * Bind the queue to this session instance.
     *
     * @param {string} sid           the live session id
     * @param {string} inheritFrom   the id this session was RESUMED from, if any
     *
     * THE QUEUE BELONGS TO THE CONVERSATION, NOT TO THE PROCESS. Resuming a conversation
     * mints a NEW session id (the harness assigns it), and the queue state was written
     * under the OLD one - so every reconnect, and therefore every one of our deploys,
     * silently abandoned the queue: items gone, pause state gone, history gone, nothing
     * left to resume. The work was on disk the whole time, under a filename nobody looked
     * at again.
     *
     * So a session that resumed another one inherits its queue and re-persists it under
     * the new id. Only when this session has NO state of its own, so a real queue is
     * never overwritten by an older one.
     */
    attach(sid, inheritFrom = "") {
      sessionId = String(sid);
      file = queuePath(root, scopeKey, sessionId);
      try { st = sanitize(JSON.parse(fs.readFileSync(file, "utf8")), autoClearDefault); }
      catch { st = null; }
      if (!st && inheritFrom && String(inheritFrom) !== sessionId) {
        try {
          st = sanitize(JSON.parse(fs.readFileSync(queuePath(root, scopeKey, String(inheritFrom)), "utf8")), autoClearDefault);
          inherited = String(inheritFrom);
        } catch { st = null; }
      }
      if (!st) st = emptyState(autoClearDefault);
      // A session that was mid-run when its window went away must not restart on its
      // own. Any item still "running" from that life is a pending one now.
      //
      // It also means the work was INTERRUPTED - the bridge was restarted (we deploy
      // often), the server bounced, or the connection dropped mid-answer. That is not the
      // same as reopening a window, and it must not be silent: the operator is told what
      // was in flight and asked whether to run it again. Their call, not ours - re-running
      // a turn costs money and may repeat an action.
      const interrupted = st.items.filter((it) => it.status === "running");
      for (const it of interrupted) {
        it.status = "pending";
        it.started_at = null;
        it.note = "interrupted - the session stopped while this was running";
        record("interrupted", { text: it.text, detail: "the session stopped while this was running", item: it });
      }
      if (interrupted.length) {
        const what = interrupted[interrupted.length - 1].text.replace(/\s+/g, " ").slice(0, 160);
        pause(
          `Interrupted: "${what}" was still running when this session stopped (a server restart or a dropped ` +
          `connection). Press Resume to run it again, or skip it in the queue.`,
          "system",
        );
      } else if (st.auto_next && nextPending() && !st.paused) {
        pause("Window reopened - press Resume to continue the queue", "system");
      }
      if (inherited) {
        record("resumed", { text: "Queue carried over from the previous session", detail: inherited.slice(0, 8) });
      }
      // WITH THE SWITCH ON, A REOPENED WINDOW STARTS TIDY TOO. Items that finished while
      // the rule was different (or before Auto-clear was turned on) would otherwise sit
      // there for good, which is exactly what "auto clear is on but it doesn't auto clear"
      // looked like. Only plain "done" goes; failed, skipped and waiting still need a human.
      if (st.auto_clear_done) {
        for (const it of st.items.filter((i) => i.status === "done")) {
          if (it.images) dropAttachments(root, scopeKey, sessionId, it.id);
          record("auto_cleared", { text: it.text, item: it });
        }
        st.items = st.items.filter((i) => i.status !== "done");
      }
      publish();
    },

    /**
     * One-time repair for conversations that predate prompt recording.
     *
     * Every prompt is recorded from now on (notePrompt), but a conversation that has been
     * running for a week would still open showing only the handful of queue events from
     * its early days - which is precisely the complaint. The transcript already holds
     * every prompt, so the history is rebuilt from it once, in time order, and the flag
     * stops it ever being done twice.
     *
     * @param {Array<{at?:string, text:string}>} prompts  oldest first, from the session file
     */
    backfillPrompts(prompts) {
      if (st.prompts_backfilled) return 0;
      st.prompts_backfilled = true;
      const list = (Array.isArray(prompts) ? prompts : [])
        .map((p) => ({ at: p?.at || null, text: String(p?.text || "").trim() }))
        .filter((p) => p.text);
      if (!list.length) { persist(); return 0; }
      const rows = list.map((p) => ({
        at: p.at,
        event: "prompt",
        text: p.text.slice(0, QUEUE_HISTORY_TEXT),
        detail: "recovered from the transcript",
        item_id: null,
        // The transcript does not say who typed these, and a guess in an audit is worse
        // than a blank: the window shows them as "unknown".
        by: "",
        user: "",
      }));
      // Merge, oldest first: the recovered prompts belong BETWEEN the queue events that
      // already have timestamps, not bolted on at either end.
      st.history = [...st.history, ...rows].sort((a, b) =>
        String(a.at || "").localeCompare(String(b.at || "")),
      );
      if (st.history.length > QUEUE_MAX_HISTORY) {
        st.history = st.history.slice(-QUEUE_MAX_HISTORY);
      }
      log?.("queue_history_backfill", key(), `${rows.length} prompt(s) recovered`);
      publish();
      return rows.length;
    },

    detach() { detached = true; persist(); },

    state: snapshot,
    publish,
    advance,

    /** The operator typed something (not a window command). If we were waiting on
     *  them, that is the answer: clear the pause so the queue continues after this turn. */
    noteOperatorReply(text = "", actor = null) {
      if (!st.paused && !st.questions.length) return;
      const who = actorOf(actor);
      st.paused = null;
      // A reply typed in the chat answers whatever was open. If a question belonged to a
      // queued item, the answer is recorded on that item and it counts as done, so the
      // trail is complete wherever the technician chose to type.
      for (const q of st.questions) {
        const it = q.item_id ? st.items.find((i) => i.id === q.item_id) : null;
        if (it) {
          it.thread.push({ role: "operator", text: String(text || "").slice(0, 4000), at: now(), via: "chat", by: who ? who.display : undefined });
          if (it.status === "waiting") { it.status = "done"; it.ended_at = now(); }
        }
        // The ANSWER is this person's, even when the item was queued by someone else.
        record("answered_in_chat", { text: q.text, detail: String(text || ""), item: it, actor: who });
      }
      st.questions = [];
      log?.("queue_resumed", key(), "operator replied in chat");
      publish();
    },

    /**
     * A prompt reached the model. EVERY one is recorded here - typed in the chat, sent
     * from a paired phone, or steered into a running turn - because the queue panel's
     * History is where an operator goes to answer "what was this conversation asked?".
     * Until now it only showed what the QUEUE did, so a conversation driven by typing
     * (which is most of them) showed a handful of entries and looked empty or stale.
     *
     * Queue-driven prompts are skipped: they are already recorded as `started` /
     * `answer_sent`, with the item they belong to.
     */
    /**
     * A prompt TYPED IN THE CHAT becomes the active queue item (owner's ruling 2026-09-16).
     *
     * Before this, typing in the chat and queueing work were two different worlds: a typed
     * prompt ran immediately and left only a line in the history, so if the bridge restarted
     * mid-answer the window came back with no record of what was being worked and nothing to
     * resume. The queue is meant to be the list of what this conversation is doing - so what
     * you type IS the active item.
     *
     * The chat still runs it (the caller owns the turn); this only makes it visible and
     * resumable. Steers are excluded: a steer edits the turn in flight rather than being a
     * new piece of work, and would otherwise duplicate the item already running.
     *
     * @returns {string} item id, to settle later. "" when nothing was recorded.
     */
    beginTypedItem(text, origin = "browser", actor = null) {
      const body = String(text || "").trim();
      if (!body || origin === "queue") return "";
      const who = actorOf(actor);
      // The chat is driving this turn, so an item created here is already running: it must
      // not be picked up a second time by advance().
      const item = {
        id: randomUUID(), text: body.slice(0, 4000), compact_first: false, status: "running",
        typed: true, origin, note: "", thread: [], created_at: now(), started_at: now(), ended_at: null,
        by: who ? who.display : "", user: who ? who.user : "",
      };
      st.items.push(item);
      if (st.items.length > QUEUE_MAX_ITEMS) st.items.splice(0, st.items.length - QUEUE_MAX_ITEMS);
      runningId = item.id;
      record("started", { text: item.text, detail: origin === "phone" ? "typed on the phone" : "typed in the chat", item, actor: who });
      publish();
      return item.id;
    },

    /** The typed turn finished (or died). Settles the item the chat was running. */
    settleTypedItem(id, ok, note = "") {
      if (!id) return;
      const it = st.items.find((i) => i.id === id);
      if (!it || it.status !== "running") return;
      it.status = ok ? "done" : "failed";
      it.note = String(note || "").slice(0, 300);
      it.ended_at = now();
      if (runningId === id) runningId = null;
      record(ok ? "done" : "failed", { text: it.text, detail: it.note, item: it });
      // Same rule as a queued item (see runItem): with the switch on, a finished prompt
      // leaves the list whether or not the assistant asked something along the way.
      if (st.auto_clear_done && it.status === "done") {
        st.items = st.items.filter((x) => x.id !== it.id);
        if (it.images) dropAttachments(root, scopeKey, sessionId, it.id);
        record("auto_cleared", { text: it.text, item: it });
      }
      publish();
    },

    notePrompt(text, origin = "browser", { steer = false, actor = null } = {}) {
      if (origin === "queue") return;
      // An attached text file is INLINED into the prompt between sentinels
      // (attachments.js). The history wants "what was asked", not 200 KB of pasted log,
      // so the bodies come out and the fact of the attachment stays.
      const raw = String(text || "");
      const names = [];
      const body = raw
        .replace(/\[\[pi-attachment:([^\]|]*)\|(\d+)\]\]\n?[\s\S]*?\[\[\/pi-attachment\]\]/g,
          (_m, name) => { names.push(name); return ""; })
        .replace(/The technician attached \d+ file\(s\)\. Their full contents follow[^\n]*\n?/g, "")
        .trim();
      if (!body && !names.length) return;
      const from = origin === "phone" ? "from the paired phone" : "";
      const attached = names.length ? `with ${names.join(", ")}` : "";
      record(steer ? "steer" : (origin === "phone" ? "prompt_phone" : "prompt"), {
        text: body || "(attachment only)",
        detail: [from, attached].filter(Boolean).join(" \u00b7 "),
        actor,
      });
      publish();
    },

    /** Operator pressed Stop. */
    noteAbort(actor = null) {
      if (!st.auto_next && !runningId) return;
      const who = actorOf(actor);
      const it = st.items.find((i) => i.id === runningId);
      // The STOP belongs to whoever pressed it, which is not necessarily the person whose
      // prompt was running - that is exactly the kind of thing an admin is looking for.
      if (it) { it.status = "failed"; it.note = `stopped by ${who ? who.display : "operator"}`; record("stopped", { text: it.text, detail: `by ${who ? who.display : "operator"}`, item: it, actor: who }); }
      pause("Stopped by the operator", "operator", who);
      publish();
    },

    /** The bridge gave up on a turn (non-recoverable provider error). */
    noteError(why) {
      if (!st.auto_next && !runningId) return;
      const it = st.items.find((i) => i.id === runningId);
      if (it) { it.status = "failed"; it.note = String(why || "error").slice(0, 300); record("failed", { text: it.text, detail: String(why || "error"), item: it }); }
      pause(`Provider error: ${String(why || "unknown").slice(0, 300)}`, "system");
      publish();
    },

    /** Model asked to stop (pause_queue tool). Returns the tool's reply text. */
    pauseByModel(raw) {
      const question = String(raw || "").trim().slice(0, 4000) || "The assistant needs a decision before continuing";
      const it = st.items.find((i) => i.id === runningId) || null;
      // One card per question. A repeat of an open question is not a second card.
      if (!st.questions.some((q) => q.text === question && q.item_id === (it ? it.id : null))) {
        st.questions.push({ id: randomUUID(), item_id: it ? it.id : null, text: question, at: now() });
        if (it) it.thread.push({ role: "assistant", text: question, at: now() });
        // The AI asked this, not the person whose item it came up on.
        record("asked", { text: question, detail: it ? `while running: ${it.text.slice(0, 200)}` : "in chat", item: it, actor: false });
      }
      pause(question, "assistant");
      log?.("queue_question", key(), `${it ? "on item" : "standalone"}: ${question.slice(0, 160)}`);
      publish();
      return "Question posted to the operator's Queue panel. Queued prompts are held until they answer there or in the chat. State the question plainly in your reply too.";
    },

    /** Tool the model calls when it needs a human decision. */
    tool: defineTool({
      name: "pause_queue",
      label: "Pause the prompt queue",
      description:
        "Ask the operator a question you need answered before you can continue: it is posted " +
        "to their Queue panel as a form to fill in, and any queued follow-up prompts are held " +
        "until they answer. One call per question. Also state the question in your reply. Do " +
        "not call it when you have simply finished, or for optional offers.",
      parameters: Type.Object({
        question: Type.String({ description: "The exact question or decision you need from the operator." }),
      }),
      execute: async (_id, p) => ({
        content: [{ type: "text", text: queue.pauseByModel(p?.question) }],
        details: {},
      }),
    }),

    /**
     * Route a `queue_*` frame from the window. Returns true when it was one of ours.
     *
     * `actor` is the person on the socket that sent the frame ({user, display}); a shared
     * session has several, and the history names the one who did each thing rather than
     * "the operator".
     */
    async handle(msg, actor = null) {
      if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("queue_")) return false;
      const who = actorOf(actor);
      // Every row this frame writes is attributed to its sender. Passing `actor` last
      // would let a call site's own attribution win; it does not - the socket is the
      // authority on who pressed the button.
      const rec = (event, opts = {}) => record(event, { ...opts, actor: who });
      switch (msg.type) {
        case "queue_add": {
          // ATTACHMENTS ON A QUEUED PROMPT. Screenshots and logs are often the whole point
          // of the request ("fix what this error says"), and until now they could only be
          // sent with a prompt typed right now - so queueing work meant losing the evidence.
          // Processed at ADD time, not run time, so a refusal is reported while the operator
          // is still looking at the window instead of an hour later.
          const att = intake ? intake(msg) : { images: [], text: "", accepted: [], rejected: [] };
          const text = String(compose(String(msg.text || ""), att.text) || "").trim().slice(0, QUEUE_MAX_TEXT);
          if (!text) {
            // A file on its own is evidence, not an instruction. Queueing it with no words
            // would mean an item nobody can read and a model guessing what to do with a
            // screenshot an hour later - so say what is missing instead of dropping it.
            if ((att.accepted || []).length) {
              send({ type: "error", message: "Say what you want done with " +
                att.accepted.map((a) => a.name).join(", ") + " - a queued prompt needs words as well as the file." });
            }
            break;
          }
          if (st.items.length >= QUEUE_MAX_ITEMS) {
            send({ type: "error", message: `The queue is full (${QUEUE_MAX_ITEMS} items). Clear finished items first.` });
            break;
          }
          const added = {
            id: randomUUID(), text, compact_first: !!msg.compact_first, status: "pending",
            added_at: now(), started_at: null, ended_at: null, note: "", thread: [],
            // Stamped now, so when this runs in an hour the history still knows whose
            // work it was (see sanitize()).
            by: who ? who.display : "", user: who ? who.user : "",
            // Metadata only - enough for the window to show chips, with no payload in the
            // state file. The bytes (if any) are in the sidecar.
            attachments: (att.accepted || []).map((a) => ({ name: a.name, kind: a.kind || (a.mimeType ? "image" : "text"), bytes: a.bytes || 0 })),
          };
          if ((att.images || []).length) {
            try {
              fs.writeFileSync(attachPath(root, scopeKey, sessionId, added.id), JSON.stringify(att.images));
              added.images = att.images.length;
            } catch (e) {
              added.images = 0;
              added.note = "images could not be stored: " + String(e?.message || e).slice(0, 120);
            }
          }
          st.items.push(added);
          rec("added", {
            text,
            detail: [added.compact_first ? "compact & clear first" : "",
                     added.attachments.length ? `with ${added.attachments.map((a) => a.name).join(", ")}` : ""]
              .filter(Boolean).join(" \u00b7 "),
            item: added,
          });
          publish();
          await advance("added");
          break;
        }
        case "queue_update": {
          const it = st.items.find((i) => i.id === msg.id);
          if (!it || it.status === "running") break;
          if (typeof msg.text === "string" && msg.text.trim() && msg.text.trim() !== it.text) {
            rec("edited", { text: msg.text.trim(), detail: `was: ${it.text.slice(0, 500)}`, item: it });
            it.text = msg.text.trim().slice(0, QUEUE_MAX_TEXT);
          }
          if (msg.compact_first !== undefined) it.compact_first = !!msg.compact_first;
          // Re-queue a finished/failed/skipped item ("run it again").
          if (msg.status === "pending" && it.status !== "pending") {
            it.status = "pending"; it.note = ""; it.started_at = null; it.ended_at = null;
            rec("requeued", { text: it.text, item: it });
          }
          if (msg.status === "skipped" && it.status === "pending") { it.status = "skipped"; rec("skipped", { text: it.text, item: it }); }
          publish();
          await advance("updated");
          break;
        }
        case "queue_answer":
        case "queue_reply": {
          // The operator answers a question in the panel. If the question belongs to a
          // queued item the answer runs as that item's continuation (and is recorded on
          // it); otherwise it is simply the next thing said in the chat.
          const text = String(msg.text || "").trim().slice(0, QUEUE_MAX_TEXT);
          if (!text) break;
          const q = msg.type === "queue_answer"
            ? st.questions.find((x) => x.id === msg.id)
            : st.questions.find((x) => x.item_id === msg.id);   // legacy: by item id
          if (!q) break;
          if (engineBusy || (typeof isStreaming === "function" && isStreaming())) {
            send({ type: "error", message: "The assistant is still working - wait for it to finish, then answer." });
            break;
          }
          st.questions = st.questions.filter((x) => x.id !== q.id);
          if (!st.questions.length) st.paused = null;   // the answer is what the pause was waiting for
          const it = q.item_id ? st.items.find((i) => i.id === q.item_id) : null;
          rec("answered", { text: q.text, detail: text, item: it });
          if (it) {
            it.thread.push({ role: "operator", text, at: now(), by: who ? who.display : undefined });
            await runItem(it, text, { isReply: true });
          } else {
            engineBusy = true;
            publish();
            try {
              send({ type: "queue_started", id: null, text, reply: true });
              await runPrompt(text);
            } catch (e) {
              pause(`answer failed: ${String(e?.message || e).slice(0, 200)}`);
            } finally {
              engineBusy = false;
              publish();
            }
          }
          setImmediate(() => { advance("chain").catch(() => {}); });
          break;
        }
        case "queue_dismiss_question": {
          // Drop a question without answering it. Its item, if any, is finished as far as
          // the queue is concerned; the assistant's own reply still carries the question.
          const q = st.questions.find((x) => x.id === msg.id);
          if (!q) break;
          st.questions = st.questions.filter((x) => x.id !== q.id);
          const it = q.item_id ? st.items.find((i) => i.id === q.item_id) : null;
          rec("dismissed", { text: q.text, item: it });
          if (it && it.status === "waiting") { it.status = "done"; it.note = "question dismissed"; it.ended_at = now(); }
          if (!st.questions.length && st.paused?.by === "assistant") st.paused = null;
          publish();
          await advance("question dismissed");
          break;
        }
        case "queue_remove": {
          const i = st.items.findIndex((x) => x.id === msg.id);
          if (i < 0 || st.items[i].status === "running") break;
          rec("removed", { text: st.items[i].text, detail: `was ${st.items[i].status}`, item: st.items[i] });
          if (st.items[i].images) dropAttachments(root, scopeKey, sessionId, st.items[i].id);
          st.items.splice(i, 1);
          publish();
          break;
        }
        case "queue_reorder": {
          // The window sends the full id order. Unknown ids are ignored; ids it left out
          // keep their relative order at the end, so a stale reorder cannot lose an item.
          const want = Array.isArray(msg.ids) ? msg.ids.map(String) : [];
          const byId = new Map(st.items.map((i) => [i.id, i]));
          const next = [];
          for (const id of want) if (byId.has(id)) { next.push(byId.get(id)); byId.delete(id); }
          for (const it of st.items) if (byId.has(it.id)) next.push(it);
          st.items = next;
          publish();
          break;
        }
        case "queue_set_auto": {
          st.auto_next = !!msg.value;
          log?.("queue_auto", key(), st.auto_next ? "on" : "off");
          rec("auto_next", { detail: st.auto_next ? "on" : "off" });
          publish();
          if (st.auto_next) await advance("auto on");
          break;
        }
        case "queue_set_auto_clear": {
          st.auto_clear_done = !!msg.value;
          // A PERSON has now chosen, so the default no longer applies to this
          // conversation - and the choice is remembered for the window, not just this
          // session, so it survives New chat, a refresh and a bridge restart.
          st.auto_clear_set = true;
          // Turning it on also sweeps what is already done, so the list matches the switch.
          if (st.auto_clear_done) st.items = st.items.filter((i) => i.status !== "done");
          rec("auto_clear", { detail: st.auto_clear_done ? "on" : "off" });
          try { onSwitch?.("auto_clear", st.auto_clear_done, who); } catch { /* preference only */ }
          publish();
          break;
        }
        case "queue_pause":
          pause("Paused by the operator", "operator", who);
          publish();
          break;
        case "queue_resume": {
          if (st.paused) rec("resumed", { text: st.paused.reason });
          st.paused = null;
          publish();
          // RESUME MEANS RUN IT. advance() only fires when Auto-Next is on, so with
          // Auto-Next off (the default) pressing Resume cleared the pause and then did
          // NOTHING - the operator saw "Interrupted... press Resume", pressed it, and the
          // work sat there pending with no way to start it but a second, differently
          // named button. Pressing Resume IS the instruction to continue, whatever
          // Auto-Next is set to.
          if (!(await advance("resume"))) {
            const item = nextPending();
            if (item && !engineBusy && !(typeof isStreaming === "function" && isStreaming())) {
              await runItem(item);
              setImmediate(() => { advance("chain").catch(() => {}); });
            }
          }
          break;
        }
        case "queue_run_next": {
          // Run the head item once, regardless of Auto-Next. Same guards otherwise.
          if (engineBusy || (typeof isStreaming === "function" && isStreaming())) {
            send({ type: "error", message: "The assistant is still working - wait for it to finish." });
            break;
          }
          const item = nextPending();
          if (!item) break;
          st.paused = null;
          await runItem(item);
          setImmediate(() => { advance("chain").catch(() => {}); });
          break;
        }
        case "queue_clear_done": {
          const gone = st.items.filter((i) => i.status !== "pending" && i.status !== "running");
          st.items = st.items.filter((i) => i.status === "pending" || i.status === "running");
          if (gone.length) rec("cleared_finished", { detail: `${gone.length} item(s)` });
          publish();
          break;
        }
        case "queue_clear_history":
          st.history = [];
          // Clearing the record is itself a thing that happened, and the one row an admin
          // must never lose: otherwise a wiped history is indistinguishable from a quiet
          // conversation. It is written AFTER the wipe, so it survives it.
          rec("cleared_history", { detail: "history cleared" });
          publish();
          sendHistory();
          break;
        // The window asks for the list when it opens the History dialog, so what it shows
        // is what the file holds RIGHT NOW - not a copy that arrived with an old frame.
        case "queue_history":
          sendHistory();
          break;
        case "queue_clear":
          rec("cleared_all", { detail: `${st.items.length} item(s), ${st.questions.length} question(s)` });
          for (const it of st.items) if (it.images && it.status !== "running") dropAttachments(root, scopeKey, sessionId, it.id);
          st.items = st.items.filter((i) => i.status === "running");
          st.questions = [];
          st.paused = null;
          publish();
          break;
        default:
          return false;
      }
      return true;
    },
  };

  return queue;
}
