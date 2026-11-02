// Permissions follow the driver (owner, 2026-10-13).
//
// 1. An admin who takes over a technician's chat used to keep the TECHNICIAN's hamburger
//    (no Write mode etc.): session permissions were fixed by whoever opened it.
// 2. An admin granting a technician a capability from the Access dialog reached the bridge but
//    matched "0 live window(s)": hub keys are `<scope>::<sessionId>` and the matcher compared the
//    bare ticket/agent ref against the whole key.
import test from "node:test";
import assert from "node:assert/strict";
import { makeHub, liveKey, liveScope } from "../src/live-hub.js";

const tech = { username: "sean", user_display: "Sean", mutate_allowed: false, autoapprove_allowed: false, caps_granted: [] };
const admin = { username: "chris", user_display: "Chris", is_superuser: true, mutate_allowed: true, autoapprove_allowed: true, autocredential_allowed: true, caps_granted: [] };
const sock = (n) => ({ id: n, readyState: 1, sent: [], send(p) { this.sent.push(JSON.parse(p)); }, close() {} });

function hubWithSpy(key) {
  const hub = makeHub({ key, graceMs: 0, log: () => {} });
  const calls = [];
  hub.applyDriverPerms = (owner, p) => calls.push({ who: owner.username, perms: { ...p.perms }, state: { ...p.state } });
  return { hub, calls };
}

test("liveScope strips the session id (the /pi/grants matcher compares scopes)", () => {
  assert.equal(liveScope(liveKey("decision:TICKET/62641", "01a1-xyz")), "decision:TICKET/62641");
  assert.equal(liveScope(liveKey("kadRSaX", "01a1-xyz")), "kadRSaX");
  assert.equal(liveScope("plain"), "plain");
});

test("an admin who takes over gets THEIR OWN permissions; handing back restores the tech's", () => {
  const { hub, calls } = hubWithSpy("decision:TICKET/1::s1");
  hub.permsDriver = "sean";                     // what server.js sets for the opener
  const a = sock("sean"), b = sock("chris");
  hub.attach(a, tech);
  hub.attach(b, admin);
  assert.equal(calls.length, 0, "no seat change yet - nothing re-applied");

  const r = hub.takeover(b);
  assert.equal(r.result, "granted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].who, "chris");
  assert.equal(calls[0].perms.mutate_allowed, true, "admin's Write mode permission");
  assert.equal(calls[0].perms.autoapprove_allowed, true);

  hub.grantDrive(b, "sean");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].who, "sean");
  assert.equal(calls[1].perms.mutate_allowed, false, "back on the tech's role");
  hub.dispose("test");
});

test("a grant for a tech who is not driving is held and applied (with its switch) when they drive", () => {
  const { hub, calls } = hubWithSpy("decision:TICKET/2::s2");
  hub.permsDriver = "chris";
  const a = sock("chris"), b = sock("sean");
  hub.attach(a, admin);
  hub.attach(b, tech);
  // What /pi/grants does for a member who is not driving:
  hub.notePerms("sean", { mutate_allowed: true }, ["write"], { write: true });
  assert.equal(calls.length, 0, "not applied while chris drives");

  hub.grantDrive(a, "sean");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].who, "sean");
  assert.equal(calls[0].perms.mutate_allowed, true, "the grant came with him");
  assert.deepEqual(calls[0].state, { write: true }, "and the held 'switch it on'");
  assert.deepEqual(hub.permsFor("sean").state, {}, "spent once applied");
  hub.dispose("test");
});
