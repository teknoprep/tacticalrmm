// AUTOWORK RULE EVALUATION (pure). What an unattended run MAY do, decided from the subject's
// rule and the recorded approval. No I/O, no model, no database - so it can be unit-tested and
// read by the person approving the rule.
//
// Owner's rule (2026-10-06): "actions should be allowed to be there but they should NOT RUN
// unless an IF is setup in the rules". That is two code-enforced consequences:
//
//   1. A SUBJECT WITH NO RULE RUNS NO REVIEWED ACTION. `fix_actions` are reviewed LIBRARY data
//      attached to the subject; they are not authority. A device_fix subject with no rule is
//      downgraded to read-only, so "M365 Offboarding" (which carries a script but no rule) cannot
//      run its script no matter what the ticket says or who asked for it.
//   2. A `run_script` IS ONLY RUNNABLE WHEN THE RULE REACHES IT THROUGH A TRUE IF. The conditions
//      code can settle - `approved_by_support_contact` (who approved) and the fix cooldown - are
//      settled here, and a script sitting under a FALSE one is removed from the toolbelt entirely.
//      The remaining conditions (`cause_known`, `details_sufficient`, `procedure_cause`, ...) are
//      the session's judgement, by design ("the branches are the model's") - but a `run_script`
//      still has to sit inside an IF to be reachable at all.
//
// The rule always carries the prelude (`approval_gate`): no recorded approval AND a requester who
// is not a support contact means no person has authorised anything, and the run drops to read-only.

// ACTION CLASSES THAT MAY SKIP THE PER-TICKET APPROVAL (owner, 2026-10-15). Must stay in step
// with core/ai_rules.py ACTION_CLASSES. A script whose attached action is not declared as one of
// these is treated as `mutating` and still needs a person's approval - the subject switch only
// opens the gate for actions that cannot destroy data.
const BYPASSABLE_ACTION_SAFETY = new Set(["read", "restart", "update"]);

/** Human text for one condition. Kept in step with core/ai_rules.py's vocabulary. */
export function conditionText(c, a = {}) {
  if (c === "procedure_cause") return `if procedure #${a.procedure} is the confirmed cause`;
  if (c === "probe_confirms") return `if the probe confirms procedure #${a.procedure}`;
  if (c === "details_sufficient") return "if the ticket says enough to do this";
  if (c === "cause_known") return "if the cause is known";
  if (c === "fix_verified") return "if the fix verified";
  if (c === "customer_replied") return "if the customer replied";
  if (c === "requester_is_support_contact") return "if the requester is a support contact";
  if (c === "approved_by_support_contact") return "if the approval came from a support contact";
  if (c === "fixed_recently") return `if a fix ran in the last ${a.minutes} minutes`;
  if (c === "nothing_matched") return "if nothing else matched";
  return `if ${c}`;
}

/** Human text for one action. `run_script` reads as "run the script \"name\"". */
export function actionText(act, a = {}) {
  if (act === "investigate") return "investigate the device";
  if (act === "verify_fix") return "check that it is back up";
  if (act === "fix_procedure") return `fix it with procedure #${a.procedure}`;
  if (act === "run_script") return `run the script "${a.name || a.script_name || ""}"`;
  if (act === "reply_customer") return "update the customer";
  if (act === "note_ticket") return "note the ticket";
  if (act === "close_ticket") return "close the ticket";
  if (act === "hand_to_human") return "hand it to a human";
  if (act === "wait_customer") return "wait for the customer";
  if (act === "stop") return "stop processing";
  return act;
}

/**
 * Read a subject's rule into a plan for one ticket.
 *
 * @returns null when the subject has no rule at all (the caller then runs NO fix), else
 *   {present, english, allow, scripts, dropped, procedures, branchesOnCapacity, approved,
 *    capacity, supportContact, gateOk, mode, surface, blockReason}
 */
export function rulePlan(subj, blob) {
  const st = subj && subj.statements;
  const blocks = st && Array.isArray(st.blocks) ? st.blocks : [];
  if (!blocks.length) return null;

  // THE REVIEWED-ACTION LIBRARY. The rule NAMES a script; the command body lives here, attached
  // to the subject and reviewed in the Procedures page. Authority is still the rule - a script in
  // this map does nothing unless a `run_script` step in the rule names it inside a true IF. This
  // keeps the rule short ("run the script 'm365-offboard-user'" instead of a 60-line body), and
  // the library becomes the one place the command is edited.
  const library = new Map();
  for (const a of (subj && Array.isArray(subj.fix_actions) ? subj.fix_actions : [])) {
    if (a && a.name && a.command) library.set(String(a.name), a);
  }

  const allow = { investigate: false, fix: false, reply: false, note: false, close: false, handoff: false, wait: false, stop: false };
  const scripts = [];
  const dropped = [];
  const procedures = new Set();
  const english = [];
  let branchesOnCapacity = false;

  // THE APPROVAL, resolved in Django (core/ai_approval.py) and sent with the ticket. A technician
  // in the console or a support contact through the tokenised channel both count as "a person
  // approved"; `capacity` says which, and rules may narrow to the customer-side one.
  const ap = (blob && blob.approval) || {};
  const approved = !!ap.approved;
  const capacity = ap.capacity || "";
  // The subject's safe-action switch. It is NOT an approval: it only lets a run_script whose own
  // class is read / restart / update run with no per-ticket click. A mutating action still waits.
  const safeBypass = !!ap.safe_bypass;
  const supportContact = capacity === "support_contact";
  // WHETHER A FIX MAY RUN AT ALL ON THIS TICKET, independent of the rule: the cooldown withholds
  // reviewed actions so a service that keeps dying escalates to a human instead of being
  // restarted on a loop. `_subject_payload` sets this false while the cooldown is live.
  const fixAllowed = !(blob && blob.fix_allowed === false);

  // A guard the CODE can settle, or null when it is the session's judgement. `negated` marks a
  // step reached through the ELSE of that condition.
  const guardTruth = (g) => {
    if (g.condition === "approved_by_support_contact") return g.negated ? !supportContact : supportContact;
    if (g.condition === "fixed_recently") return g.negated ? !fixAllowed : (fixAllowed ? null : true);
    return null;
  };

  const walkSteps = (list, indent, guard) => {
    const pad = "  ".repeat(indent);
    for (const step of list || []) {
      if (!step || typeof step !== "object") continue;
      if (step.if) { walkBlock(step, indent, guard); continue; }
      const act = step.action || "";
      const a = step.args || {};
      if (act === "investigate" || act === "verify_fix") allow.investigate = true;
      if (act === "fix_procedure") { allow.fix = true; if (a.procedure) procedures.add(Number(a.procedure)); }
      let note = "";
      if (act === "run_script") {
        allow.fix = true;
        // A SCRIPT ONLY RUNS FROM INSIDE A TRUE IF. Which ways it is not runnable, all code-side.
        const refuted = guard.some((g) => guardTruth(g) === false);
        const ref = library.get(String(a.name || ""));
        const cls = String((ref && ref.safety) || a.safety || "mutating").toLowerCase();
        // THE SAFE-ACTION BYPASS. A person may pre-authorise a subject's non-destructive actions
        // (declared read / restart / update). Only then, and only for one of those classes, does a
        // script run with no per-ticket approval. A `mutating` class still needs the approval, and
        // an action inside an explicit `approved_by_support_contact` IF is still refuted below.
        const safeHere = safeBypass && BYPASSABLE_ACTION_SAFETY.has(cls);
        if (!approved && !safeHere) {
          dropped.push({ name: a.name || "", why: safeBypass
            ? `its safety "${cls}" is not pre-authorised (only read / restart / update are)`
            : "no approval is on file for this ticket" });
          note = safeBypass
            ? ` [NOT AVAILABLE: "${cls}" needs a person's approval]`
            : " [NOT AVAILABLE: no approval is on file]";
        } else if (!fixAllowed) {
          dropped.push({ name: a.name || "", why: "the reviewed fix is withheld (cooldown) on this ticket" });
          note = " [NOT AVAILABLE: fix withheld by the cooldown]";
        } else if (!guard.length) {
          dropped.push({ name: a.name || "", why: "it is not inside an IF, so nothing authorises it to run" });
          note = " [NOT AVAILABLE: not inside an IF]";
        } else if (refuted) {
          dropped.push({ name: a.name || "", why: "the IF above it is FALSE for this ticket" });
          note = " [NOT AVAILABLE: the IF above it is false for this ticket]";
        } else {
          // RESOLVE THE NAME TO A REVIEWED ACTION. An embedded `script` body still works (older
          // rules), but the normal shape is just `name`; the body, shell, timeout and parameter
          // declarations come from the attached action.
          const command = a.script || (ref && ref.command) || "";
          if (!command) {
            dropped.push({ name: a.name || "", why: ref
              ? "it carries no script body"
              : `no reviewed action named "${a.name || ""}" is attached to this subject` });
            note = ` [NOT AVAILABLE: ${ref ? "no script body" : "no such reviewed action"}]`;
          } else {
            const params = Array.isArray(a.params) && a.params.length ? a.params
              : (ref && Array.isArray(ref.params) ? ref.params : []);
            const entry = { name: a.name, shell: a.shell || (ref && ref.shell) || "powershell", command,
                           timeout: Number(a.timeout || (ref && ref.timeout) || 300),
                           wait: Number(a.wait || (ref && ref.wait) || 0), params, safety: cls };
            // Ran on the subject's pre-authorisation, with nobody having clicked approve.
            if (!approved && safeHere) entry.bypassed = true;
            scripts.push(entry);
            if (entry.bypassed) note = ` [SAFE BYPASS: safety "${cls}", no approval required]`;
          }
        }
      }
      if (act === "reply_customer") allow.reply = true;
      if (act === "note_ticket") allow.note = true;
      if (act === "close_ticket") allow.close = true;
      if (act === "hand_to_human") allow.handoff = true;
      if (act === "wait_customer") allow.wait = true;
      if (act === "stop") allow.stop = true;
      english.push(`${pad}${actionText(act, a)}${note}`);
    }
  };

  const walkBlock = (block, indent, guard) => {
    const pad = "  ".repeat(indent);
    const cond = block.if || {};
    const c = cond.condition || "";
    const a = cond.args || {};
    if (c === "approved_by_support_contact") branchesOnCapacity = true;
    english.push(`${pad}${conditionText(c, a)}`);
    // THEN: this condition holds.
    walkSteps(block.then, indent + 1, [...guard, { condition: c, args: a, negated: false }]);
    // ELSE IF / ELSE: reached only with this condition (and every prior sibling) false.
    let negated = [...guard, { condition: c, args: a, negated: true }];
    for (const e of block.elif || []) {
      walkBlock(e, indent, negated);
      const ec = (e && e.if) || {};
      negated = [...negated, { condition: ec.condition || "", args: ec.args || {}, negated: true }];
    }
    if (block.else) {
      english.push(`${pad}else`);
      walkSteps(block.else, indent + 1, negated);
    }
  };

  walkSteps(blocks, 1, []);

  // AUTHORITY IS THE RUNNABLE SCRIPTS, NOT THE DECLARED ONES. A rule that mentions a fix in a
  // branch this ticket cannot take is a rule that can do nothing on this ticket. A runnable
  // script got here either through a recorded approval or through the subject's safe-action
  // bypass for its declared class - so a non-empty list IS the authority, and `mayFix` is simply
  // "something is runnable".
  allow.fix = scripts.length > 0;
  const mayFix = scripts.length > 0;
  const mayInvestigate = allow.investigate;
  const mode = mayFix ? "device_fix" : (mayInvestigate ? "device_readonly" : "advise");
  const bypassed = scripts.filter((s) => s.bypassed);

  const reasons = [];
  if (!approved && !bypassed.length) reasons.push("no approval is on file for this ticket, so the rule's first line is not satisfied");
  if (bypassed.length) {
    reasons.push(`safe bypass: ${bypassed.length} action(s) run on the subject's pre-authorisation `
      + `(safety ${[...new Set(bypassed.map((s) => s.safety))].join("/")}), no per-ticket approval`);
  }
  for (const d of dropped) {
    const why = `script "${d.name}" will not run: ${d.why}`;
    if (!reasons.includes(why)) reasons.push(why);
  }

  return {
    present: true, english, allow, scripts, dropped, procedures: [...procedures],
    branchesOnCapacity, approved, capacity, supportContact,
    gateOk: approved || bypassed.length > 0,
    safeBypass, bypassed: bypassed.map((s) => ({ name: s.name, safety: s.safety })),
    fixAllowed, mode, surface: mode === "advise" ? "advise" : (mode === "device_fix" ? "autowork_fix" : "autowork_readonly"),
    blockReason: reasons.join("; "),
  };
}

/**
 * The mode / toolbelt decision for a run, from the plan (or the lack of one).
 *
 * WITHOUT A RULE there is NO fix authority at all: the attached `fix_actions` are inert, and a
 * device_fix subject is capped at read-only. Closing is off for such a subject too - nothing ran,
 * so nothing is finished.
 */
export function autoworkDecision(subj, plan) {
  const fixActions = plan ? plan.scripts : [];
  const mode = plan ? plan.mode
    : (subj && (subj.mode === "device_readonly" || subj.mode === "device_fix") ? "device_readonly" : "advise");
  const surface = mode === "advise" ? "advise" : (mode === "device_fix" ? "autowork_fix" : "autowork_readonly");
  const ruleAllowsReply = !plan || plan.allow.reply;
  const ruleAllowsClose = plan ? plan.allow.close : !(subj && subj.mode === "device_fix");
  return { fixActions, mode, surface, ruleAllowsReply, ruleAllowsClose };
}
