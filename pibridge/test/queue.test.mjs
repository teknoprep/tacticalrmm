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

// `autoClear` mirrors production: ON unless this window turned it off (queue.js). Tests
// that need to SEE finished items sitting in the list pass false, which is what a window
// whose operator switched it off looks like.
function harness({ prompt, compact, autoClear = true } = {}) {
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
    autoClearDefault: autoClear,
  });
  q.attach("sess-1");
  const state = () => q.state();
  const last = (type) => frames.filter((f) => f.type === type).at(-1);
  // The history is no longer carried in every queue_state frame (it holds every prompt of
  // the conversation now, which would be hundreds of KB per change on the socket). Ask
  // for it, exactly as the window does when the operator opens the History dialog.
  const history = async () => {
    await q.handle({ type: "queue_history" });
    return (frames.filter((f) => f.type === "queue_history").at(-1) || {}).history || [];
  };
  return { q, root, frames, ran, compacts, state, last, history, setStreaming: (v) => { streaming = v; } };
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
  const h = harness({ autoClear: false });   // the finished items have to stay visible here
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
    // Auto-clear off: this test reads the finished item's thread, which is only on the
    // item. (With Auto-clear ON the exchange is read from the history instead.)
    autoClear: false,
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

test("Auto-clear never removes a waiting item, but a done one goes even after a Q&A", async () => {
  const h = harness({ prompt: async (t, q) => { if (t === "ask") q.pauseByModel("Really?"); } });
  await h.q.handle({ type: "queue_set_auto_clear", value: true });
  await h.q.handle({ type: "queue_add", text: "plain" });
  await h.q.handle({ type: "queue_add", text: "ask" });
  await h.q.handle({ type: "queue_set_auto", value: true });
  await settle(10);
  assert.deepEqual(h.state().items.map((i) => [i.text, i.status]), [["ask", "waiting"]], "plain vanished, the question stayed");
  await h.q.handle({ type: "queue_reply", id: h.state().items[0].id, text: "yes" });
  await settle(10);
  // Reported: "auto clear is on, but it doesn't auto clear". A Q&A used to hold the item
  // back, which with the switch ON is indistinguishable from the switch not working.
  assert.deepEqual(h.state().items, [], "answered and finished, so it clears like any other");
  // Nothing is lost: the exchange is in the history, which is where a human reads it.
  const hist = await h.history();
  assert.equal(hist.find((e) => e.event === "asked").text, "Really?");
  assert.equal(hist.find((e) => e.event === "answered").detail, "yes");
  assert.ok(hist.some((e) => e.event === "auto_cleared"));
});

test("a typed prompt that the assistant asked about still clears when it finishes", async () => {
  // The path the owner hit: everything typed in the chat is an item now, and a question
  // mid-turn put a thread on it.
  const h = harness();
  const id = h.q.beginTypedItem("do these", "browser", { user: "chris", display: "Chris Tech" });
  h.q.pauseByModel("Write mode is off - turn it on?");
  h.q.noteOperatorReply("write mode on now", { user: "chris", display: "Chris Tech" });
  h.q.settleTypedItem(id, true);
  assert.deepEqual(h.state().items, []);
  assert.ok((await h.history()).some((e) => e.event === "auto_cleared"));
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
  const h = harness({ autoClear: false });
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
  const h = harness({ autoClear: false });   // "clear done" needs done items to clear
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
  const h = harness({ autoClear: false });
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
    autoClearDefault: false,   // the same window: Auto-clear was off in it
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
  const h = harness({ autoClear: false, prompt: async (t, q) => { if (t === "bad") q.noteError("boom"); } });
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
  const h2 = harness({ autoClear: false });
  await h2.q.handle({ type: "queue_add", text: "x" });
  await h2.q.handle({ type: "queue_run_next" });
  await settle(5);
  assert.equal(h2.state().items[0].status, "done");
  await h2.q.handle({ type: "queue_set_auto_clear", value: true });
  assert.equal(h2.state().items.length, 0);
});

test("history records what was done and how, for the human - and is not context for the model", async () => {
  const h = harness({ autoClear: false, prompt: async (t, q) => { if (t === "ask") q.pauseByModel("Which one?"); } });
  await h.q.handle({ type: "queue_add", text: "plain" });
  await h.q.handle({ type: "queue_add", text: "ask" });
  await h.q.handle({ type: "queue_set_auto", value: true });
  await settle(10);
  await h.q.handle({ type: "queue_answer", id: h.state().questions[0].id, text: "the second" });
  await settle(10);
  await h.q.handle({ type: "queue_clear_done" });
  const ev = (await h.history()).map((e) => e.event);
  assert.deepEqual(ev, [
    "added", "added", "auto_next",
    "started", "done",            // plain
    "started", "asked",           // ask -> question
    "answered", "answer_sent", "done",
    "cleared_finished",
  ]);
  const answered = (await h.history()).find((e) => e.event === "answered");
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

  const frames2 = [];
  q2.attach("sess-1");
  assert.equal(q2.state().history_count, ev.length);
  await q2.handle({ type: "queue_clear_history" }, { user: "dan", display: "Dan Ops" });
  // Clearing leaves ONE row: who cleared it. A wiped history that looks like a quiet
  // conversation is exactly what an admin must not be shown.
  assert.equal(q2.state().history_count, 1);
  await q2.handle({ type: "queue_history" });
  void frames2;
});

test("every row names the person responsible for it", async () => {
  const h = harness({ prompt: async (t, q) => { if (t === "ask") q.pauseByModel("Which server?"); } });
  const dan = { user: "dan", display: "Dan Ops" };
  const chris = { user: "chris", display: "Chris Tech" };

  // Dan queues work; Chris takes the seat and answers the assistant's question.
  await h.q.handle({ type: "queue_add", text: "ask" }, dan);
  h.q.notePrompt("and check the backups", "browser", { actor: chris });
  await h.q.handle({ type: "queue_run_next" }, chris);
  await settle(10);
  const q1 = h.state().questions[0];
  await h.q.handle({ type: "queue_answer", id: q1.id, text: "the DC" }, chris);
  await settle(10);

  const hist = await h.history();
  const row = (ev) => hist.find((e) => e.event === ev);
  // Who ADDED it owns the item, so the prompt it later sends is still Dan's work...
  assert.equal(row("added").by, "Dan Ops");
  assert.equal(row("added").user, "dan");
  assert.equal(row("started").user, "dan");
  // ...while the frames Chris sent are Chris's, in the same conversation.
  assert.equal(row("prompt").by, "Chris Tech");
  assert.equal(row("answered").user, "chris");
  assert.equal(row("answered").detail, "the DC");
  // The AI's own question is attributed to nobody rather than to whoever was watching.
  assert.equal(row("asked").by, "");
  assert.equal(row("asked").user, "");

  // Attribution survives a reopen: it is in the file, not in the socket.
  h.q.detach();
  const frames2 = [];
  const q2 = makePromptQueue({
    scopeKey: "AGENT1", root: h.root, send: (f) => frames2.push(f), log: () => {},
    isStreaming: () => false, runPrompt: async () => {}, compact: async () => {},
  });
  q2.attach("sess-1");
  await q2.handle({ type: "queue_history" });
  const reopened = frames2.filter((f) => f.type === "queue_history").at(-1).history;
  assert.equal(reopened.find((e) => e.event === "added").by, "Dan Ops");
  assert.equal(reopened.find((e) => e.event === "answered").by, "Chris Tech");
});

test("a prompt with no known sender is left unattributed, never guessed", async () => {
  const h = harness();
  h.q.notePrompt("who sent this?", "browser");           // no actor plumbed through
  h.q.backfillPrompts([{ at: "2026-01-01T00:00:00.000Z", text: "an old prompt" }]);
  const hist = await h.history();
  for (const e of hist) {
    assert.equal(e.by, "");
    assert.equal(e.user, "");
  }
});

test("a detached (closed) window never sends another prompt", async () => {
  const h = harness();
  await h.q.handle({ type: "queue_add", text: "a" });
  h.q.detach();
  await h.q.handle({ type: "queue_set_auto", value: true });
  await settle();
  assert.deepEqual(h.ran, []);
});


// ---- every prompt is in the history -------------------------------------------------
//
// The complaint that caused this (2026-09-14): a ticket conversation worked for a week
// showed 13 history entries - the three queued items and their lifecycle - while every
// prompt the technician had typed was missing. "History" has to mean the conversation's
// prompts, not just the queue's own paperwork.

test("a typed prompt is recorded, whoever typed it and wherever from", async () => {
  const h = harness();
  h.q.notePrompt("check the print spooler", "browser");
  h.q.notePrompt("now restart it", "phone");
  h.q.notePrompt("stop - do the other server first", "browser", { steer: true });
  const hist = await h.history();
  assert.deepEqual(hist.map((e) => e.event), ["prompt", "prompt_phone", "steer"]);
  assert.equal(hist[0].text, "check the print spooler");
  assert.match(hist[1].detail, /phone/);
});

test("a queue-driven prompt is not recorded twice", async () => {
  const h = harness({ autoClear: false });
  await h.q.handle({ type: "queue_add", text: "queued job" });
  await h.q.handle({ type: "queue_run_next" });
  await settle(10);
  h.q.notePrompt("queued job", "queue");        // the runner also calls this path
  const events = (await h.history()).map((e) => e.event);
  assert.deepEqual(events, ["added", "started", "done"]);
  assert.equal(events.filter((e) => e === "prompt").length, 0);
});

test("an attached file is noted, but its inlined body is not dumped into the history", async () => {
  const h = harness();
  h.q.notePrompt(
    "why is this failing?\n\nThe technician attached 1 file(s). Their full contents follow between markers.\n\n" +
      "[[pi-attachment:errors.log|42]]\nSECRET-LOG-BODY\n[[/pi-attachment]]",
    "browser",
  );
  const e = (await h.history())[0];
  assert.equal(e.text, "why is this failing?");
  assert.doesNotMatch(e.text, /SECRET-LOG-BODY/);
  assert.match(e.detail, /errors\.log/);
});

test("an empty or whitespace-only prompt is not recorded", async () => {
  const h = harness();
  h.q.notePrompt("   ", "browser");
  h.q.notePrompt("", "browser");
  assert.equal((await h.history()).length, 0);
});

test("an older conversation's prompts are recovered from its transcript, once", async () => {
  const h = harness();
  await h.q.handle({ type: "queue_add", text: "queued job" });   // an existing queue event
  const n = h.q.backfillPrompts([
    { at: "2026-09-08T10:00:00.000Z", text: "first thing I asked" },
    { at: "2026-09-08T18:00:00.000Z", text: "and this, much later" },
    { at: "2026-09-08T12:00:00.000Z", text: "middle" },
    { at: "2026-09-08T12:05:00.000Z", text: "   " },             // nothing to record
  ]);
  assert.equal(n, 3);
  const hist = await h.history();
  assert.equal(hist.filter((e) => e.event === "prompt").length, 3);
  // Merged in time order, not bolted on the end.
  const times = hist.map((e) => e.at || "");
  assert.deepEqual([...times].sort(), times);
  // Running it again (every window reopen calls it) must not duplicate anything.
  assert.equal(h.q.backfillPrompts([{ at: "2026-09-08T10:00:00.000Z", text: "first thing I asked" }]), 0);
  assert.equal((await h.history()).length, hist.length);
});

test("the recovery flag survives a reopen, so a reopened window does not re-import", async () => {
  const h = harness();
  h.q.backfillPrompts([{ at: "2026-09-08T10:00:00.000Z", text: "asked once" }]);
  h.q.detach();
  const q2 = makePromptQueue({
    scopeKey: "AGENT1", root: h.root, send: () => {}, log: () => {},
    isStreaming: () => false, runPrompt: async () => {}, compact: async () => {},
  });
  q2.attach("sess-1");
  assert.equal(q2.backfillPrompts([{ at: "2026-09-08T10:00:00.000Z", text: "asked once" }]), 0);
  assert.equal(q2.state().history_count, 1);
});

test("queue_state carries a count, never the whole history", async () => {
  const h = harness();
  for (let i = 0; i < 30; i++) h.q.notePrompt(`prompt ${i}`, "browser");
  const st = h.last("queue_state");
  assert.equal(st.history_count, 30);
  assert.equal(st.history, undefined, "the list must not ride on every state frame");
  assert.equal((await h.history()).length, 30);
});

// AUTO-CLEAR: ON by default, OFF only where somebody said so (owner, 2026-09-22).
// "auto clear should always be selected by default unless that chat window turned it off
// which should be persistent".

test("a new conversation has Auto-clear ON without anyone asking", async () => {
  const h = harness();
  assert.equal(h.state().auto_clear_done, true);
  assert.equal(h.last("queue_state").auto_clear_done, true);
  // ...and it behaves like it: a finished item leaves the list on its own.
  await h.q.handle({ type: "queue_add", text: "a" });
  await h.q.handle({ type: "queue_run_next" });
  await settle(6);
  assert.deepEqual(h.state().items, []);
});

test("turning Auto-clear off is remembered by that conversation, and reported to the window memory", async () => {
  const seen = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-queue-ac-"));
  const mk = (autoClearDefault) => makePromptQueue({
    scopeKey: "AGENT1", root, send: () => {}, log: () => {},
    isStreaming: () => false, runPrompt: async () => {}, compact: async () => {},
    autoClearDefault,
    onSwitch: (name, value, actor) => seen.push([name, value, actor?.user || ""]),
  });

  const q1 = mk(true);
  q1.attach("sess-1");
  assert.equal(q1.state().auto_clear_done, true);
  await q1.handle({ type: "queue_set_auto_clear", value: false }, { user: "dan", display: "Dan Ops" });
  assert.equal(q1.state().auto_clear_done, false);
  // The caller is told, so window-memory.js can keep it for the next session of this window.
  assert.deepEqual(seen, [["auto_clear", false, "dan"]]);
  q1.detach();

  // SAME session file: the explicit choice wins over the default.
  const q2 = mk(true);
  q2.attach("sess-1");
  assert.equal(q2.state().auto_clear_done, false);

  // A NEW session ("New chat") in a window that remembered OFF opens off...
  const q3 = mk(false);
  q3.attach("sess-2");
  assert.equal(q3.state().auto_clear_done, false);
  // ...while a window that never chose opens ON, whatever its old session file said.
  const q4 = mk(true);
  q4.attach("sess-3");
  assert.equal(q4.state().auto_clear_done, true);
});

test("state written before the default changed does not count as 'turned off'", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-queue-legacy-"));
  const dir = path.join(root, "AGENT1", "queue");
  fs.mkdirSync(dir, { recursive: true });
  // What every queue file looked like when OFF was the default: false, with nobody having
  // chosen it. Reading that as a deliberate choice would leave the fleet's windows off.
  fs.writeFileSync(path.join(dir, "old.json"), JSON.stringify({
    version: 1, auto_next: false, auto_clear_done: false, items: [], questions: [], history: [],
  }));
  const q = makePromptQueue({
    scopeKey: "AGENT1", root, send: () => {}, log: () => {},
    isStreaming: () => false, runPrompt: async () => {}, compact: async () => {},
  });
  q.attach("old");
  assert.equal(q.state().auto_clear_done, true);
});

test("the switch is in the history, with who flipped it", async () => {
  const h = harness();
  await h.q.handle({ type: "queue_set_auto_clear", value: false }, { user: "chris", display: "Chris Tech" });
  const row = (await h.history()).find((e) => e.event === "auto_clear");
  assert.equal(row.detail, "off");
  assert.equal(row.by, "Chris Tech");
});

test("reopening a window with Auto-clear on clears what finished while it was closed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-queue-reopen-ac-"));
  const dir = path.join(root, "AGENT1", "queue");
  fs.mkdirSync(dir, { recursive: true });
  // A file from before the rule changed: done items held back because they carried a Q&A,
  // plus the ones that legitimately still need a human.
  fs.writeFileSync(path.join(dir, "sess-9.json"), JSON.stringify({
    version: 1, auto_next: false, auto_clear_done: true, auto_clear_set: true,
    items: [
      { id: "1", text: "finished with a Q&A", status: "done", thread: [{ role: "assistant", text: "ok?", at: null }] },
      { id: "2", text: "failed one", status: "failed", thread: [] },
      { id: "3", text: "skipped one", status: "skipped", thread: [] },
      { id: "4", text: "still to run", status: "pending", thread: [] },
    ],
    questions: [], history: [],
  }));
  const frames = [];
  const q = makePromptQueue({
    scopeKey: "AGENT1", root, send: (f) => frames.push(f), log: () => {},
    isStreaming: () => false, runPrompt: async () => {}, compact: async () => {},
  });
  q.attach("sess-9");
  assert.deepEqual(q.state().items.map((i) => i.text), ["failed one", "skipped one", "still to run"]);
  await q.handle({ type: "queue_history" });
  const hist = frames.filter((f) => f.type === "queue_history").at(-1).history;
  assert.equal(hist.filter((e) => e.event === "auto_cleared").length, 1);
});
