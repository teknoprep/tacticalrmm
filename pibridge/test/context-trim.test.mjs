// One oversized tool result must not be able to wedge a conversation.
//
// The case this is built from (2026-09-22): a `helpdesk_call` returned 2.96 MB into a
// 500k-token window. Every prompt afterwards was rejected with input_too_large, and
// "Summarise & clear" refused with "Nothing to compact (session too small)" because the
// only thing after the last cut point was that single result. The window was a dead end.
//
// Run: node --test test/context-trim.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  oversizedEntries, trimOversized, contextBytes, isContextOverflowError, approxTokens,
} from "../src/context-trim.js";

/** A session file shaped like the real one: system, a user turn, a monstrous tool result. */
function sessionWithMonster({ monsterBytes = 3_000_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-trim-"));
  const file = path.join(dir, "2026-09-22T00-00-00-000Z_01a0-trim.jsonl");
  const now = new Date().toISOString();
  const entries = [
    { type: "session", version: 1, id: "01a0-trim", timestamp: now, cwd: dir },
    { type: "message", id: "e1", parentId: null, timestamp: now, message: { role: "user", content: "why is the website flapping?" } },
    { type: "message", id: "e2", parentId: "e1", timestamp: now, message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "helpdesk_call", arguments: { operation: "list_closed_tickets" } }] } },
    { type: "message", id: "e3", parentId: "e2", timestamp: now, message: { role: "toolResult", toolCallId: "call-1", toolName: "helpdesk_call", content: [{ type: "text", text: "T".repeat(monsterBytes) }] } },
    { type: "message", id: "e4", parentId: "e3", timestamp: now, message: { role: "assistant", content: [{ type: "text", text: "Looked at the tickets." }] } },
    { type: "message", id: "e5", parentId: "e4", timestamp: now, message: { role: "toolResult", toolCallId: "call-2", toolName: "run_command_on_device", content: [{ type: "text", text: "small output" }] } },
  ];
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { file, dir };
}

/** The bits of an AgentSession this module touches. */
function fakeSession(file) {
  const sm = SessionManager.open(file);
  return { sessionManager: sm, agent: { state: { messages: sm.buildSessionProjection().messages } } };
}

test("the oversized tool result is found, and only that one", () => {
  const { file } = sessionWithMonster();
  const session = fakeSession(file);
  const hits = oversizedEntries(session);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tool, "helpdesk_call");
  assert.ok(hits[0].size > 2_900_000, `size was ${hits[0].size}`);
});

test("trimming drops it from the context, keeps the conversation, and leaves the transcript alone", () => {
  const { file } = sessionWithMonster();
  const session = fakeSession(file);
  const beforeBytes = contextBytes(session);
  const fileBefore = fs.readFileSync(file, "utf8").length;

  const res = trimOversized(session, { log: () => {} });
  assert.equal(res.trimmed.length, 1);
  assert.match(res.note, /helpdesk_call/);
  assert.match(res.note, /carry on/i);

  // The model is now being sent a fraction of what it was...
  const afterBytes = contextBytes(session);
  assert.ok(afterBytes < beforeBytes / 10, `${afterBytes} vs ${beforeBytes}`);
  // ...and what it IS sent says what was removed and what not to do about it.
  const text = JSON.stringify(session.agent.state.messages);
  assert.match(text, /REMOVED FROM CONTEXT/);
  assert.match(text, /Do NOT re-run the same broad call/);
  // The rest of the conversation survives untouched.
  assert.match(text, /why is the website flapping\?/);
  assert.match(text, /Looked at the tickets\./);
  assert.match(text, /small output/);
  // The agent's next request is the refreshed projection, not the old array.
  assert.equal(session.agent.state.messages.length, session.sessionManager.buildSessionProjection().messages.length);
  // Append-only: the transcript on disk still holds every byte of the original result.
  assert.ok(fs.readFileSync(file, "utf8").length > fileBefore, "the edit is appended, nothing is rewritten");
  assert.ok(fs.readFileSync(file, "utf8").includes("T".repeat(1000)), "the full result is still on disk");
});

test("running it twice does nothing the second time", () => {
  const { file } = sessionWithMonster();
  const session = fakeSession(file);
  assert.equal(trimOversized(session, { log: () => {} }).trimmed.length, 1);
  const second = trimOversized(session, { log: () => {} });
  assert.deepEqual(second.trimmed, []);
  assert.equal(second.note, "");
});

test("an ordinary conversation is never thinned", () => {
  const { file } = sessionWithMonster({ monsterBytes: 5000 });
  const session = fakeSession(file);
  assert.deepEqual(oversizedEntries(session), []);
  const res = trimOversized(session, { log: () => {} });
  assert.deepEqual(res.trimmed, []);
  // Nothing was appended, so nothing claims to have been fixed.
  assert.equal(res.note, "");
});

test("only tool results are ever edited - never what a person or the model said", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-trim-big-"));
  const file = path.join(dir, "2026-09-22T00-00-00-000Z_01a0-big.jsonl");
  const now = new Date().toISOString();
  // A giant PASTED prompt and a giant assistant answer. Both are somebody's words.
  fs.writeFileSync(file, [
    { type: "session", version: 1, id: "01a0-big", timestamp: now, cwd: dir },
    { type: "message", id: "b1", parentId: null, timestamp: now, message: { role: "user", content: "P".repeat(1_000_000) } },
    { type: "message", id: "b2", parentId: "b1", timestamp: now, message: { role: "assistant", content: [{ type: "text", text: "A".repeat(1_000_000) }] } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const session = fakeSession(file);
  assert.deepEqual(oversizedEntries(session), []);
});

test("the provider's overflow wording is recognised, and a rate limit is not", () => {
  assert.ok(isContextOverflowError(`xai API error (400): 400 "Failed to start sampling: [input_too_large] The prompt is too long for this model's context window (871750 tokens > 500000 tokens)"`));
  assert.ok(isContextOverflowError("This model's maximum context length is 200000 tokens"));
  assert.ok(isContextOverflowError("context_length_exceeded"));
  assert.ok(!isContextOverflowError("429 rate limit exceeded, please retry"));
  assert.ok(!isContextOverflowError("Incorrect API key provided"));
  assert.ok(!isContextOverflowError(""));
});

test("a session with no manager, or a broken one, is survivable", () => {
  assert.deepEqual(oversizedEntries(null), []);
  assert.deepEqual(oversizedEntries({}), []);
  assert.equal(contextBytes(null), 0);
  assert.deepEqual(trimOversized({ sessionManager: { buildSessionProjection: () => { throw new Error("boom"); } } }, { log: () => {} }).trimmed, []);
  assert.equal(approxTokens(4000), 1000);
});
