import test from "node:test";
import assert from "node:assert/strict";
import { makeTurnWatchdog } from "../src/turn-watchdog.js";
import { makeLlmRecovery } from "../src/llm-recovery.js";

// The exact message a watchdog abort produces, observed 2026-08-18 in session 01a014e5:
// a preamble sentence, no tool call, zero usage, stopReason "aborted".
const abortedMessage = () => ({
  role: "assistant",
  stopReason: "aborted",
  errorMessage: "OpenAI Responses stream ended before a terminal response event",
  content: [{ type: "text", text: "Sending a technical performance report to chris@..." }],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
});

/**
 * A session that reproduces the incident: it streams a preamble, then goes silent.
 * `finishAfter` re-runs that actually complete are allowed to answer, so a test can
 * assert the difference between "the retry worked" and "it stalled again".
 */
function fakeSession({ silentForever = true } = {}) {
  const s = {
    isStreaming: true,
    aborts: 0,
    continues: 0,
    messages: [{ role: "user", content: "email me the report" }, abortedMessage()],
    // The bridge's message_end handler, reduced to the decision it makes.
    onMessageEnd: null,
    agent: {
      state: {
        get messages() { return s.messages.slice(); },
        set messages(v) { s.messages = v.slice(); },
      },
      continue: async () => {
        s.continues += 1;
        s.isStreaming = true;
        if (!silentForever) {
          // The model answers this time: the turn settles normally.
          s.isStreaming = false;
          s.messages.push({ role: "assistant", stopReason: "stop", content: [] });
        }
      },
    },
    abort: async () => {
      s.aborts += 1;
      s.isStreaming = false;
      // message_end fires synchronously inside abort() - this is what makes claiming
      // the abort BEFORE calling abort() load-bearing.
      s.onMessageEnd?.(abortedMessage());
    },
  };
  return s;
}

/** Wires a recovery + watchdog exactly as server.js does, with test-sized budgets. */
function rig({ silentForever = true, stallMs = 100, escalation = 3, maxStallMs = 1000,
              maxStallAttempts = 1 } = {}) {
  const logs = [];
  const notified = [];
  const session = fakeSession({ silentForever });
  const recovery = makeLlmRecovery({
    log: (...a) => logs.push(a[0]), key: "k", sessionId: "s", baseDelayMs: 1, maxStallAttempts,
  });
  // The server's message_end branch: re-run if the abort was ours, else tell the tech.
  session.onMessageEnd = (message) => {
    if (!recovery.isOwnStallAbort(message)) return;
    if (!recovery.consider(message)) notified.push(recovery.exhaustedNote("stall"));
  };
  let lastActivity = Date.now() - 10_000; // already silent
  const watchdog = makeTurnWatchdog({
    session, recovery, log: (...a) => logs.push(a[0]), key: "k", sessionId: "s",
    toolsInFlight: () => session.toolsInFlight || 0,
    lastActivityAt: () => lastActivity,
    stallMs, escalation, maxStallMs,
    timers: { setInterval: () => 1, clearInterval: () => {} },
  });
  return {
    session, recovery, watchdog, logs, notified,
    touch: () => { lastActivity = Date.now(); },
  };
}

test("the incident, end to end: a silent turn is aborted AND re-run", async () => {
  const r = rig({ silentForever: false });
  assert.equal(await r.watchdog.check(), true, "the stall was acted on");
  assert.equal(r.session.aborts, 1, "turn aborted");
  assert.equal(r.session.continues, 1, "and re-run - this is what never happened before");
  assert.deepEqual(r.notified, [], "the technician is not bothered with a resend request");
  assert.ok(r.logs.includes("turn_stall"));
  assert.ok(r.logs.includes("llm_recover"));
  // The aborted message left live state, so continue() resumes from the user's request.
  assert.equal(r.session.messages.filter((m) => m.stopReason === "aborted").length, 0);
});

test("the retry gets a wider budget - the same limit would just fail again", async () => {
  const r = rig({ stallMs: 100, escalation: 3, maxStallMs: 1000 });
  assert.equal(r.watchdog.budgetMs, 100);
  await r.watchdog.check();
  assert.equal(r.watchdog.budgetMs, 300, "widened for the second attempt");
});

test("the widened budget is capped, so nothing hangs indefinitely", async () => {
  const r = rig({ stallMs: 100, escalation: 100, maxStallMs: 250 });
  await r.watchdog.check();
  assert.equal(r.watchdog.budgetMs, 250);
});

test("a mis-set escalation can never tighten the leash", async () => {
  const r = rig({ stallMs: 100, escalation: 0 });
  await r.watchdog.check();
  assert.equal(r.watchdog.budgetMs, 100, "floor is the current budget");
});

test("a new request goes back to the tight budget", async () => {
  const r = rig();
  await r.watchdog.check();
  assert.equal(r.watchdog.budgetMs, 300);
  r.watchdog.resetBudget();
  assert.equal(r.watchdog.budgetMs, 100, "the wider leash was for that request only");
});

test("when the widened attempt stalls too, the technician is told - usefully", async () => {
  const r = rig({ silentForever: true, stallMs: 20, maxStallAttempts: 1 });
  await r.watchdog.check();          // stall 1: aborted, re-run
  assert.equal(r.session.continues, 1);
  assert.deepEqual(r.notified, []);
  // The re-run goes silent as well, now against the widened 60ms budget.
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(await r.watchdog.check(), true, "stall 2 acted on");
  assert.equal(r.session.aborts, 2);
  assert.equal(r.session.continues, 1, "budget spent - no third attempt");
  assert.equal(r.notified.length, 1, "now the technician hears about it");
  assert.match(r.notified[0], /in pieces/, "with advice that can actually work");
});

// Regression: the first cut of this watchdog re-ran the turn without re-arming, and
// `handled` only resets while the session is NOT streaming - which the re-run had already
// undone. The retried turn was therefore never watched, so a re-run that hung, hung
// forever. Strictly worse than the bug being fixed.
test("the retried turn is watched too - a re-run that hangs must not hang forever", async () => {
  const r = rig({ silentForever: true, stallMs: 20, maxStallAttempts: 5 });
  await r.watchdog.check();
  assert.equal(r.session.isStreaming, true, "the re-run is streaming again");
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(await r.watchdog.check(), true, "still being watched");
  assert.equal(r.session.aborts, 2);
});

test("the re-run itself counts as activity - no instant second abort", async () => {
  // lastActivity is 10s stale for the whole test, so only the activity floor can
  // stop the retried turn from being declared stalled the moment it starts.
  const r = rig({ silentForever: true, stallMs: 5_000, maxStallAttempts: 5 });
  r.session.isStreaming = true;
  // Force the first stall with a tight budget, then let it widen.
  const tight = rig({ silentForever: true, stallMs: 20, maxStallAttempts: 5 });
  await tight.watchdog.check();
  assert.equal(tight.session.aborts, 1);
  assert.equal(await tight.watchdog.check(), false,
    "immediately after the re-run there has been no silence to measure");
  assert.equal(tight.session.aborts, 1);
});

test("silence while a tool is running is not a stall - device commands take minutes", async () => {
  const r = rig();
  r.session.toolsInFlight = 1;
  assert.equal(await r.watchdog.check(), false);
  assert.equal(r.session.aborts, 0, "a long fio run must never be killed");
});

test("a turn that is not streaming is not a stall", async () => {
  const r = rig();
  r.session.isStreaming = false;
  assert.equal(await r.watchdog.check(), false);
  assert.equal(r.session.aborts, 0);
});

test("activity inside the budget resets the clock", async () => {
  const r = rig({ stallMs: 5000 });
  r.touch();
  assert.equal(await r.watchdog.check(), false);
  assert.equal(r.session.aborts, 0);
});

test("one abort per stall, however often the interval fires", async () => {
  const r = rig({ silentForever: true });
  // Re-enter while the first abort is still settling: `handled` must hold the door.
  const first = r.watchdog.check();
  const second = r.watchdog.check();
  await Promise.all([first, second]);
  assert.equal(r.session.aborts, 1);
});

test("stallMs=0 disables the watchdog entirely", () => {
  let started = 0;
  const r = rig({ stallMs: 0 });
  const w = makeTurnWatchdog({
    session: r.session, recovery: r.recovery, stallMs: 0,
    timers: { setInterval: () => { started += 1; return 1; }, clearInterval: () => {} },
  });
  w.start();
  assert.equal(started, 0, "no timer armed");
});

// ---------------------------------------------------------------------------
// Liveness read off the socket, not inferred from event gaps. Measured on the real
// stream: 74,850ms between parsed events while the wire went quiet for at most
// 14,474ms, because xAI heartbeats every 15s and SSE comments are dropped by the parser.
// ---------------------------------------------------------------------------

/** A liveness tracker frozen at a chosen "last byte was N ms ago". */
const livenessAt = (quietMs, { bytes = 4096, chunks = 12, elapsedMs = 200_000 } = {}) => ({
  quietMs: () => quietMs,
  elapsedMs: () => elapsedMs,
  get bytes() { return bytes; },
  get chunks() { return chunks; },
  reset() {},
});

test("a long quiet think with bytes still arriving is NEVER aborted", async () => {
  // The exact 2026-08-18 shape: nothing parseable for minutes, heartbeat 4s ago.
  const r = rig({ stallMs: 20 });
  const w = makeTurnWatchdog({
    session: r.session, recovery: r.recovery, log: () => {},
    lastActivityAt: () => Date.now() - 200_000,   // the old rule would have killed this
    liveness: livenessAt(4_000),
    deadStreamMs: 60_000, stallMs: 20,
    timers: { setInterval: () => 1, clearInterval: () => {} },
  });
  assert.equal(await w.check(), false, "the model is working - leave it alone");
  assert.equal(r.session.aborts, 0);
});

test("a genuinely dead stream is caught, and faster than the old guess", async () => {
  const r = rig({ silentForever: false });
  const w = makeTurnWatchdog({
    session: r.session, recovery: r.recovery, log: (...a) => r.logs.push(a[0]),
    lastActivityAt: () => Date.now(),             // events look recent; the wire is dead
    liveness: livenessAt(61_000),
    deadStreamMs: 60_000, stallMs: 180_000,       // old rule would still be waiting
    timers: { setInterval: () => 1, clearInterval: () => {} },
  });
  assert.equal(await w.check(), true);
  assert.equal(r.session.aborts, 1);
  assert.equal(r.session.continues, 1, "a dead socket is usually transient - still retried");
});

test("one missed heartbeat is not a death", async () => {
  const r = rig();
  const w = makeTurnWatchdog({
    session: r.session, recovery: r.recovery, log: () => {},
    lastActivityAt: () => Date.now() - 300_000,
    liveness: livenessAt(16_000),   // one 15s cadence missed by a whisker
    deadStreamMs: 60_000, stallMs: 20,
    timers: { setInterval: () => 1, clearInterval: () => {} },
  });
  assert.equal(await w.check(), false, "must tolerate jitter around the cadence");
});

test("a stream that heartbeats forever still hits an absolute ceiling", async () => {
  const r = rig({ silentForever: false });
  const w = makeTurnWatchdog({
    session: r.session, recovery: r.recovery, log: () => {},
    lastActivityAt: () => Date.now(),
    liveness: livenessAt(2_000, { elapsedMs: 21 * 60 * 1000 }),
    deadStreamMs: 60_000, maxTurnMs: 20 * 60 * 1000, stallMs: 20,
    timers: { setInterval: () => 1, clearInterval: () => {} },
  });
  assert.equal(await w.check(), true, "alive but never finishing is still a failure");
});

test("with no transport signal it falls back to the old event-gap guess", async () => {
  // quietMs() === null means "never observed" - an unwrapped provider, or the hook
  // failing. The safety net must not vanish with it.
  const r = rig({ silentForever: false });
  const w = makeTurnWatchdog({
    session: r.session, recovery: r.recovery, log: () => {},
    lastActivityAt: () => Date.now() - 200_000,
    liveness: { quietMs: () => null, elapsedMs: () => 200_000, bytes: 0, chunks: 0, reset() {} },
    deadStreamMs: 60_000, stallMs: 180_000,
    timers: { setInterval: () => 1, clearInterval: () => {} },
  });
  assert.equal(await w.check(), true, "fallback still protects the chat");
  assert.equal(r.session.aborts, 1);
});

test("no liveness object at all behaves exactly as before", async () => {
  const r = rig({ silentForever: false, stallMs: 20 });
  assert.equal(await r.watchdog.check(), true, "unchanged for callers that pass none");
});

test("an abort that fails is logged, and the re-run still happens", async () => {
  const r = rig({ silentForever: false });
  r.session.abort = async () => {
    r.session.isStreaming = false;
    r.session.onMessageEnd?.(abortedMessage());
    throw new Error("socket gone");
  };
  assert.equal(await r.watchdog.check(), true);
  assert.ok(r.logs.includes("turn_stall abort error"));
  assert.equal(r.session.continues, 1, "a failed abort must not lose the recovery");
});
