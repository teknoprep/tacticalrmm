import test from "node:test";
import assert from "node:assert/strict";
import { isBlankProviderFailure, makeLlmRecovery } from "../src/llm-recovery.js";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** The exact message shape observed on 2026-08-17 in the multi-machine PBX chat. */
const xaiBlank = {
  role: "assistant",
  stopReason: "error",
  errorMessage: "Sorry, something went wrong.",
  content: [],
  usage: { ...zero, totalTokens: 0 },
};

test("the real xAI failure is recognised as recoverable", () => {
  assert.equal(isBlankProviderFailure(xaiBlank), true);
});

test("an abort is never retried - somebody pressed stop", () => {
  // Also observed in the same log: two turns ended "This operation was aborted".
  assert.equal(isBlankProviderFailure({ ...xaiBlank, errorMessage: "This operation was aborted" }), false);
  assert.equal(isBlankProviderFailure({ ...xaiBlank, errorMessage: "Request cancelled by user" }), false);
});

test("permanent failures are never retried - a retry is pure cost", () => {
  for (const why of [
    "insufficient_quota: you exceeded your current quota",
    "Monthly usage limit reached",
    "401 Unauthorized: invalid api key",
    "This model's maximum context length is 200000 tokens",
    "model_not_found: grok-9 does not exist",
    "Your account is out of budget",
  ]) {
    assert.equal(isBlankProviderFailure({ ...xaiBlank, errorMessage: why }), false, why);
  }
});

test("a turn that produced work is never re-run", () => {
  // Text came back: the model ran. Re-running could duplicate whatever it did.
  assert.equal(isBlankProviderFailure({
    ...xaiBlank,
    content: [{ type: "text", text: "I checked the mailbox and..." }],
  }), false);
  // A tool call was emitted: same reasoning, stronger.
  assert.equal(isBlankProviderFailure({
    ...xaiBlank,
    content: [{ type: "toolCall", toolName: "run_command_on_device" }],
  }), false);
  // Tokens were burned, so the provider did process it - that is a real failure,
  // not a dropped request, and it goes to the technician.
  assert.equal(isBlankProviderFailure({
    ...xaiBlank,
    usage: { ...zero, input: 55000, output: 12, totalTokens: 55012 },
  }), false);
  // Reasoning tokens count too.
  assert.equal(isBlankProviderFailure({
    ...xaiBlank,
    usage: { ...zero, reasoning: 40, totalTokens: 40 },
  }), false);
});

test("only errored assistant messages qualify", () => {
  assert.equal(isBlankProviderFailure({ ...xaiBlank, stopReason: "endTurn" }), false);
  assert.equal(isBlankProviderFailure({ ...xaiBlank, role: "user" }), false);
  assert.equal(isBlankProviderFailure({ ...xaiBlank, errorMessage: "" }), false);
  assert.equal(isBlankProviderFailure(null), false);
});

test("recovery re-runs via continue() without touching the transcript", async () => {
  const logs = [];
  const r = makeLlmRecovery({ log: (...a) => logs.push(a[0]), key: "k", sessionId: "s", baseDelayMs: 1 });
  r.beginTurn();
  assert.equal(r.consider(xaiBlank), true, "should arm");
  assert.equal(r.pending, true);

  let continued = 0;
  const messages = [
    { role: "user", content: "check the archive" },
    { role: "assistant", stopReason: "error", errorMessage: "Sorry, something went wrong." },
  ];
  const session = {
    agent: {
      state: {
        get messages() { return messages.slice(); },
        set messages(v) { messages.length = 0; messages.push(...v); },
      },
      continue: async () => { continued += 1; },
    },
  };
  assert.equal(await r.run(session), true);
  assert.equal(continued, 1, "continue() called");
  // The errored assistant message left live state...
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  // ...and NO synthetic user message was invented to provoke the model.
  assert.equal(messages.filter((m) => m.role === "user").length, 1);
  assert.ok(logs.includes("llm_recover"));
});

test("the budget is finite, and the harness's own budget wins", async () => {
  const r = makeLlmRecovery({ log: () => {}, baseDelayMs: 1, maxAttempts: 2 });
  const session = {
    agent: {
      state: { messages: [{ role: "user", content: "x" }, { role: "assistant", stopReason: "error" }] },
      continue: async () => {},
    },
  };
  r.beginTurn();
  assert.equal(r.consider(xaiBlank), true);
  await r.run(session);
  assert.equal(r.consider(xaiBlank), true);
  await r.run(session);
  // Third time the technician gets told.
  assert.equal(r.consider(xaiBlank), false, "budget exhausted");
  assert.match(r.exhaustedNote("Sorry, something went wrong."), /3 times/);

  // If the harness already retried and gave up, stand down immediately.
  const r2 = makeLlmRecovery({ log: () => {}, baseDelayMs: 1 });
  r2.beginTurn();
  r2.noteHarnessGaveUp();
  assert.equal(r2.consider(xaiBlank), false);
});

test("a new turn gets a fresh budget", async () => {
  const r = makeLlmRecovery({ log: () => {}, baseDelayMs: 1, maxAttempts: 1 });
  const session = {
    agent: {
      state: { messages: [{ role: "user", content: "x" }, { role: "assistant", stopReason: "error" }] },
      continue: async () => {},
    },
  };
  r.beginTurn();
  r.consider(xaiBlank);
  await r.run(session);
  assert.equal(r.consider(xaiBlank), false, "spent for this turn");
  r.beginTurn();
  assert.equal(r.consider(xaiBlank), true, "fresh turn, fresh budget");
});

test("a continue() that throws is reported, not looped", async () => {
  const logs = [];
  const r = makeLlmRecovery({ log: (...a) => logs.push(a[0]), baseDelayMs: 1 });
  r.beginTurn();
  r.consider(xaiBlank);
  const session = {
    agent: {
      state: { messages: [{ role: "user", content: "x" }, { role: "assistant", stopReason: "error" }] },
      continue: async () => { throw new Error("socket hang up"); },
    },
  };
  assert.equal(await r.run(session), false);
  assert.ok(logs.includes("llm_recover_error"));
  assert.equal(r.pending, false, "must not stay armed and spin");
});

// ---------------------------------------------------------------------------
// Regression: the live test on 2026-08-17 retried a bad API key three times.
// The deny-list said "invalid api key"; xAI says "Incorrect API key provided".
// Screening on HTTP status instead of vendor wording is the actual fix.
// ---------------------------------------------------------------------------
test("a 4xx is never retried - the request itself is wrong", () => {
  const real = 'OpenAI API error (400): 400 "Incorrect API key provided. You can obtain an API key from https://console.x.ai."';
  assert.equal(isBlankProviderFailure({ ...xaiBlank, errorMessage: real }), false, "the exact string that slipped through");
  for (const why of [
    "OpenAI API error (401): unauthorized",
    "HTTP 403 forbidden",
    "404 model not found",
    "status: 422 unprocessable entity",
    "error 400 bad request",
  ]) {
    assert.equal(isBlankProviderFailure({ ...xaiBlank, errorMessage: why }), false, why);
  }
});

test("5xx and the timing-related 4xx ARE retried", () => {
  for (const why of [
    "OpenAI API error (500): internal server error",
    "HTTP 502 bad gateway",
    "status 503 service unavailable",
    "504 gateway timeout",
    "error 429 too many requests",   // rate limited: about timing, not the request
    "HTTP 408 request timeout",
  ]) {
    assert.equal(isBlankProviderFailure({ ...xaiBlank, errorMessage: why }), true, why);
  }
});

test("a number that is not a status is not read as one", () => {
  // Must stay retryable: no status here, just a coincidental 3-digit number.
  assert.equal(isBlankProviderFailure({
    ...xaiBlank, errorMessage: "Sorry, something went wrong. (request 400123456)",
  }), true);
  // And a context-length message quoting 400000 tokens is permanent for the RIGHT reason.
  assert.equal(isBlankProviderFailure({
    ...xaiBlank, errorMessage: "maximum context length is 400000 tokens",
  }), false);
});

test("the original xAI fault is still recoverable after the status change", () => {
  assert.equal(isBlankProviderFailure(xaiBlank), true);
});
