// What conversation does a window land in when nobody named one?
//
// Reported: "the history is not being included when talking to a refreshed page". F5, a
// socket the bridge closed as idle, and switching model or agent group all reopen a device
// chat with no session id - and each used to mint a brand-new session. The transcript came
// back empty AND the model came back with no context, so the next question was answered by
// an assistant that had forgotten the last hour, in a window that still looked like the
// same conversation.
//
// The rules that must not break: never pick up SOMEONE ELSE's window, never pick up a
// window of a different shape (multi-machine vs single), never point at a transcript that
// is gone, and never drag in a conversation old enough that nobody remembers it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PI_SESSIONS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-resume-"));
const history = await import("../src/history.js");

const AGENT = "agent-resume-1";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

/** Record a session the way startChat() does, with a real transcript file on disk. */
function record(agentId, sessionId, { user = "chris", multi = false, age = 0, exists = true } = {}) {
  const file = path.join(process.env.PI_SESSIONS_ROOT, `${sessionId}.jsonl`);
  if (exists) fs.writeFileSync(file, "{}\n");
  history.recordSession(agentId, sessionId, {
    file,
    name: `Chat about ${agentId}`,
    started: ago(age + HOUR),
    last_activity: ago(age),
    model: "xai/grok-4.6",
    user,
    multi,
  });
  return file;
}

test("a refresh lands back in the conversation this window was having", () => {
  record(AGENT, "sess-old", { age: 2 * HOUR });
  record(AGENT, "sess-new", { age: 5 * 60 * 1000 });
  const pick = history.latestResumable(AGENT, { username: "chris", multi: false, maxAgeMs: 12 * HOUR });
  assert.equal(pick?.session_id, "sess-new", "the most recent one, not merely any one");
});

test("never inherits another technician's window", () => {
  const agent = "agent-resume-2";
  record(agent, "sess-theirs", { user: "someone-else", age: 60 * 1000 });
  assert.equal(history.latestResumable(agent, { username: "chris", maxAgeMs: 12 * HOUR }), null);
  // ... and that person's own refresh still works.
  assert.equal(
    history.latestResumable(agent, { username: "someone-else", maxAgeMs: 12 * HOUR })?.session_id,
    "sess-theirs",
  );
});

test("a multi-machine chat and a single-machine chat are not the same window", () => {
  const agent = "agent-resume-3";
  record(agent, "sess-multi", { multi: true, age: 60 * 1000 });
  assert.equal(history.latestResumable(agent, { username: "chris", multi: false, maxAgeMs: 12 * HOUR }), null);
  assert.equal(
    history.latestResumable(agent, { username: "chris", multi: true, maxAgeMs: 12 * HOUR })?.session_id,
    "sess-multi",
  );
});

test("a deleted transcript is not resumable - it falls through to the one before it", () => {
  const agent = "agent-resume-4";
  record(agent, "sess-kept", { age: 3 * HOUR });
  record(agent, "sess-gone", { age: 60 * 1000, exists: false });
  assert.equal(
    history.latestResumable(agent, { username: "chris", maxAgeMs: 12 * HOUR })?.session_id,
    "sess-kept",
  );
});

test("yesterday's conversation is not resumed silently", () => {
  const agent = "agent-resume-5";
  record(agent, "sess-stale", { age: 3 * DAY });
  assert.equal(history.latestResumable(agent, { username: "chris", maxAgeMs: 12 * HOUR }), null);
  // 0 means "no age limit", which is what an operator sets when they want it back.
  assert.equal(
    history.latestResumable(agent, { username: "chris", maxAgeMs: 0 })?.session_id,
    "sess-stale",
  );
});

test("a machine never chatted about starts a new conversation", () => {
  assert.equal(history.latestResumable("agent-never-touched", { username: "chris", maxAgeMs: 12 * HOUR }), null);
});

test("sessions recorded before `user` was stored are still the caller's to resume", () => {
  const agent = "agent-resume-6";
  record(agent, "sess-anon", { user: "", age: 60 * 1000 });
  assert.equal(
    history.latestResumable(agent, { username: "chris", maxAgeMs: 12 * HOUR })?.session_id,
    "sess-anon",
  );
});
