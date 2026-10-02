// A BACKUP MODEL PER ROLE (owner, 2026-09-27).
//
// xAI refused every request for two days with 403 "has either used all available credits or
// reached its monthly spending limit", and each affected turn died mid-flight: retrying the same
// provider is pure cost, and there was nothing else to fall back to. A role may now name a backup
// model. The bridge switches to it and carries on with the SAME conversation.
import test from "node:test";
import assert from "node:assert/strict";
import { fallbackMember } from "../src/agent-groups.js";
import { makeLlmRecovery, couldBeAnotherProvider } from "../src/llm-recovery.js";

const GROUP = {
  name: "IT",
  roles: [
    { role: "orchestrator", provider: "deepseek", model_id: "deepseek-flash", thinking_level: "high",
      fallback_provider: "anthropic", fallback_model_id: "claude-sonnet-5", fallback_thinking_level: "medium" },
    { role: "scout", provider: "anthropic", model_id: "claude-haiku-4-5", thinking_level: "low" },
    { role: "judge", provider: "anthropic", model_id: "claude-opus-5", thinking_level: "high",
      fallback_provider: "anthropic", fallback_model_id: "claude-sonnet-5", fallback_thinking_level: "" },
  ],
};

test("the backup is found for a role, with its own thinking level", () => {
  const fb = fallbackMember(GROUP, "orchestrator", { provider: "deepseek", model_id: "deepseek-flash" });
  assert.deepEqual(fb, { provider: "anthropic", model_id: "claude-sonnet-5", thinking_level: "medium" });
});

test("a role with no backup returns nothing, so behaviour is unchanged", () => {
  assert.equal(fallbackMember(GROUP, "scout"), null);
  assert.equal(fallbackMember(GROUP, "does-not-exist"), null);
  assert.equal(fallbackMember(null, "orchestrator"), null);
});

test("a backup that IS the current model is refused (a misconfiguration cannot 'fall back' to itself)", () => {
  assert.equal(fallbackMember(GROUP, "orchestrator", { provider: "anthropic", model_id: "claude-sonnet-5" }), null);
});

test("only provider-level refusals count as 'another provider could survive this'", () => {
  const msg = (why) => ({ role: "assistant", stopReason: "error", errorMessage: why });
  for (const why of [
    'xai API error (403): 403 "Your team has either used all available credits or reached its monthly spending limit."',
    "insufficient_quota: you exceeded your current quota",
    "429 Too Many Requests",
    "invalid api key",
    "model not found",
    "503 Service Unavailable / overloaded",
    "Your account has no available balance",
  ]) assert.ok(couldBeAnotherProvider(msg(why)), why);
  for (const why of [
    "request aborted",
    "The operation was aborted",
    "",
  ]) assert.ok(!couldBeAnotherProvider(msg(why)), why);
  assert.ok(!couldBeAnotherProvider({ role: "assistant", stopReason: "stop" }), "a normal end is not a failure");
});

test("the recovery switches to the backup instead of retrying the refused provider", async () => {
  const calls = [];
  const recovery = makeLlmRecovery({
    log: () => {}, key: "k", sessionId: "s",
    onPermanentFailure: async (message) => {
      calls.push(String(message.errorMessage).slice(0, 40));
      return { provider: "anthropic", model_id: "claude-sonnet-5" };
    },
  });
  const message = { role: "assistant", stopReason: "error",
    errorMessage: 'xai API error (403): 403 "used all available credits or reached its monthly spending limit"' };
  assert.equal(recovery.consider(message), true, "armed as a fallback attempt");

  const continued = [];
  const session = { agent: { state: { messages: [message] }, continue: async () => { continued.push(1); } } };
  assert.equal(await recovery.run(session), true);
  assert.equal(calls.length, 1, "the backup was asked for");
  assert.equal(continued.length, 1, "the conversation carried on");
  assert.equal(session.agent.state.messages.length, 0, "the failed assistant turn left the live state");
});

test("with no backup configured the failure behaves exactly as before", () => {
  const recovery = makeLlmRecovery({ log: () => {}, key: "k", sessionId: "s" });
  const message = { role: "assistant", stopReason: "error", errorMessage: "403 insufficient_quota" };
  assert.equal(recovery.consider(message), false, "no hook, no fallback, no retry");
});

test("the backup is used once per turn, not in a loop", async () => {
  let n = 0;
  const recovery = makeLlmRecovery({
    log: () => {}, key: "k", sessionId: "s",
    onPermanentFailure: async () => { n += 1; return { provider: "x", model_id: "y" }; },
  });
  const message = { role: "assistant", stopReason: "error", errorMessage: "403 insufficient_quota" };
  assert.equal(recovery.consider(message), true);
  await recovery.run({ agent: { state: { messages: [message] }, continue: async () => {} } });
  assert.equal(recovery.consider(message), false, "a second refusal in the same turn does not swap again");
  recovery.beginTurn();
  assert.equal(recovery.consider(message), true, "a new technician turn gets a fresh allowance");
  assert.equal(n, 1);
});

test("a backup that cannot be resolved stands the recovery down rather than looping", async () => {
  const recovery = makeLlmRecovery({
    log: () => {}, key: "k", sessionId: "s",
    onPermanentFailure: async () => null,      // group has no backup, or the switch failed
  });
  const message = { role: "assistant", stopReason: "error", errorMessage: "403 insufficient_quota" };
  assert.equal(recovery.consider(message), true);
  const session = { agent: { state: { messages: [message] }, continue: async () => { throw new Error("should not run"); } } };
  assert.equal(await recovery.run(session), false);
});
