// NO IF, NO RUN (owner, 2026-10-06): "actions should be allowed to be there but they should NOT
// RUN unless an IF is setup in the rules".
//
// The decision logic lives in src/autowork-rule.js and is PURE, so it is tested directly rather
// than mirrored. A change that lets a script run without a rule, or under a false IF, fails here.
import { strict as assert } from "node:assert";
import test from "node:test";
import { SURFACE_CLASSES, checkOp } from "../src/capabilities.js";
import { rulePlan, autoworkDecision } from "../src/autowork-rule.js";

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

const SCRIPT = "Get-Service foo | Restart-Service";

/** A rule shaped like the real ones: investigated, then fixed under a support-contact approval. */
function ruleWithScript(guard = "approved_by_support_contact") {
  return {
    prelude: "approval_gate", terminator: "stop",
    blocks: [{
      if: { condition: guard, args: {} },
      then: [
        { action: "investigate", args: {} },
        { action: "run_script", args: { name: "fix-it", shell: "powershell", script: SCRIPT, timeout: 120 } },
        { action: "reply_customer", args: {} },
        { action: "close_ticket", args: {} },
      ],
      else: [{ action: "hand_to_human", args: {} }],
    }],
  };
}

const approvedAs = (capacity) => ({ approval: { approved: true, capacity, by: "tester" } });

// ---------------------------------------------------------------------------
// 1. NO RULE => NO ACTION AT ALL. The M365 Offboarding subject carries a reviewed script but no
//    rule: it must not run, and it must not close the ticket either.
// ---------------------------------------------------------------------------
test("a device_fix subject with NO rule runs NO reviewed action and is capped at read-only", () => {
  const subj = { mode: "device_fix", fix_actions: [{ name: "m365-offboard-user", command: "Remove-MgUser" }] };
  const plan = rulePlan(subj, approvedAs("support_contact"));
  assert.equal(plan, null, "no blocks => no plan");
  const d = autoworkDecision(subj, plan);
  assert.deepEqual(d.fixActions, [], "attached fix_actions are inert without a rule");
  assert.equal(d.mode, "device_readonly");
  assert.equal(d.surface, "autowork_readonly");
  assert.equal(d.ruleAllowsClose, false, "nothing ran, so nothing is finished");
});

test("a rule with no investigate and no runnable script degrades to advise", () => {
  const subj = { mode: "device_fix", statements: {
    blocks: [{ if: { condition: "details_sufficient", args: {} },
               then: [{ action: "reply_customer", args: {} }],
               else: [{ action: "hand_to_human", args: {} }] }],
  } };
  const d = autoworkDecision(subj, rulePlan(subj, approvedAs("technician")));
  assert.equal(d.mode, "advise");
  assert.equal(d.surface, "advise");
});

// ---------------------------------------------------------------------------
// 2. A SCRIPT ONLY RUNS FROM INSIDE A TRUE IF.
// ---------------------------------------------------------------------------
test("a script under approved_by_support_contact RUNS only for a support contact", () => {
  const subj = { mode: "device_fix", statements: ruleWithScript() };
  const asContact = rulePlan(subj, approvedAs("support_contact"));
  assert.equal(asContact.scripts.length, 1, "support contact: the script is runnable");
  assert.equal(asContact.mode, "device_fix");
  assert.deepEqual(autoworkDecision(subj, asContact).fixActions.map((a) => a.name), ["fix-it"]);

  const asTech = rulePlan(subj, approvedAs("technician"));
  assert.equal(asTech.scripts.length, 0, "technician: the IF is FALSE, so the script is not runnable");
  assert.equal(asTech.mode, "device_readonly", "read-only probes still allowed, nothing changed");
  assert.deepEqual(autoworkDecision(subj, asTech).fixActions, []);
  assert.match(asTech.blockReason, /FALSE/);
});

test("no approval at all => the prelude is not satisfied and NO script is runnable", () => {
  const subj = { mode: "device_fix", statements: ruleWithScript("details_sufficient") };
  const plan = rulePlan(subj, { approval: { approved: false, capacity: "" } });
  assert.equal(plan.scripts.length, 0);
  assert.equal(plan.mode, "device_readonly");
  assert.match(plan.blockReason, /no approval is on file/);
});

test("a run_script that is NOT inside an IF is never runnable (defensive)", () => {
  const subj = { mode: "device_fix", statements: {
    blocks: [{ action: "run_script", args: { name: "loose", shell: "powershell", script: SCRIPT } }],
  } };
  const plan = rulePlan(subj, approvedAs("support_contact"));
  assert.equal(plan.scripts.length, 0);
  assert.equal(plan.dropped.length, 1);
  assert.match(plan.dropped[0].why, /not inside an IF/);
});

test("the fix cooldown withholds every script, however the rule is written", () => {
  const subj = { mode: "device_fix", statements: ruleWithScript("details_sufficient") };
  const plan = rulePlan(subj, { ...approvedAs("support_contact"), fix_allowed: false });
  assert.equal(plan.scripts.length, 0);
  assert.match(plan.blockReason, /cooldown/);
});

test("a script in the ELSE of approved_by_support_contact runs for a technician (negation)", () => {
  const subj = { mode: "device_fix", statements: {
    blocks: [{
      if: { condition: "approved_by_support_contact", args: {} },
      then: [{ action: "reply_customer", args: {} }],
      else: [{ action: "run_script", args: { name: "only-when-tech", shell: "powershell", script: SCRIPT } }],
    }],
  } };
  assert.equal(rulePlan(subj, approvedAs("technician")).scripts.length, 1);
  assert.equal(rulePlan(subj, approvedAs("support_contact")).scripts.length, 0);
});

test("a judgement guard the code cannot settle keeps the script runnable", () => {
  const subj = { mode: "device_fix", statements: ruleWithScript("details_sufficient") };
  const plan = rulePlan(subj, approvedAs("technician"));
  assert.equal(plan.scripts.length, 1, "details_sufficient is the session's call, not the code's");
  assert.equal(plan.mode, "device_fix");
});
