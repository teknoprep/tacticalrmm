// WHO SENT IT (queue history attribution).
//
// The owner's ask: "in the ai chat windows i want a way to look at the history and see who
// was the person that sent each chat... that way as an admin i can see what's going on".
//
// A live session is shared - one driver, watchers, hand-overs, a phone on the same
// conversation - so identity has to come off the SOCKET a frame arrived on, not off the
// token the session was opened with. These tests cover that join: live-hub's actorOn(),
// which the two chat surfaces in server.js feed into queue.handle()/notePrompt().
//
// Run: node --test test/queue-who.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeHub, actorOn } from "../src/live-hub.js";
import { makePromptQueue } from "../src/queue.js";

const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await tick(); };

// The bits of a WebSocket the hub touches.
const sock = () => ({ readyState: 1, send() {}, close() {}, on() {} });

function hubFor() {
  return makeHub({ key: "AGENT1::sess-1", graceMs: 0, log: () => {}, onDispose: () => {} });
}

test("the person on the socket is who the frame is attributed to", () => {
  const hub = hubFor();
  const dan = sock();
  const chris = sock();
  hub.attach(dan, { username: "DAN", user_display: "Dan Ops", is_superuser: true });
  hub.attach(chris, { username: "chris", user_display: "Chris Tech" });

  assert.deepEqual(actorOn(hub, dan, {}), { user: "dan", display: "Dan Ops" });
  assert.deepEqual(actorOn(hub, chris, {}), { user: "chris", display: "Chris Tech" });
});

test("no socket falls back to the person the session was opened for, never to blank", () => {
  const hub = hubFor();
  // A queued prompt firing on its own, or a bridge-side retry: there is no socket to ask,
  // but we do know whose conversation it is.
  assert.deepEqual(actorOn(hub, null, { username: "Dan", user_display: "Dan Ops" }), {
    user: "dan",
    display: "Dan Ops",
  });
  // A socket that is not on this hub (already detached) must not be trusted as identity.
  assert.deepEqual(actorOn(hub, sock(), { username: "dan", user_display: "Dan Ops" }), {
    user: "dan",
    display: "Dan Ops",
  });
});

test("a display name is not invented: the login stands in when there is none", () => {
  const hub = hubFor();
  const ws = sock();
  hub.attach(ws, { username: "svc_automation" });
  assert.deepEqual(actorOn(hub, ws, {}), { user: "svc_automation", display: "svc_automation" });
});

test("end to end: a hand-over puts the new driver's name on the rows they send", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-who-"));
  const hub = hubFor();
  const dan = sock();
  const chris = sock();
  hub.attach(dan, { username: "dan", user_display: "Dan Ops" });
  hub.attach(chris, { username: "chris", user_display: "Chris Tech", is_superuser: true });

  const frames = [];
  const queue = makePromptQueue({
    scopeKey: "AGENT1", root, send: (f) => frames.push(f), log: () => {},
    isStreaming: () => false, runPrompt: async () => {}, compact: async () => {},
  });
  queue.attach("sess-1");

  // Dan is driving and queues the work.
  await queue.handle({ type: "queue_add", text: "restart the spooler" }, actorOn(hub, dan, {}));
  // Chris (an admin) takes the seat and runs it.
  hub.takeover(chris);
  await queue.handle({ type: "queue_run_next" }, actorOn(hub, chris, {}));
  await settle();
  // ...and types a follow-up of his own.
  queue.notePrompt("and check the event log", "browser", { actor: actorOn(hub, chris, {}) });

  await queue.handle({ type: "queue_history" });
  const hist = frames.filter((f) => f.type === "queue_history").at(-1).history;
  const row = (ev) => hist.find((e) => e.event === ev);
  assert.equal(row("added").by, "Dan Ops");
  // The item is Dan's work even though Chris pressed the button that ran it.
  assert.equal(row("started").by, "Dan Ops");
  // What Chris typed is Chris's.
  assert.equal(row("prompt").by, "Chris Tech");
  assert.equal(row("prompt").user, "chris");
});
