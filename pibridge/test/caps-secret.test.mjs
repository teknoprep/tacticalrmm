// The credential store is never warn-only.
//
// `PI_CAPS_MODE=warn` (the default) exists so tightening a capability cannot silently
// break a running automation: the refusal is logged and the call still goes through. That
// is right for a class whose worst case is an unwanted ticket note. It is wrong for the
// customer's stored logins - and because a credential READ is not a mutating operation,
// there is no approval gate standing behind the class check to catch it. So `secret` and
// `secret_write` are enforced from the moment they are checked, whatever the mode says.
import { test } from "node:test";
import assert from "node:assert/strict";

import { gateOp, checkOp, SURFACE_CLASSES, CAPS_MODE } from "../src/capabilities.js";

const opClasses = {
  get_partner_credentials: "secret",
  upsert_partner_notebook_row: "secret_write",
  add_note: "note",
  close_ticket: "close",
};
const mutating = new Set(["upsert_partner_notebook_row", "add_note", "close_ticket"]);

test("this test is meaningful: the default mode really is warn", () => {
  // If this ever fails because the deployment moved to enforce, the assertions below stop
  // proving anything special about `secret` - they would pass for every class.
  assert.equal(CAPS_MODE, "warn", "set PI_CAPS_MODE=enforce and this suite needs rethinking");
});

test("a secret read is REFUSED on a surface that lacks the class, even in warn mode", () => {
  const v = gateOp({ surface: "triage", op: "get_partner_credentials", opClasses, mutating });
  assert.equal(v.allowed, false);
  assert.equal(v.enforced, true, "warn mode must not hand over the customer's passwords");
});

test("a secret_write is REFUSED on a surface that lacks the class, even in warn mode", () => {
  const v = gateOp({ surface: "device_chat", op: "upsert_partner_notebook_row", opClasses, mutating });
  assert.equal(v.allowed, false);
  assert.equal(v.enforced, true);
});

test("ordinary classes keep the warn-mode grace period", () => {
  const v = gateOp({ surface: "triage", op: "close_ticket", opClasses, mutating });
  assert.equal(v.allowed, false);
  assert.equal(v.enforced, false, "a wrongly-tightened ticket op must not break a live automation");
});

test("the device chat may now read credentials, and still may not record them", () => {
  assert.ok(SURFACE_CLASSES.device_chat.includes("secret"),
    "granted 2026-08-25 once the surface got a real credential gate");
  assert.ok(!SURFACE_CLASSES.device_chat.includes("secret_write"),
    "recording a credential belongs with the ticket that justifies it");

  assert.equal(checkOp({ surface: "device_chat", op: "get_partner_credentials", opClasses, mutating }).allowed, true);
  assert.equal(checkOp({ surface: "device_chat", op: "upsert_partner_notebook_row", opClasses, mutating }).allowed, false);
});

test("surfaces with no human present still cannot reach the credential store", () => {
  for (const surface of ["triage", "unattended", "auto_resolve", "mining", "report"]) {
    if (!SURFACE_CLASSES[surface]) continue;
    assert.ok(!SURFACE_CLASSES[surface].includes("secret"),
      `${surface} has no technician to approve or instruct a credential read`);
  }
});
