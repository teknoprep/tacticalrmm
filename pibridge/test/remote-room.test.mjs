// What the phone is allowed to do, and what it must never be able to do.
//
// The binding is the ONLY thing standing between a device on the internet and a live AI
// session with device tools on it, so the cases that matter here are the refusals.
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeRemoteBinding, toWireMessages, toWireHistory } from "../src/remote-room.js";

function harness(blob = {}) {
  const sent = [];
  const prompts = [];
  const approvals = [];
  let aborted = 0;
  const binding = makeRemoteBinding({
    blob: { username: "tech", remote_allowed: false, remote_relay_url: "", ...blob },
    key: "agent-1",
    label: "PC-1",
    log: () => {},
    toBrowser: (f) => sent.push(f),
    submitPrompt: async (t, i) => prompts.push({ text: t, images: i }),
    abort: async () => { aborted++; },
    resolveApproval: (id, ok) => approvals.push({ id, ok }),
    transcript: () => [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }],
  });
  return { binding, sent, prompts, approvals, aborted: () => aborted };
}

test("a role without the permission cannot switch Remote on", async () => {
  const h = harness({ remote_allowed: false, remote_relay_url: "https://relay.example" });
  const consumed = await h.binding.handleBrowser({ type: "set_remote", value: true });

  assert.equal(consumed, true, "the binding owns set_remote either way");
  assert.equal(h.binding.active, false, "no room may be opened");
  const state = h.sent.at(-1);
  assert.equal(state.type, "remote_state");
  assert.equal(state.enabled, false);
  assert.match(state.error, /not enabled for your role|no relay/i,
    "the switch must snap back with a reason, not fail silently");
});

test("a permitted role with no relay configured still cannot switch it on", async () => {
  const h = harness({ remote_allowed: true, remote_relay_url: "" });
  await h.binding.handleBrowser({ type: "set_remote", value: true });

  assert.equal(h.binding.active, false,
    "a blank relay URL is the global off switch and outranks the permission");
});

test("pairing is refused before the room exists", async () => {
  const h = harness({ remote_allowed: true, remote_relay_url: "https://relay.example" });
  await h.binding.handleBrowser({ type: "remote_pair" });

  assert.equal(h.sent.at(-1).type, "remote_state");
  assert.match(h.sent.at(-1).error, /Turn Remote on first/);
  assert.ok(!h.sent.some((f) => f.type === "remote_pairing"),
    "no pairing code may be minted without a live room");
});

test("frames the binding does not own are passed through to the surface", async () => {
  const h = harness({ remote_allowed: true, remote_relay_url: "https://relay.example" });
  for (const type of ["prompt", "abort", "set_readonly", "approve", "compact"]) {
    assert.equal(await h.binding.handleBrowser({ type }), false,
      `${type} belongs to the chat surface, not the remote binding`);
  }
});

test("agent events become app wire messages", () => {
  assert.deepEqual(
    toWireMessages({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "abc" } }, "t7"),
    [{ type: "agent_chunk", in_reply_to: "t7", delta: "abc" }],
  );

  assert.deepEqual(
    toWireMessages({ type: "tool_execution_start", toolCallId: "c1", toolName: "run_command", args: { cmd: "ipconfig" } }),
    [{ type: "tool_request", tool_call_id: "c1", tool: "run_command", args: { cmd: "ipconfig" } }],
  );

  const [failed] = toWireMessages({
    type: "tool_execution_end", toolCallId: "c1", isError: true,
    result: { content: [{ type: "text", text: "access denied" }] },
  });
  assert.equal(failed.error, "access denied", "a failed tool must arrive as an error, not a result");
});

test("a huge tool result is clipped before it goes down a phone link", () => {
  const [msg] = toWireMessages({
    type: "tool_execution_end", toolCallId: "c2", isError: false,
    result: { content: [{ type: "text", text: "x".repeat(50_000) }] },
  });
  assert.ok(msg.result.length < 2_200, "the phone gets an indicator; the browser keeps the full output");
  assert.match(msg.result, /truncated/);
});

test("an event with nothing to say produces no traffic", () => {
  assert.deepEqual(toWireMessages({ type: "agent_start" }, "t1"), []);
  assert.deepEqual(toWireMessages({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }, "t1"), []);
});

test("history maps to the app's sync shape in order", () => {
  const events = toWireHistory([
    { role: "user", text: "printer is down" },
    { role: "assistant", text: "checking the spooler" },
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "user_input");
  assert.equal(events[1].type, "agent_message");
  assert.ok(events[0].ts <= events[1].ts, "the phone renders these in order");
});
