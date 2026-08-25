// Compacting the conversation instead of abandoning it.
//
// Long chats and model switches were the two expensive shapes: every turn re-sends the
// whole history, prompt caching softens that only while you stay on one model, and a
// switch throws the cache away and re-sends everything at full price. The meter already
// warned about both; the only remedy it could offer was "start a new chat".

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCompactCommand, shouldCompact, runCompaction, describeSaving,
  makeCompactCommand, MIN_TOKENS_TO_COMPACT,
} from "../src/compaction.js";

// ------------------------------------------------------------------ the command

test("the command is recognised in the forms people actually type", () => {
  for (const t of ["/compact", "compact", "  /compact  ", "!compact", "COMPACT", "/Compact"]) {
    assert.notEqual(parseCompactCommand(t), null, t);
  }
});

test("custom instructions are carried through", () => {
  assert.equal(parseCompactCommand("/compact keep the fio numbers").instructions,
    "keep the fio numbers");
  assert.equal(parseCompactCommand("/compact").instructions, undefined);
});

test("an ordinary request that happens to contain the word is NOT a command", () => {
  // The bare word only counts as a command when it is the entire message. Otherwise
  // "compact the disk on server X" would vanish into a summarisation instead of being
  // answered - the technician would watch their question disappear.
  for (const t of [
    "compact the disk on server X",
    "can you compact this report",
    "compaction please",
    "run a compact on the database",
    "tell me about /compact",
    "",
    null,
  ]) {
    assert.equal(parseCompactCommand(t), null, JSON.stringify(t));
  }
});

// ------------------------------------------------------------------ worth doing?

test("compacting a small conversation is refused - it would not pay for itself", () => {
  const r = shouldCompact({ contextTokens: 5000, contextWindow: 200000 });
  assert.equal(r.worth, false);
  assert.match(r.reason, /would not pay for itself/);
});

test("an empty conversation is refused", () => {
  assert.equal(shouldCompact({ contextTokens: 0 }).worth, false);
  assert.equal(shouldCompact({}).worth, false);
});

test("a large conversation is worth compacting", () => {
  assert.equal(shouldCompact({ contextTokens: MIN_TOKENS_TO_COMPACT + 1, contextWindow: 200000 }).worth, true);
  assert.equal(shouldCompact({ contextTokens: 150000, contextWindow: 200000 }).worth, true);
});

test("a context at or past the window is always worth compacting", () => {
  const r = shouldCompact({ contextTokens: 200000, contextWindow: 200000 });
  assert.equal(r.worth, true);
  assert.match(r.reason, /past the model's window/);
});

// ------------------------------------------------------------------ running it

const okSession = (over = {}) => ({
  isCompacting: false,
  compact: async () => ({ summary: "did things", tokensBefore: 120000, estimatedTokensAfter: 9000 }),
  ...over,
});

test("a successful compaction reports what it saved", async () => {
  const r = await runCompaction(okSession(), { log: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.tokensBefore, 120000);
  assert.equal(r.tokensAfter, 9000);
  assert.equal(r.saved, 111000);
});

test("a failed compaction never throws and leaves the chat usable", async () => {
  const r = await runCompaction(okSession({ compact: async () => { throw new Error("summarisation 400"); } }),
    { log: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /summarisation 400/);
});

test("a concurrent compaction is refused", async () => {
  const r = await runCompaction(okSession({ isCompacting: true }), { log: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /already running/);
});

test("a session without compaction support is handled", async () => {
  assert.equal((await runCompaction({}, { log: () => {} })).ok, false);
  assert.equal((await runCompaction(null, { log: () => {} })).ok, false);
});

// ------------------------------------------------------------------ the saving

test("the saving is described in money, not just tokens", () => {
  const s = describeSaving({
    tokensBefore: 120000, tokensAfter: 20000,
    model: { provider: "xai", id: "grok-4.5" },
    rateLookup: () => ({ input: 2, output: 6, cacheRead: 0.3 }),
  });
  assert.match(s, /120,000 -> 20,000 tokens/);
  assert.match(s, /83% smaller/);
  // 100k tokens saved at $0.30/M cached = $0.03 per turn from here on.
  assert.match(s, /\$0\.030 less per turn/);
});

test("with no pricing it still says something useful", () => {
  const s = describeSaving({ tokensBefore: 120000, tokensAfter: 20000, model: null, rateLookup: null });
  assert.match(s, /120,000 -> 20,000 tokens \(83% smaller\)/);
  assert.doesNotMatch(s, /\$/);
});

test("a compaction that saved nothing is not advertised as a win", () => {
  assert.equal(describeSaving({ tokensBefore: 1000, tokensAfter: 1000 }), "");
  assert.equal(describeSaving({ tokensBefore: 1000, tokensAfter: 2000 }), "");
  assert.equal(describeSaving({ tokensBefore: 0, tokensAfter: 0 }), "");
});

// ------------------------------------------------------------------ end to end

function rig({ contextTokens = 120000, compact } = {}) {
  const sent = [];
  let noted = null;
  const cmd = makeCompactCommand({
    session: okSession(compact ? { compact } : {}),
    costMeter: {
      get contextTokens() { return contextTokens; },
      noteCompaction(n) { noted = n; },
      snapshot: () => ({ type: "cost_update", context_tokens: noted ?? contextTokens }),
    },
    send: (f) => sent.push(f),
    log: () => {},
    currentModel: () => ({ provider: "xai", id: "grok-4.5", contextWindow: 200000 }),
    rateLookup: () => ({ cacheRead: 0.3 }),
  });
  return { cmd, sent, noted: () => noted };
}

test("the technician is told what happened, in money", async () => {
  const r = rig();
  await r.cmd.run("/compact");
  const done = r.sent.find((f) => f.type === "compacted");
  assert.ok(done, "must send a compacted frame");
  assert.equal(done.tokens_before, 120000);
  assert.equal(done.tokens_after, 9000);
  assert.match(done.message, /less per turn/);
  assert.match(done.message, /still readable/, "must say the transcript is not lost");
  assert.equal(r.noted(), 9000, "the meter must be corrected immediately");
  assert.ok(r.sent.some((f) => f.type === "cost_update"), "and the header refreshed");
});

test("a too-small conversation is declined with a reason, not silently", async () => {
  const r = rig({ contextTokens: 3000 });
  const out = await r.cmd.run("/compact");
  assert.equal(out.skipped, true);
  const err = r.sent.find((f) => f.type === "error");
  assert.match(err.message, /Nothing to compact/);
  assert.equal(r.sent.some((f) => f.type === "compacted"), false);
});

test("a failure says the chat is unchanged", async () => {
  const r = rig({ compact: async () => { throw new Error("provider 500"); } });
  await r.cmd.run("/compact");
  const err = r.sent.find((f) => f.type === "error");
  assert.match(err.message, /Could not compact/);
  assert.match(err.message, /exactly as it was/);
});

test("the technician sees it is working before the summarisation call", async () => {
  const r = rig();
  await r.cmd.run("/compact");
  const working = r.sent.find((f) => f.type === "working");
  assert.ok(working, "a summarisation is a slow LLM call - say so up front");
  assert.match(working.note, /Compacting/);
});
