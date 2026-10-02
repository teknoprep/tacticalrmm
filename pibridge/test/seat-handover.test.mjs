// Seat hand-over (owner, 2026-09-27): give control of a live session back to a named person.
//
// Why: rules 3 and 5 of live-presence left a demoted user with no route back - taking the seat
// needs can_take_over_ai_session, and if the driver is an admin their consent is required (no
// answer = denied). An admin taking over was therefore one-way. These tests pin the new route:
// the driver hands the seat to someone who has been in the session, online or not.
import test from "node:test";
import assert from "node:assert/strict";
import {
  newPresence, join, leave, isOwner, grantSeat, revokeSeatGrant, seatRoster, presenceFrame,
  mayAnswerApproval,
} from "../src/live-presence.js";

const admin = { username: "chris", user_display: "Chris", is_superuser: true };
const sean = { username: "sean", user_display: "Sean", can_take_over_ai_session: false };
const dana = { username: "dana", user_display: "Dana", can_take_over_ai_session: true };
const ws = (n) => ({ id: n });

test("the driver hands the seat to a connected viewer, who keeps it", () => {
  const p = newPresence();
  const a = ws("chris"), b = ws("sean");
  join(p, a, admin);                       // first joiner owns it
  assert.equal(join(p, b, sean).role, "viewer");
  const r = grantSeat(p, a, "sean");
  assert.equal(r.ok, true);
  assert.equal(r.promoted, true);
  assert.equal(isOwner(p, b), true, "sean is driving now");
  assert.equal(isOwner(p, a), false, "chris dropped to read-only, still attached");
  const f = presenceFrame(p, b);
  assert.equal(f.you.role, "owner");
  assert.equal(f.owner.username, "sean");
});

test("a handed-over seat survives sean's own reconnects (he does not need can_take_over)", () => {
  const p = newPresence();
  const a = ws("chris"), b = ws("sean");
  join(p, a, admin);
  join(p, b, sean);
  grantSeat(p, a, "sean");
  // sean closes the tab and comes back: the reclaim grace gives HIM the seat, not chris
  leave(p, b, () => {});
  const again = ws("sean2");
  const j = join(p, again, sean);
  assert.equal(j.role, "owner");
  assert.equal(j.reclaimed, true);
});

test("granting someone who is NOT attached: the seat is theirs the moment they attach, once", () => {
  const p = newPresence();
  const a = ws("chris"), b = ws("sean");
  join(p, a, admin);
  join(p, b, sean);
  leave(p, b, () => {});                    // sean leaves; seat is chris's
  assert.equal(isOwner(p, a), true);
  const r = grantSeat(p, a, "sean");
  assert.equal(r.ok, true);
  assert.equal(r.promoted, false, "nobody to promote yet");

  const back = ws("sean-again");
  const j = join(p, back, sean);
  assert.equal(j.role, "owner", "the grant is honoured on attach");
  assert.equal(j.handedOver, true);
  assert.equal(isOwner(p, a), false, "chris is demoted as soon as sean returns");
  assert.deepEqual(seatRoster(p).grants, [], "the grant is spent - it cannot ping-pong");

  // and it does not come back a third time
  leave(p, back, () => {});
  const later = ws("sean-later");
  assert.equal(join(p, later, sean).role, "owner", "vacant: first joiner owns it anyway");
});

test("only the current driver may grant, and only to someone who has been in the session", () => {
  const p = newPresence();
  const a = ws("chris"), b = ws("sean");
  join(p, a, admin);
  join(p, b, sean);
  assert.equal(grantSeat(p, b, "sean").ok, false, "a viewer cannot grant");
  const r = grantSeat(p, a, "stranger");
  assert.equal(r.ok, false);
  assert.match(r.reason, /never had access/);
  assert.equal(grantSeat(p, a, "chris").ok, false, "cannot hand it to yourself");
});

test("a grant can be taken back before it is used", () => {
  const p = newPresence();
  const a = ws("chris"), b = ws("sean");
  join(p, a, admin);
  join(p, b, sean);
  leave(p, b, () => {});
  assert.equal(grantSeat(p, a, "sean").ok, true);
  assert.equal(seatRoster(p).grants.length, 1);
  assert.equal(revokeSeatGrant(p, a, "sean").ok, true);
  assert.equal(seatRoster(p).grants.length, 0);
  assert.equal(join(p, ws("sean3"), sean).role, "viewer", "no seat for him now");
});

test("the roster shows who drives, who watches, and everyone who has had access", () => {
  const p = newPresence();
  const a = ws("chris"), b = ws("sean"), c = ws("dana");
  join(p, a, admin);
  join(p, b, sean);
  join(p, c, dana);
  grantSeat(p, a, "dana");                  // dana drives
  leave(p, b, () => {});                    // sean leaves but keeps his history
  const r = seatRoster(p);
  const by = Object.fromEntries(r.people.map((x) => [x.username, x]));
  assert.equal(by.chris.connected, true);
  assert.equal(by.chris.driving, false);
  assert.equal(by.dana.driving, true);
  assert.equal(by.sean.connected, false, "gone, but still on the record");
  assert.equal(by.dana.drives >= 1, true, "how often each person drove is visible");
  assert.equal(r.owner.username, "dana");
});

test("the roster travels to every attached socket, including viewers", () => {
  const p = newPresence();
  const a = ws("chris"), b = ws("sean");
  join(p, a, admin);
  join(p, b, sean);
  const f = presenceFrame(p, b);
  assert.equal(f.roster.owner.username, "chris");
  assert.equal(f.roster.people.length, 2);
  assert.equal(f.you.role, "viewer");
});

// ---------------------------------------------------------------------------------------------
// WHO MAY ANSWER AN APPROVAL PROMPT (owner, 2026-09-27). TICKET/61884: a viewer could click
// "Approve" on a device change. The room was read-only for typing but not for AUTHORISING, which
// is the more dangerous half - an approval can run a destructive command, email a customer or
// hand over a stored credential. Only the technician holding the seat answers now.

test("a viewer cannot answer an approval prompt, and is told why", () => {
  const p = newPresence();
  const owner = ws("chris"), viewer = ws("zohaib");
  join(p, owner, admin);
  join(p, viewer, { username: "zohaib", user_display: "Zohaib" });
  assert.equal(mayAnswerApproval(p, owner).ok, true, "the driver answers");
  const r = mayAnswerApproval(p, viewer);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Only Chris/, "names the person who can");
  assert.match(r.reason, /Take over/, "and how to get the power");
});

test("an ADMIN viewer is not special: they take the seat first (no silent second approver)", () => {
  const p = newPresence();
  const owner = ws("sean"), adminViewer = ws("chris");
  join(p, owner, { username: "sean", user_display: "Sean" });
  join(p, adminViewer, admin);                     // an admin, but not driving
  assert.equal(mayAnswerApproval(p, adminViewer).ok, false);
  // ...and once they take the seat, they answer normally
  grantSeat(p, owner, "chris");
  assert.equal(mayAnswerApproval(p, adminViewer).ok, true);
});

test("with nobody driving there is nothing to approve, and the message says so", () => {
  const p = newPresence();
  const r = mayAnswerApproval(p, ws("x"));
  assert.equal(r.ok, false);
  assert.match(r.reason, /Nobody is driving/);
});

test("handing the seat over transfers the right to approve with it", () => {
  const p = newPresence();
  const a = ws("chris"), b = ws("zohaib");
  join(p, a, admin);
  join(p, b, { username: "zohaib", user_display: "Zohaib" });
  grantSeat(p, a, "zohaib");
  assert.equal(mayAnswerApproval(p, b).ok, true);
  assert.equal(mayAnswerApproval(p, a).ok, false, "the demoted driver loses it");
});
