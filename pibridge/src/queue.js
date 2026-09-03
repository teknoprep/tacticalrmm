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

const STATUSES = new Set(["pending", "running", "done", "failed", "skipped"]);

function queuePath(root, scopeKey, sessionId) {
  const dir = path.join(root, scopeKey, "queue");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.json`);
}

function emptyState() {
  return { version: 1, auto_next: false, paused: null, items: [] };
}

function sanitize(raw) {
  const st = emptyState();
  if (!raw || typeof raw !== "object") return st;
  st.auto_next = !!raw.auto_next;
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
    });
  }
  return st;
}

/** Prompt paragraph that tells the model the queue exists and how to stop it. */
export function queuePromptSection() {
  return (
    "\n\nPROMPT QUEUE: the operator may have queued follow-up prompts that are sent to you " +
    "automatically, one per turn, as soon as you finish. If you cannot complete the current " +
    "task without a decision or information from the operator, call pause_queue with the " +
    "exact question - do NOT just ask in prose and stop, because the next queued prompt " +
    "would arrive before anyone answers. When you have simply finished, do not call it."
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
      paused: st.paused,
      running_id: runningId,
      pending,
      items: st.items.map((i) => ({ ...i })),
    };
  }

  function publish() {
    persist();
    try { send(snapshot()); } catch { /* socket gone */ }
  }

  function pause(reason, by = "system") {
    if (st.paused) return;
    st.paused = { reason: String(reason || "paused").slice(0, 1000), at: now(), by };
    log?.("queue_paused", key(), `${by}: ${st.paused.reason.slice(0, 200)}`);
  }

  function nextPending() {
    return st.items.find((i) => i.status === "pending") || null;
  }

  async function runItem(item) {
    engineBusy = true;
    runningId = item.id;
    item.status = "running";
    item.started_at = now();
    item.note = "";
    const position = st.items.filter((i) => i.status !== "pending" || i.id === item.id).length;
    log?.("queue_run", key(), `${position}/${st.items.length}: ${item.text.slice(0, 120)}`);
    publish();
    try {
      if (item.compact_first) {
        // "Compact & clear first": the technician wants this item to start from a
        // summary, not from the whole transcript. compact() reports its own outcome to
        // the window; "nothing to compact" is not a failure for us.
        await compact(`queue: ${item.text.slice(0, 80)}`);
      }
      if (detached) throw new Error("window closed");
      send({ type: "queue_started", id: item.id, text: item.text });
      await runPrompt(item.text);
      if (item.status === "failed") {
        // noteError() already marked it and paused the queue.
      } else {
        item.status = "done";
        if (st.paused && st.paused.by === "assistant") item.note = "asked a question - see the chat";
      }
    } catch (e) {
      const why = String(e?.message || e).slice(0, 300);
      item.status = "failed";
      item.note = why;
      pause(`"${item.text.slice(0, 60)}" failed: ${why}`);
    } finally {
      item.ended_at = now();
      runningId = null;
      engineBusy = false;
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
    noteOperatorReply() {
      if (!st.paused) return;
      st.paused = null;
      log?.("queue_resumed", key(), "operator replied");
      publish();
    },

    /** Operator pressed Stop. */
    noteAbort() {
      if (!st.auto_next && !runningId) return;
      const it = st.items.find((i) => i.id === runningId);
      if (it) { it.status = "failed"; it.note = "stopped by operator"; }
      pause("Stopped by the operator", "operator");
      publish();
    },

    /** The bridge gave up on a turn (non-recoverable provider error). */
    noteError(why) {
      if (!st.auto_next && !runningId) return;
      const it = st.items.find((i) => i.id === runningId);
      if (it) { it.status = "failed"; it.note = String(why || "error").slice(0, 300); }
      pause(`Provider error: ${String(why || "unknown").slice(0, 300)}`, "system");
      publish();
    },

    /** Model asked to stop (pause_queue tool). Returns the tool's reply text. */
    pauseByModel(question) {
      const q = String(question || "").trim().slice(0, 1000);
      if (!st.auto_next && !nextPending()) {
        return "No prompt queue is running. Ask the operator directly in your reply.";
      }
      pause(q || "The assistant needs a decision before continuing", "assistant");
      publish();
      return "Queue paused. The operator will see your question and answer before the next queued prompt is sent. Finish your reply with the question stated plainly.";
    },

    /** Tool the model calls when it needs a human decision. */
    tool: defineTool({
      name: "pause_queue",
      label: "Pause the prompt queue",
      description:
        "Stop the operator's queued follow-up prompts from being sent automatically because " +
        "you need a decision or information from them before you can continue. Call this " +
        "INSTEAD of only asking in prose, whenever your reply ends with a question the next " +
        "step depends on. Do not call it when you have simply finished the task.",
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
          st.items.push({
            id: randomUUID(), text, compact_first: !!msg.compact_first, status: "pending",
            added_at: now(), started_at: null, ended_at: null, note: "",
          });
          publish();
          await advance("added");
          break;
        }
        case "queue_update": {
          const it = st.items.find((i) => i.id === msg.id);
          if (!it || it.status === "running") break;
          if (typeof msg.text === "string" && msg.text.trim()) it.text = msg.text.trim().slice(0, QUEUE_MAX_TEXT);
          if (msg.compact_first !== undefined) it.compact_first = !!msg.compact_first;
          // Re-queue a finished/failed/skipped item ("run it again").
          if (msg.status === "pending" && it.status !== "pending") {
            it.status = "pending"; it.note = ""; it.started_at = null; it.ended_at = null;
          }
          if (msg.status === "skipped" && it.status === "pending") it.status = "skipped";
          publish();
          await advance("updated");
          break;
        }
        case "queue_remove": {
          const i = st.items.findIndex((x) => x.id === msg.id);
          if (i < 0 || st.items[i].status === "running") break;
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
          publish();
          if (st.auto_next) await advance("auto on");
          break;
        }
        case "queue_pause":
          pause("Paused by the operator", "operator");
          publish();
          break;
        case "queue_resume":
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
        case "queue_clear_done":
          st.items = st.items.filter((i) => i.status === "pending" || i.status === "running");
          publish();
          break;
        case "queue_clear":
          st.items = st.items.filter((i) => i.status === "running");
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
