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
export const QUEUE_MAX_HISTORY = Number(process.env.PI_QUEUE_MAX_HISTORY || 500);

// "waiting" = the assistant asked a question on this item and is waiting for the answer.
// It is the one state auto-clear never touches: the question IS the work in progress.
const STATUSES = new Set(["pending", "running", "waiting", "done", "failed", "skipped"]);

function queuePath(root, scopeKey, sessionId) {
  const dir = path.join(root, scopeKey, "queue");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.json`);
}

function emptyState() {
  return { version: 1, auto_next: false, auto_clear_done: false, paused: null, items: [], questions: [], history: [] };
}

function sanitize(raw) {
  const st = emptyState();
  if (!raw || typeof raw !== "object") return st;
  st.auto_next = !!raw.auto_next;
  st.auto_clear_done = !!raw.auto_clear_done;
  st.paused = raw.paused && typeof raw.paused === "object" && raw.paused.reason
    ? { reason: String(raw.paused.reason).slice(0, 1000), at: raw.paused.at || null, by: raw.paused.by || "system" }
    : null;
  for (const it of Array.isArray(raw.items) ? raw.items : []) {
    if (!it || typeof it !== "object" || !it.id || typeof it.text !== "string") continue;
    st.items.push({
      id: String(it.id),
      text: it.text.slice(0, QUEUE_MAX_TEXT),
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
            .map((t) => ({ role: t.role, text: t.text.slice(0, 4000), at: t.at || null, via: t.via || undefined }))
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
    });
  }
  if (st.history.length > QUEUE_MAX_HISTORY) st.history = st.history.slice(-QUEUE_MAX_HISTORY);
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
export function makePromptQueue({ scopeKey, send, log, runPrompt, compact, isStreaming, root = CONFIG.sessionsRoot }) {
  let sessionId = null;
  let file = null;
  let st = emptyState();
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
      history: st.history.map((h) => ({ ...h })),
    };
  }

  function publish() {
    persist();
    try { send(snapshot()); } catch { /* socket gone */ }
  }

  /**
   * Append to the human-facing history. `text` is what it was about (the prompt or the
   * question), `detail` how it went (the answer, the failure, who did it). Capped so a
   * long-lived conversation cannot grow the file without bound.
   */
  function record(event, { text = "", detail = "", item = null } = {}) {
    st.history.push({
      at: now(),
      event,
      text: String(text || "").slice(0, 4000),
      detail: String(detail || "").slice(0, 4000),
      item_id: item ? item.id : null,
    });
    if (st.history.length > QUEUE_MAX_HISTORY) st.history.splice(0, st.history.length - QUEUE_MAX_HISTORY);
  }

  function pause(reason, by = "system") {
    if (st.paused && !(by === "assistant" && st.paused.by === "assistant")) return;
    st.paused = { reason: String(reason || "paused").slice(0, 1000), at: now(), by };
    log?.("queue_paused", key(), `${by}: ${st.paused.reason.slice(0, 200)}`);
    if (by !== "assistant") record("paused", { text: st.paused.reason, detail: `by ${by}` });
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
      await runPrompt(text);
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
      // Auto-clear: a finished item leaves the list on its own. Only a plain "done" -
      // failed, skipped and waiting ones still need the technician, and a done item that
      // carried a question-and-answer keeps its trail visible until "Clear done".
      if (st.auto_clear_done && item.status === "done" && !item.thread.length) {
        st.items = st.items.filter((i) => i.id !== item.id);
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
    attach(sid) {
      sessionId = String(sid);
      file = queuePath(root, scopeKey, sessionId);
      try { st = sanitize(JSON.parse(fs.readFileSync(file, "utf8"))); }
      catch { st = emptyState(); }
      // A session that was mid-run when its window went away must not restart on its
      // own. Any item still "running" from that life is a pending one now.
      for (const it of st.items) if (it.status === "running") it.status = "pending";
      if (st.auto_next && nextPending() && !st.paused) {
        pause("Window reopened - press Resume to continue the queue", "system");
      }
      publish();
    },

    detach() { detached = true; persist(); },

    state: snapshot,
    publish,
    advance,

    /** The operator typed something (not a window command). If we were waiting on
     *  them, that is the answer: clear the pause so the queue continues after this turn. */
    noteOperatorReply(text = "") {
      if (!st.paused && !st.questions.length) return;
      st.paused = null;
      // A reply typed in the chat answers whatever was open. If a question belonged to a
      // queued item, the answer is recorded on that item and it counts as done, so the
      // trail is complete wherever the technician chose to type.
      for (const q of st.questions) {
        const it = q.item_id ? st.items.find((i) => i.id === q.item_id) : null;
        if (it) {
          it.thread.push({ role: "operator", text: String(text || "").slice(0, 4000), at: now(), via: "chat" });
          if (it.status === "waiting") { it.status = "done"; it.ended_at = now(); }
        }
        record("answered_in_chat", { text: q.text, detail: String(text || ""), item: it });
      }
      st.questions = [];
      log?.("queue_resumed", key(), "operator replied in chat");
      publish();
    },

    /** Operator pressed Stop. */
    noteAbort() {
      if (!st.auto_next && !runningId) return;
      const it = st.items.find((i) => i.id === runningId);
      if (it) { it.status = "failed"; it.note = "stopped by operator"; record("stopped", { text: it.text, detail: "by operator", item: it }); }
      pause("Stopped by the operator", "operator");
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
        record("asked", { text: question, detail: it ? `while running: ${it.text.slice(0, 200)}` : "in chat", item: it });
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
     */
    async handle(msg) {
      if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("queue_")) return false;
      switch (msg.type) {
        case "queue_add": {
          const text = String(msg.text || "").trim().slice(0, QUEUE_MAX_TEXT);
          if (!text) break;
          if (st.items.length >= QUEUE_MAX_ITEMS) {
            send({ type: "error", message: `The queue is full (${QUEUE_MAX_ITEMS} items). Clear finished items first.` });
            break;
          }
          const added = {
            id: randomUUID(), text, compact_first: !!msg.compact_first, status: "pending",
            added_at: now(), started_at: null, ended_at: null, note: "", thread: [],
          };
          st.items.push(added);
          record("added", { text, detail: added.compact_first ? "compact & clear first" : "", item: added });
          publish();
          await advance("added");
          break;
        }
        case "queue_update": {
          const it = st.items.find((i) => i.id === msg.id);
          if (!it || it.status === "running") break;
          if (typeof msg.text === "string" && msg.text.trim() && msg.text.trim() !== it.text) {
            record("edited", { text: msg.text.trim(), detail: `was: ${it.text.slice(0, 500)}`, item: it });
            it.text = msg.text.trim().slice(0, QUEUE_MAX_TEXT);
          }
          if (msg.compact_first !== undefined) it.compact_first = !!msg.compact_first;
          // Re-queue a finished/failed/skipped item ("run it again").
          if (msg.status === "pending" && it.status !== "pending") {
            it.status = "pending"; it.note = ""; it.started_at = null; it.ended_at = null;
            record("requeued", { text: it.text, item: it });
          }
          if (msg.status === "skipped" && it.status === "pending") { it.status = "skipped"; record("skipped", { text: it.text, item: it }); }
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
          record("answered", { text: q.text, detail: text, item: it });
          if (it) {
            it.thread.push({ role: "operator", text, at: now() });
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
          record("dismissed", { text: q.text, item: it });
          if (it && it.status === "waiting") { it.status = "done"; it.note = "question dismissed"; it.ended_at = now(); }
          if (!st.questions.length && st.paused?.by === "assistant") st.paused = null;
          publish();
          await advance("question dismissed");
          break;
        }
        case "queue_remove": {
          const i = st.items.findIndex((x) => x.id === msg.id);
          if (i < 0 || st.items[i].status === "running") break;
          record("removed", { text: st.items[i].text, detail: `was ${st.items[i].status}`, item: st.items[i] });
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
          record("auto_next", { detail: st.auto_next ? "on" : "off" });
          publish();
          if (st.auto_next) await advance("auto on");
          break;
        }
        case "queue_set_auto_clear": {
          st.auto_clear_done = !!msg.value;
          // Turning it on also sweeps what is already done, so the list matches the switch.
          if (st.auto_clear_done) st.items = st.items.filter((i) => i.status !== "done");
          publish();
          break;
        }
        case "queue_pause":
          pause("Paused by the operator", "operator");
          publish();
          break;
        case "queue_resume":
          if (st.paused) record("resumed", { text: st.paused.reason });
          st.paused = null;
          publish();
          await advance("resume");
          break;
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
          if (gone.length) record("cleared_finished", { detail: `${gone.length} item(s)` });
          publish();
          break;
        }
        case "queue_clear_history":
          st.history = [];
          publish();
          break;
        case "queue_clear":
          record("cleared_all", { detail: `${st.items.length} item(s), ${st.questions.length} question(s)` });
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
