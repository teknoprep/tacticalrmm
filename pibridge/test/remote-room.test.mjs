// What the phone is allowed to do, and what it must never be able to do.
//
// The binding is the ONLY thing standing between a device on the internet and a live AI
// session with device tools on it, so the cases that matter here are the refusals.
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeRemoteBinding, toWireMessages, toWireHistory, browserFrameToPhone, modelForPhone } from "../src/remote-room.js";

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

test("asking for a code with no room opens one instead of refusing", async () => {
  // The browser puts its pairing dialog up on the click and waits for `remote_pairing`.
  // Refusing with "turn Remote on first" left that dialog spinning forever, so the two
  // requests are now the same intent. The relay here does not resolve, which is how we
  // can tell the room was genuinely attempted.
  const h = harness({ remote_allowed: true, remote_relay_url: "https://relay.example" });
  await h.binding.handleBrowser({ type: "remote_pair" });

  assert.equal(h.sent.at(-1).type, "remote_state");
  assert.match(h.sent.at(-1).error, /Could not reach the relay/,
    "a failure to open must be reported as what it was");
  assert.equal(h.binding.active, false, "a room that failed to open is not left half-alive");
  assert.ok(!h.sent.some((f) => f.type === "remote_pairing"),
    "no pairing code may be minted without a live room");
});

test("a role without the permission cannot mint a code either", async () => {
  // set_remote is not the only door into a room - remote_pair opens one too, so it has
  // to carry the same refusal.
  const h = harness({ remote_allowed: false, remote_relay_url: "https://relay.example" });
  const consumed = await h.binding.handleBrowser({ type: "remote_pair" });

  assert.equal(consumed, true);
  assert.equal(h.binding.active, false);
  assert.match(h.sent.at(-1).error, /not enabled for your role|no relay/i);
  assert.ok(!h.sent.some((f) => f.type === "remote_pairing"));
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

// ---- history: what a phone sees when it pairs into a conversation already running ----
//
// The transcript handed in here is `uiTranscript()` output - SDK messages carrying content
// BLOCKS. An earlier version read a `.text` property that no message has, so every synced
// bubble arrived empty and every tool call was dropped: the phone showed a blank chat.

const TRANSCRIPT = [
  { role: "user", content: [{ type: "text", text: "printer is down" }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "checking the spooler" },
      { type: "toolCall", id: "call-1", name: "run_device_command", arguments: { cmd: "Get-Service spooler" } },
    ],
  },
  { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "Stopped" }] },
  { role: "assistant", content: [{ type: "text", text: "the spooler is stopped; starting it" }] },
];

test("history carries the WORDS, not empty bubbles", () => {
  const events = toWireHistory(TRANSCRIPT);
  const texts = events.filter((e) => e.text).map((e) => e.text);
  assert.deepEqual(texts, [
    "printer is down",
    "checking the spooler",
    "the spooler is stopped; starting it",
  ]);
  assert.ok(!events.some((e) => e.text === ""), "an empty bubble is worse than no bubble");
});

test("history carries what Pi RAN, not just what it said", () => {
  const events = toWireHistory(TRANSCRIPT);
  const req = events.find((e) => e.type === "tool_request");
  const res = events.find((e) => e.type === "tool_result");
  assert.equal(req.tool, "run_device_command");
  assert.deepEqual(req.args, { cmd: "Get-Service spooler" });
  assert.equal(req.tool_call_id, "call-1");
  assert.equal(res.tool_call_id, req.tool_call_id, "the result must pair with its call");
  assert.equal(res.result, "Stopped");
});

test("a reply is threaded to the question, not to itself", () => {
  const events = toWireHistory(TRANSCRIPT);
  const ask = events.find((e) => e.type === "user_input");
  const answers = events.filter((e) => e.type === "agent_message");
  for (const a of answers) {
    assert.equal(a.in_reply_to, ask.id, "both answers belong to the one question asked");
  }
});

test("history is ordered, and keeps real timestamps when the SDK has them", () => {
  const events = toWireHistory(TRANSCRIPT);
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].ts >= events[i - 1].ts, "the phone renders these in order");
  }
  const stamped = toWireHistory([
    { role: "user", timestamp: 1700000000000, content: [{ type: "text", text: "a" }] },
    { role: "assistant", timestamp: 1700000005000, content: [{ type: "text", text: "b" }] },
  ]);
  assert.equal(stamped[0].ts, 1700000000000, "a resumed chat is not stamped as if it just happened");
  assert.equal(stamped[1].ts, 1700000005000);
});

test("a photo sent from the phone survives a re-sync", () => {
  const events = toWireHistory([
    {
      role: "user",
      content: [
        { type: "image", data: "AAAA", mimeType: "image/jpeg" },
        { type: "text", text: "this screen" },
      ],
    },
  ]);
  assert.deepEqual(events[0].images, [{ data: "AAAA", mime: "image/jpeg" }]);
  assert.equal(events[0].text, "this screen");
});

test("the compaction divider explains its own gap on the phone too", () => {
  const events = toWireHistory([
    { role: "system", content: [{ type: "text", text: "--- earlier turns were summarised ---" }] },
    { role: "user", content: [{ type: "text", text: "carry on" }] },
  ]);
  assert.equal(events[0].type, "compaction");
  assert.match(events[0].summary, /summarised/);
});

test("a tool result never reaches the phone as [object Object]", () => {
  // The live event wraps content; the stored message does not. Both must read the same.
  const live = toWireMessages(
    { type: "tool_execution_end", toolCallId: "c1", result: { content: [{ type: "text", text: "OK" }], details: {} } },
    "t1",
  );
  const synced = toWireHistory([{ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "OK" }] }]);
  assert.equal(live[0].result, "OK");
  assert.equal(synced[0].result, "OK", "live and re-sync must agree word for word");
});

test("an answer that never streamed still reaches the phone", () => {
  // A replayed or non-streaming turn produces no text deltas. The window renders it from
  // the finished message; before this the phone showed an empty turn.
  const seen = { streamed: false };
  const out = toWireMessages(
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "all done" }] } },
    "t9",
    seen,
  );
  assert.equal(out[0].type, "agent_message");
  assert.equal(out[0].text, "all done");
  assert.equal(out[1].type, "agent_done");
});

test("an answer that DID stream is not sent twice", () => {
  const seen = { streamed: false };
  toWireMessages({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "all " } }, "t9", seen);
  const out = toWireMessages(
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "all done" }] } },
    "t9",
    seen,
  );
  assert.equal(out.length, 1, "only the done marker - the words already went as chunks");
  assert.equal(out[0].type, "agent_done");
});

// ---- what the window says out loud, the phone must hear ------------------------------
//
// `onError` shipped on the binding and was never called from anywhere: the window showed
// provider errors while the phone sat in silence. These now travel through one
// interception point, so the two surfaces cannot drift again.

test("an error on screen is an error on the phone", () => {
  const out = browserFrameToPhone({ type: "error", message: "The provider returned nothing." });
  assert.equal(out.type, "error");
  assert.match(out.message, /provider returned nothing/);
});

test("a blank error is not worth waking a phone for", () => {
  assert.equal(browserFrameToPhone({ type: "error", message: "  " }), null);
});

test("notices the window prints are relayed as ordinary replies", () => {
  const cases = [
    [{ type: "system_note", text: "Write mode is now ON." }, /Write mode is now ON/],
    [{ type: "compacted", message: "Conversation compacted: 40,000 tokens summarised." }, /compacted/],
    [{ type: "cost_warning", message: "That turn cost $1.20." }, /\$1\.20/],
    [{ type: "model_changed", display: "Claude Sonnet 5" }, /Switched model to Claude Sonnet 5/],
    [{ type: "info", message: "Ticket assigned to chris" }, /assigned to chris/],
  ];
  for (const [frame, re] of cases) {
    const out = browserFrameToPhone(frame, "t3");
    assert.equal(out.type, "agent_message", `${frame.type} must reach the phone`);
    assert.equal(out.in_reply_to, "t3");
    assert.match(out.text, re);
  }
});

test("chatter the phone has no use for is dropped", () => {
  for (const frame of [
    { type: "working", elapsed_ms: 4000 },
    { type: "cost_update", session_cost: 0.4 },
    { type: "readonly_state", value: true },
    { type: "agent_event", event: {} },
  ]) {
    assert.equal(browserFrameToPhone(frame), null, `${frame.type} is not a message`);
  }
});

// ---- the phone's model picker -------------------------------------------------------
//
// `blob.model_id` is what the window ASKED for. Since model-memory landed, a reopened
// window can be running something else, so the phone has to be told what the session is
// actually on - and whether it can take a photo.

test("the phone is told the LIVE model, not the one the blob asked for", () => {
  // The window opened asking for haiku; model-memory reopened it on grok. A picker
  // showing "claude-haiku-4" is how a technician switches to the model they are on.
  const blob = { provider: "anthropic", model_id: "claude-haiku-4" };
  const live = {
    id: "grok-4.5", name: "Grok 4.5", provider: "xai",
    reasoning: true, input: ["text", "image"], contextWindow: 2000000,
  };
  assert.deepEqual(modelForPhone(live, blob), {
    id: "grok-4.5",
    name: "Grok 4.5",
    provider: "xai",
    reasoning: true,
    context_window: 2000000,
    vision: true,
  });
});

test("with no live model yet, the blob is the fallback and promises nothing", () => {
  const out = modelForPhone(null, { provider: "anthropic", model_id: "claude-haiku-4" });
  assert.equal(out.id, "claude-haiku-4");
  assert.equal(out.provider, "anthropic");
  assert.equal(out.vision, false, "an unresolved model must not promise a camera");
  assert.equal(out.reasoning, false);
  assert.equal(out.context_window, 0);
});

test("vision decides whether the phone may attach a photo", () => {
  // The app greys its attach button on this. Hard-coded false took away the one thing a
  // phone has that the browser does not.
  assert.equal(modelForPhone({ input: ["text", "image"] }).vision, true);
  assert.equal(modelForPhone({ input: ["text"] }).vision, false);
  assert.equal(modelForPhone({}).vision, false, "an unknown input list is not a camera");
});
