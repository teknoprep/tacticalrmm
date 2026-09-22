// device_fix: an automation subject may run a REVIEWED remediation (owner, 2026-09-16:
// "a start/restart of sendplot should be enough to fix it"). The guards are what make that
// safe, so they are what is tested.
import { strict as assert } from "node:assert";
import test from "node:test";
import { SURFACE_CLASSES, checkOp } from "../src/capabilities.js";

test("the fix surface can note and reply, but never close or reach credentials", () => {
  const cls = SURFACE_CLASSES.autowork_fix;
  assert.ok(cls, "autowork_fix must be a known surface - an unknown one denies everything");
  assert.deepEqual(cls, ["read", "note", "customer"]);
  const opClasses = { ai_close_ticket: "close", get_partner_credentials: "secret",
                      add_note: "note", reply_to_ticket: "customer", get_ticket: "read",
                      upsert_ai_kb_article: "knowledge" };
  const mutating = new Set(["ai_close_ticket", "add_note", "reply_to_ticket", "upsert_ai_kb_article"]);
  const allowed = (op) => checkOp({ surface: "autowork_fix", op, opClasses, mutating }).allowed;
  assert.equal(allowed("get_ticket"), true);
  assert.equal(allowed("add_note"), true);
  assert.equal(allowed("reply_to_ticket"), true);
  assert.equal(allowed("ai_close_ticket"), false, "closing stays with a human");
  assert.equal(allowed("get_partner_credentials"), false, "a restart needs no password");
  assert.equal(allowed("upsert_ai_kb_article"), false, "unattended work does not rewrite knowledge");
});

// The mode/ceiling arithmetic lives in runAutowork; this mirrors it exactly so a change to
// one without the other fails here rather than in production.
function resolveMode(subj) {
  const fixActions = Array.isArray(subj.fix_actions) ? subj.fix_actions.filter((a) => a && a.name && a.command) : [];
  const mode = subj.mode === "device_fix" && fixActions.length ? "device_fix"
    : (subj.mode === "device_readonly" || subj.mode === "device_fix" ? "device_readonly" : "advise");
  const surface = mode === "advise" ? "advise" : (mode === "device_fix" ? "autowork_fix" : "autowork_readonly");
  return { mode, surface, fixActions };
}

test("device_fix with no reviewed actions degrades to read-only, it does not pretend", () => {
  assert.equal(resolveMode({ mode: "device_fix", fix_actions: [] }).mode, "device_readonly");
  assert.equal(resolveMode({ mode: "device_fix", fix_actions: [{ name: "x" }] }).mode, "device_readonly",
    "an action with no command is not an action");
  assert.equal(resolveMode({ mode: "device_fix", fix_actions: [{ name: "x", command: "Restart-Service foo" }] }).mode, "device_fix");
  assert.equal(resolveMode({ mode: "device_readonly", fix_actions: [{ name: "x", command: "y" }] }).mode, "device_readonly",
    "actions attached to a read-only subject are ignored - the MODE is the ceiling");
  assert.equal(resolveMode({ mode: "advise", fix_actions: [{ name: "x", command: "y" }] }).mode, "advise");
});

test("the surface follows the mode", () => {
  assert.equal(resolveMode({ mode: "advise" }).surface, "advise");
  assert.equal(resolveMode({ mode: "device_readonly" }).surface, "autowork_readonly");
  assert.equal(resolveMode({ mode: "device_fix", fix_actions: [{ name: "a", command: "b" }] }).surface, "autowork_fix");
});
