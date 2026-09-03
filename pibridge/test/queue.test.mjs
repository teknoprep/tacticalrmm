// Prompt queue (queue.js): a per-conversation to-do list that drives the chat.
// Run: node --test test/queue.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makePromptQueue } from "../src/queue.js";

const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };

function harness({ prompt, compact } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-queue-"));
  const frames = [];
  const ran = [];
  const compacts = [];
  let streaming = false;
  const q = makePromptQueue({
    scopeKey: "AGENT1",
    root,
    send: (f) => frames.push(f),
    log: () => {},
    isStreaming: () => streaming,
    runPrompt: async (text) => {
      streaming = true;
      ran.push(text);
      try { if (prompt) await prompt(text, q); }
      finally { streaming = false; }
    },
    compact: async (reason) => { compacts.push(reason); if (compact) await compact(reason); },
  });
  q.attach("sess-1");
  const state = () => q.state();
  const last = (type) => frames.filter((f) => f.type === type).at(-1);
  return { q, root, frames, ran, compacts, state, last, setStreaming: (v) => { streaming = v; } };
}

test("a new conversation has an empty queue with Auto-Next off", () => {
  const h = harness();
  const s = h.state();
  assert.equal(s.items.length, 0);
  assert.equal(s.auto_next, false);
  assert.equal(s.paused, null);
  assert.equal(h.last("queue_state").pending, 0);
});

test("adding items records them; nothing runs while Auto-Next is off", async () => {
  const h = harness();
  await h.q.handle({ type: "queue_add", text: "check disk space" });
  await h.q.handle({ type: "queue_add", text: "restart spooler", compact_first: true });
  await settle();
  assert.equal(h.state().items.length, 2);
  assert.equal(h.state().items[1].compact_first, true);
  assert.deepEqual(h.ran, [], "queued prompts are notes until Auto-Next is on");
});

test("Auto-Next on: items run in order, one per turn, until the queue is empty", async () => {
  const h = harness();
  await h.q.handle({ type: "queue_add", text: "one" });
  await h.q.handle({ type: "queue_add", text: "two" });
  await h.q.handle({ type: "queue_add", text: "three" });
  await h.q.handle({ type: "queue_set_auto", value: true });
  await settle(20);
  assert.deepEqual(h.ran, ["one", "two", "three"]);
  assert.deepEqual(h.state().items.map((i) => i.status), ["done", "done", "done"]);
  assert.equal(h.state().paused, null);
  // Each start is announced so the window can show the prompt bubble.
  assert.deepEqual(h.frames.filter((f) => f.type === "queue_started").map((f) => f.text), ["one", "two", "three"]);
});

test("compact & clear first runs the compaction BEFORE the prompt", async () => {
  const order = [];
  const h = harness({
    prompt: async (t) => order.push(`prompt:${t}`),
    compact: async () => order.push("compact"),
  });
  await h.q.handle({ type: "queue_add", text: "fresh start", compact_first: true });
  await h.q.handle({ type: "queue_set_auto", value: true });
  await settle();
  assert.deepEqual(order, ["compact", "prompt:fresh start"]);
});

test("the model calling pause_queue stops the queue; the operator's reply resumes it", async () => {
  const h = harness({
    prompt: async (text, q) => {
      if (text === "pick a plan") q.pauseByModel("Option A (fast, risky) or B (slow, safe)?");
    },
  });
  await h.q.handle({ type: "queue_add", text: "pick a plan" });
  await h.q.handle({ type: "queue_add", text: "then apply it" });
  await h.q.handle({ type: "queue_set_auto", value: true });
  await settle(10);
  assert.deepEqual(h.ran, ["pick a plan"], "the next item must NOT be sent while a question is open");
  const s = h.state();
  assert.equal(s.paused.by, "assistant");
  assert.match(s.paused.reason, /Option A/);
  assert.equal(s.items[0].status, "waiting", "a question is a state of the task, not its end");
  assert.deepEqual(s.items[0].thread.map((t) => [t.role, t.text]), [["assistant", "Option A (fast, risky) or B (slow, safe)?"]]);
  assert.equal(s.questions.length, 1, "the question sits at the top of the panel");
  assert.equal(s.questions[0].item_id, s.items[0].id);
  assert.equal(s.items[1].status, "pending");
  assert.equal(s.auto_next, true, "pausing is not the same as turning Auto-Next off");

  // The technician types their answer in the CHAT (the bridge calls this before
  // prompting), and the turn settles (the bridge calls advance after runPrompt) -> the
  // answer is recorded on the item, the item is done, the queue continues.
  h.q.noteOperatorReply("B please");
  assert.equal(h.state().paused, null);
  assert.equal(h.state().questions.length, 0, "answered in chat clears the card too");
  assert.equal(h.state().items[0].status, "done");
  assert.deepEqual(h.state().items[0].thread.at(-1), { ...h.state().items[0].thread.at(-1), role: "operator", text: "B please", via: "chat" });
  await h.q.advance("turn settled");
  await settle(10);
  assert.deepEqual(h.ran, ["pick a plan", "then apply it"]);
});

test("answering IN THE QUEUE runs the reply as that item and tracks the exchange", async () => {
  let asks = 0;
  const h = harness({
    prompt: async (text, q) => {
      if (text === "set up the share") { asks++; q.pauseByModel("Which drive letter?"); }
      if (text === "use Z:") { asks++; q.pauseByModel("Read-only for Everyone, or read-write?"); }
      // "read-write" -> finishes without a question
    },
  });
  await h.q.handle({ type: "queue_add", text: "set up the share" });
  await h.q.handle({ type: "queue_add", text: "then email the customer" });
  await h.q.handle({ type: "queue_set_auto", value: true });
  await settle(10);
  const id = h.state().items[0].id;
  assert.equal(h.state().items[0].status, "waiting");
  assert.deepEqual(h.ran, ["set up the share"], "nothing else runs while the question is open");
  assert.equal(h.state().questions[0].item_id, id);

  await h.q.handle({ type: "queue_answer", id: h.state().questions[0].id, text: "use Z:" });
  await settle(10);
  let it = h.state().items[0];
  assert.equal(it.status, "waiting", "the assistant asked again on the same item");
  assert.deepEqual(it.thread.map((t) => `${t.role}: ${t.text}`), [
    "assistant: Which drive letter?",
    "operator: use Z:",
    "assistant: Read-only for Everyone, or read-write?",
  ]);
  assert.deepEqual(h.ran, ["set up the share", "use Z:"]);
  assert.equal(h.state().items[1].status, "pending", "the second item is still waiting its turn");

  assert.equal(h.state().questions.length, 1, "the follow-up replaced the first card");
  await h.q.handle({ type: "queue_answer", id: h.state().questions[0].id, text: "read-write" });
  await settle(15);
  it = h.state().items[0];
  assert.equal(it.status, "done");
  assert.equal(it.thread.length, 4);
  assert.deepEqual(h.ran, ["set up the share", "use Z:", "read-write", "then email the customer"],
    "once answered, the queue carries on by itself");
  // The reply frames are announced like any queued prompt, flagged as replies.
  const started = h.frames.filter((f) => f.type === "queue_started");
  assert.deepEqual(started.map((f) => !!f.reply), [false, true, true, false]);
});

test("Auto-clear never removes a waiting item, and keeps a done item that carried a Q&A", async () => {
  const h = harness({ prompt: async (t, q) => { if (t === "ask") q.pauseByModel("Really?"); } });
  await h.q.handle({ type: "queue_set_auto_clear", value: true });
  await h.q.handle({ type: "queue_add", text: "plain" });
  await h.q.handle({ type: "queue_add", text: "ask" });
  await h.q.handle({ type: "queue_set_auto", value: true });
  await settle(10);
  assert.deepEqual(h.state().items.map((i) => [i.text, i.status]), [["ask", "waiting"]], "plain vanished, the question stayed");
  await h.q.handle({ type: "queue_reply", id: h.state().items[0].id, text: "yes" });
  await settle(10);
  assert.deepEqual(h.state().items.map((i) => [i.text, i.status]), [["ask", "done"]], "its trail stays until Clear done");
  await h.q.handle({ type: "queue_clear_done" });
  assert.equal(h.state().items.length, 0);
});

test("a question asked in ordinary chat (nothing queued) becomes a standalone card", async () => {
  const h = harness();
  const reply = h.q.pauseByModel("Which site is this for?");
  assert.match(reply, /Queue panel/);
  const s = h.state();
  assert.equal(s.questions.length, 1);
  assert.equal(s.questions[0].item_id, null);
  assert.equal(s.questions[0].text, "Which site is this for?");
  assert.equal(s.paused.by, "assistant");
  // Asking the same thing twice is one card.
  h.q.pauseByModel("Which site is this for?");
  assert.equal(h.state().questions.length, 1);

  // Answered in the panel: runs as the next thing said, card gone, pause gone.
  await h.q.handle({ type: "queue_answer", id: s.questions[0].id, text: "Exeter" });
  await settle(5);
  assert.deepEqual(h.ran, ["Exeter"]);
  assert.equal(h.state().questions.length, 0);
  assert.equal(h.state().paused, null);
  const started = h.frames.filter((f) => f.type === "queue_started").at(-1);
  assert.deepEqual([started.id, started.reply, started.text], [null, true, "Exeter"]);
});

test("a question can be dismissed; its item is then finished", async () => {
  const h = harness({ prompt: async (t, q) => { if (t === "ask") q.pauseByModel("Sure?"); } });
  await h.q.handle({ type: "queue_add", text: "ask" });
  await h.q.handle({ type: "queue_add", text: "after" });
  await h.q.handle({ type: "queue_set_auto", value: true });
  await settle(10);
  assert.equal(h.state().items[0].status, "waiting");
  const qid = h.state().questions[0].id;
  await h.q.handle({ type: "queue_dismiss_question", id: qid });
  await settle(10);
  assert.equal(h.state().questions.length, 0);
  assert.equal(h.state().items[0].status, "done");
  assert.equal(h.state().items[0].note, "question dismissed");
  assert.deepEqual(h.ran, ["ask", "after"], "dismissing lets the queue carry on");
});

test("Stop pauses the queue and marks the running item failed", async () => {
  let release;
  const h = harness({ prompt: () => new Promise((r) => { release = r; }) });
  await h.q.handle({ type: "queue_add", text: "long job" });
  await h.q.handle({ type: "queue_add", text: "next" });
  // Not awaited: the handler resolves only when the (held) prompt does - like the bridge,
  // where the ws handler awaits the turn while Stop arrives on another frame.
  const running = h.q.handle({ type: "queue_set_auto", value: true });
  await settle();
  assert.equal(h.state().running_id, h.state().items[0].id);
  h.q.noteAbort();            // operator pressed Stop
  release();                  // session.abort() resolves the prompt
  await running;
  await settle(10);
  const s = h.state();
  assert.equal(s.items[0].status, "failed");
  assert.equal(s.items[0].note, "stopped by operator");
  assert.equal(s.items[1].status, "pending", "the rest waits");
  assert.equal(s.paused.by, "operator");
  assert.deepEqual(h.ran, ["long job"]);
});

test("a provider error pauses the queue with the reason", async () => {
  const h = harness({ prompt: async (t, q) => { if (t === "bad") q.noteError("401 invalid api key"); } });
  await h.q.handle({ type: "queue_add", text: "bad" });
  await h.q.handle({ type: "queue_add", text: "after" });
  await h.q.handle({ type: "queue_set_auto", value: true });
  await settle(10);
  assert.equal(h.state().items[0].status, "failed");
  assert.match(h.state().paused.reason, /401/);
  assert.deepEqual(h.ran, ["bad"]);
});

test("a thrown runPrompt is a failed item, not a crashed queue", async () => {
  const h = harness({ prompt: async (t) => { if (t === "boom") throw new Error("socket hung up"); } });
  await h.q.handle({ type: "queue_add", text: "boom" });
  await h.q.handle({ type: "queue_set_auto", value: true });
  await settle(10);
  assert.equal(h.state().items[0].status, "failed");
  assert.equal(h.state().items[0].note, "socket hung up");
  assert.match(h.state().paused.reason, /failed/);
});

test("Resume clears a pause and continues; Pause holds it", async () => {
  const h = harness();
  await h.q.handle({ type: "queue_add", text: "a" });
  await h.q.handle({ type: "queue_add", text: "b" });
  await h.q.handle({ type: "queue_pause" });
  await h.q.handle({ type: "queue_set_auto", value: true });
  await settle();
  assert.deepEqual(h.ran, [], "paused wins over Auto-Next");
  await h.q.handle({ type: "queue_resume" });
  await settle(10);
  assert.deepEqual(h.ran, ["a", "b"]);
});

test("Run next sends the head item once even with Auto-Next off", async () => {
  const h = harness();
  await h.q.handle({ type: "queue_add", text: "a" });
  await h.q.handle({ type: "queue_add", text: "b" });
  await h.q.handle({ type: "queue_run_next" });
  await settle(10);
  assert.deepEqual(h.ran, ["a"]);
  assert.equal(h.state().items[1].status, "pending");
});

test("nothing is sent while the assistant is still streaming", async () => {
  const h = harness();
  h.setStreaming(true);
  await h.q.handle({ type: "queue_add", text: "a" });
  await h.q.handle({ type: "queue_set_auto", value: true });
  await settle();
  assert.deepEqual(h.ran, []);
  h.setStreaming(false);
  await h.q.advance("turn settled");
  await settle();
  assert.deepEqual(h.ran, ["a"]);
});

test("edit, reorder, skip, re-queue, remove, clear done", async () => {
  const h = harness();
  await h.q.handle({ type: "queue_add", text: "a" });
  await h.q.handle({ type: "queue_add", text: "b" });
  await h.q.handle({ type: "queue_add", text: "c" });
  const [a, b, c] = h.state().items.map((i) => i.id);
  await h.q.handle({ type: "queue_update", id: b, text: "B edited", compact_first: true });
  assert.equal(h.state().items[1].text, "B edited");
  assert.equal(h.state().items[1].compact_first, true);
  await h.q.handle({ type: "queue_reorder", ids: [c, a] });   // b left out -> keeps place at end
  assert.deepEqual(h.state().items.map((i) => i.id), [c, a, b]);
  await h.q.handle({ type: "queue_update", id: a, status: "skipped" });
  assert.equal(h.state().items[1].status, "skipped");
  await h.q.handle({ type: "queue_update", id: a, status: "pending" });
  assert.equal(h.state().items[1].status, "pending");
  await h.q.handle({ type: "queue_remove", id: c });
  assert.deepEqual(h.state().items.map((i) => i.id), [a, b]);
  await h.q.handle({ type: "queue_set_auto", value: true });
  await settle(10);
  assert.deepEqual(h.state().items.map((i) => i.status), ["done", "done"]);
  await h.q.handle({ type: "queue_clear_done" });
  assert.equal(h.state().items.length, 0);
});

test("the queue is persisted per conversation and comes back PAUSED on reopen", async () => {
  const h = harness();
  await h.q.handle({ type: "queue_add", text: "a" });
  await h.q.handle({ type: "queue_add", text: "b" });
  await h.q.handle({ type: "queue_set_auto", value: true });
  // Simulate the window closing while "a" is mid-run: detach before it settles.
  h.q.detach();
  const file = path.join(h.root, "AGENT1", "queue", "sess-1.json");
  assert.ok(fs.existsSync(file), "one file per session id");

  // Same conversation reopened (Continue / refresh).
  const frames = [];
  const ran = [];
  const q2 = makePromptQueue({
    scopeKey: "AGENT1", root: h.root, send: (f) => frames.push(f), log: () => {},
    isStreaming: () => false, runPrompt: async (t) => ran.push(t), compact: async () => {},
  });
  q2.attach("sess-1");
  await settle();
  const s = q2.state();
  assert.equal(s.items.length, 2, "the list survived");
  assert.equal(s.auto_next, true, "the preference survived");
  assert.ok(s.items.every((i) => i.status !== "running"), "no item is stuck 'running'");
  assert.match(s.paused.reason, /reopened/i, "but it does not fire on its own");
  assert.deepEqual(ran, []);

  // A DIFFERENT conversation on the same device starts empty.
  const q3 = makePromptQueue({
    scopeKey: "AGENT1", root: h.root, send: () => {}, log: () => {},
    isStreaming: () => false, runPrompt: async () => {}, compact: async () => {},
  });
  q3.attach("sess-2");
  assert.equal(q3.state().items.length, 0);
});

test("Auto-clear done removes finished items by itself, but keeps failed ones", async () => {
  const h = harness({ prompt: async (t, q) => { if (t === "bad") q.noteError("boom"); } });
  await h.q.handle({ type: "queue_add", text: "a" });
  await h.q.handle({ type: "queue_add", text: "bad" });
  await h.q.handle({ type: "queue_add", text: "c" });
  await h.q.handle({ type: "queue_set_auto_clear", value: true });
  assert.equal(h.state().auto_clear_done, true);
  await h.q.handle({ type: "queue_set_auto", value: true });
  await settle(10);
  // "a" ran and vanished; "bad" failed and stays (queue paused on it); "c" waits.
  assert.deepEqual(h.ran, ["a", "bad"]);
  assert.deepEqual(h.state().items.map((i) => [i.text, i.status]), [["bad", "failed"], ["c", "pending"]]);

  // Turning the switch on later sweeps what is already done.
  const h2 = harness();
  await h2.q.handle({ type: "queue_add", text: "x" });
  await h2.q.handle({ type: "queue_run_next" });
  await settle(5);
  assert.equal(h2.state().items[0].status, "done");
  await h2.q.handle({ type: "queue_set_auto_clear", value: true });
  assert.equal(h2.state().items.length, 0);
});

test("history records what was done and how, for the human - and is not context for the model", async () => {
  const h = harness({ prompt: async (t, q) => { if (t === "ask") q.pauseByModel("Which one?"); } });
  await h.q.handle({ type: "queue_add", text: "plain" });
  await h.q.handle({ type: "queue_add", text: "ask" });
  await h.q.handle({ type: "queue_set_auto", value: true });
  await settle(10);
  await h.q.handle({ type: "queue_answer", id: h.state().questions[0].id, text: "the second" });
  await settle(10);
  await h.q.handle({ type: "queue_clear_done" });
  const ev = h.state().history.map((e) => e.event);
  assert.deepEqual(ev, [
    "added", "added", "auto_next",
    "started", "done",            // plain
    "started", "asked",           // ask -> question
    "answered", "answer_sent", "done",
    "cleared_finished",
  ]);
  const answered = h.state().history.find((e) => e.event === "answered");
  assert.equal(answered.text, "Which one?");
  assert.equal(answered.detail, "the second");
  // The answer itself reached the model (it is the operator's reply); the HISTORY did not:
  // nothing but the prompts the operator wrote ever went through runPrompt.
  assert.deepEqual(h.ran, ["plain", "ask", "the second"]);
  // Cleared items are still in the history, and the history survives a reopen.
  assert.equal(h.state().items.length, 0);
  h.q.detach();
  const q2 = makePromptQueue({
    scopeKey: "AGENT1", root: h.root, send: () => {}, log: () => {},
    isStreaming: () => false, runPrompt: async () => {}, compact: async () => {},
  });
  q2.attach("sess-1");
  assert.equal(q2.state().history.length, ev.length);
  await q2.handle({ type: "queue_clear_history" });
  assert.equal(q2.state().history.length, 0);
});

test("a detached (closed) window never sends another prompt", async () => {
  const h = harness();
  await h.q.handle({ type: "queue_add", text: "a" });
  h.q.detach();
  await h.q.handle({ type: "queue_set_auto", value: true });
  await settle();
  assert.deepEqual(h.ran, []);
});
