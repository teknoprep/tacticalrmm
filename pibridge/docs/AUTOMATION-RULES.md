# Automation Rules — English IF / THEN / ELSE for ticket automation

Owner's shape (2026-09-28):

> "a simple in english if then else endif type statements like so.. if approved by a support
> contact then <— this should be default for ALL and should still be there visible but not
> editable... then —> if sendplot is down, go investigate why ... if you know why, go fix, if
> fixed send ticket update and close, elseif stop processing, endif stop processing (should be
> default as anything before this that closes the ticket should STOP processing as well)"

Status: **language + editor + AI writer built and deployed. The bridge interpreter is next** (see
"What is not wired yet").

---

## Why structured blocks and not free text

The whole system rests on one rule: **the model may never compose a command, and a judge can only
say NO.** Permission therefore has to be *data* a person can read and approve. Free text is prose,
and nothing can enforce prose — that is exactly how the previous design degenerated into a canned
`fix_actions` list that duplicated, per subject, what the procedures already knew.

So the author writes sentences, and the app stores **blocks**: a fixed vocabulary of conditions and
actions. The editor renders the vocabulary into English; the interpreter consumes the same ids.

Two clauses are not the author's to write:

| Clause | | Why |
|---|---|---|
| `if approved by a support contact or a technician` | **first, always, not editable** | Automation may not act on a ticket until a PERSON has approved it: a support contact for the customer (customer-side authorisation, via a signed single-use token) **or one of our own technicians** (authenticated, in the AI Decision window). An emailed "yes" is never an approval. Owner, 2026-09-28: *"it doesn't just have to be support contact approval… it can be tech approval"*. Rules that change a customer **account** (password / MFA reset, group membership) narrow the gate themselves with the `approved_by_support_contact` condition. |
| `stop processing` | **last, always, not editable** | Nothing after a close can ever run. `close_ticket` implies it, structurally. |

### Approval is of a PLAN, not a permission

*"when the tech get's take to the area where it works on things… it will be told what its about to do
first… that way the tech can review before you say go"*

So an approval is bound to what the technician actually read (`core/ai_approval.py`,
`AIAutomationApproval`):

* `rule_digest` — the version of the rule the plan was written under. **Edit the rule and every
  outstanding approval stops matching.** Approving rule A must never authorise rule B.
* `plan_digest` — the exact steps shown. Regenerate the plan and it goes back for review instead of
  running something nobody approved.
* who approved (`approved_by`), in what capacity (`technician` / `support_contact`), and an expiry.

The plan is a **rendering of the rule** for one ticket (`plan_from_rule`), not a model-written
summary: an approver must be reading the same steps the interpreter will run, so the two cannot
drift. The AI Decision window asks for the plan (`POST /core/ai/approval/ {action:propose}`), shows
it, and the technician answers with `{action:approve}` — which refuses with 409 if either digest
changed since it was displayed.

Neither is a prompt rule. `ai_rules.with_defaults()` writes both into every saved rule, so a rule
read straight out of the database still has its gate, and the bridge treats them as structural.

## Shape

```json
{"prelude": "approval_gate",
 "terminator": "stop",
 "blocks": [
   {"if":   {"condition": "procedure_cause", "args": {"procedure": 143}},
    "then": [{"action": "investigate", "args": {}},
             {"action": "run_script", "args": {"name": "restart-sendplot", "shell": "powershell",
                                               "script": "...", "wait": 180}},
             {"if":   {"condition": "fix_verified", "args": {}},
              "then": [{"action": "reply_customer", "args": {}}, {"action": "close_ticket", "args": {}}],
              "else": [{"action": "hand_to_human", "args": {}}]}],
    "elif":  [ ... sibling branches of the same IF ... ],
    "else":  [{"action": "hand_to_human", "args": {}}]}
 ]}
```

A **branch body is a list of steps**, and a step is either an action or a whole nested IF. That
recursion is not decoration: "fix it, then check it is back up: if up close, else hand over" is an
IF that comes *after* actions. An `elif` is a sibling of the same IF and cannot express it.

Limits: nests at most 4 deep, at most 40 actions per rule. A rule that never closes, hands over or
waits gets a warning (it will just stop).

## Vocabulary

`core/ai_rules.py` is the single source of truth. The editor renders from it, the serializer
validates against it, so **the UI can never offer a verb the interpreter does not know**. Unknown
condition or action ⇒ the rule is rejected at save time, not papered over at run time.

**Conditions** (`needs_ai` = decided by a model call at run time)

| id | reads as | needs_ai |
|---|---|---|
| `procedure_cause` `{procedure}` | procedure #N is the confirmed cause | no |
| `probe_confirms` `{procedure}` | the read-only probe confirms procedure #N | no |
| `cause_known` | the cause is known (nothing deterministic matched) | **yes** |
| `fix_verified` | the fix verified | no |
| `customer_replied` | the customer replied | no |
| `requester_is_support_contact` | the requester is already a support contact | no |
| `fixed_recently` `{minutes}` | a fix already ran inside the cooldown | no |
| `nothing_matched` | catch-all for a final ELSE | no |

**Actions**

| id | reads as | class | needs_ai |
|---|---|---|---|
| `investigate` | investigate the device | read | **yes** |
| `verify_fix` `{procedure}` | check that it is back up | read | no |
| `fix_procedure` `{procedure}` | fix it with procedure #N | fix | no |
| `run_script` `{name,shell,script,wait}` | run the script "N" | fix | no |
| `reply_customer` | update the customer | reply | **yes** |
| `note_ticket` | note the ticket | note | **yes** |
| `close_ticket` | close the ticket | close | no |
| `hand_to_human` | hand it to a human | human | no |
| `wait_customer` | wait for the customer | wait | no |
| `stop` | stop processing | stop | no |

## The AI writes the rule

The editor has **"Have an AI help write this"**: plain English in, a rule tree back.

The assistant must decide, **for each step**, whether the work is:

* **mechanical** — the same commands every time ⇒ it writes the finished `powershell` / `cmd` /
  `bash` script body, which a person then reviews in the editor (a script body is reviewed data,
  exactly like a procedure's remedy); or
* **judgement** — ⇒ an IF/THEN block that calls the AI at run time.

It returns `notes` saying which it chose and why. Nothing it returns is trusted: the tree is
validated against the vocabulary, errors come back to the editor to be fixed, and **the draft is
never saved** — it only fills the form.

Worked example (real output, description = the owner's SendPlot rule, subject #2):

```
IF approved by a support contact
  IF the cause is known
    investigate the device  [AI decides]
    fix it with procedure #143
    check that it is back up
    IF the fix verified
      update the customer  [AI decides]
      close the ticket
    ELSE
      hand it to a human
  ELSE
    hand it to a human
STOP PROCESSING
```

Its note:

> The restart is a reviewed, interactive remedy, so I used `fix_procedure #143` rather than
> `run_script`: the stop/start sequence is the procedure's approved runbook (it needs an
> interactively logged-on Administrator on ENG1-DEV), not a fixed idempotent script I could
> reproduce as a body. … I call `verify_fix #143` and branch on `fix_verified`: verified →
> `reply_customer` + `close_ticket`; not verified → `hand_to_human`, so an unverified fix is never
> closed as done.

## The SendPlot pilot

Pilot subject: **#2 "SendPlot down / won't open (Omega Design)"** — already approved and live, with
the reviewed `restart-sendplot` and `verify-sendplot` scripts pinned to **ENG1-DEV**, working from
approved procedure **#143** (occurrence 15).

The rule attached to it **keeps those scripts verbatim** (the owner: "obviously the current script
runs to restart sendplot should stay") and adds the verification branch. `mode`, `fix_actions` and
`fix_target` are untouched, so the fallback path is unchanged while the rule lands.

## What is wired now

1. **The interpreter (2026-09-28).** `rulePlan()` in the bridge reads `subject.statements` and
   decides **in code**:
   * **authority** — which verbs exist at all. No `run_script`/`fix_procedure` in the rule ⇒ no fix
     tool is built, so no ticket text and no model decision can change a device. `apply_fix` carries
     the RULE's scripts, not the subject's `fix_actions` list, so a rule saying "restart the print
     spooler" cannot also run nine unrelated actions attached months ago.
   * **the gate** — Django resolves the approval (`active_approval`, digests included) and sends it
     with the ticket. No approval ⇒ the run drops to read-only and the prompt says so. A rule using
     `approved_by_support_contact` is **not** satisfied by a technician's approval.
   * **reply / close** — granted only if the rule reaches `reply_customer` / `close_ticket`; a rule
     with no close step means the ticket is never AI-closed, however confident the session was.
   * **the branches are the model's** — `cause_known`, `nothing_matched` etc. are judgements, handed
     to the session as the decision procedure in English. The model decides *when*; never *what it
     may do*.

   Verified on TICKET/60475 with subject #9's rule: `gate_ok: false`, "no approval is on file for
   this ticket", stayed `device_readonly`, `fix_applied: []`, nothing sent, 9 findings reported.

2. **`_subject_payload` sends `statements`.** It did not, so the bridge never knew a rule existed and
   fell back to `mode` + `fix_actions` — a subject converted to a rule kept executing its old canned
   actions.

3. **Shadow runs no longer re-route the ticket.** The needs-input tag was skipped only for
   `shadow_reply`, so a shadow run whose action was `note` still tagged the ticket.

4. **Procedure de-duplication.** `consolidate_ai_procedures --skip-singletons` merged 57 groups,
   absorbing 67 more rows (127 of 539 absorbed in total). Nothing deleted: absorbed rows are
   `status=retired` with `merged_into`, text/tickets/counts kept. New **`repoint_procedure_refs`**
   moves references off absorbed rows onto their canonical target — subject M2M links *and* rule
   `procedure` arguments, following `merged_into` chains; dry-run by default. It reported 0 changes
   and a verification pass confirms no dangling references. Backed up first to
   `~/backups/procedures-<utc>/`.

## What is still not wired

1. **The approval UI in the AI Decision window.** The endpoint, the plan rendering and the record
   exist and are tested; the window still needs the plan panel, the Approve / Decline buttons, and
   the live script output next to them.
2. **`fix_procedure`'s payload.** Procedures carry prose (`fix`, `verification`) and a read-only
   `probe`; they have no reviewed `remedy` yet, so the fix verb has nothing machine-checkable to
   run. Adding `remedy` (same shape as `probe`, plus a target rule) is what makes
   "the procedure says it is ok" executable instead of advisory.
3. **`verify_fix`** must map to the procedure's verification (or a script's exit condition) and
   set `fix_verified`.

## Invariants to preserve when wiring the interpreter

* The prelude is checked **before** any action, including read-only ones on a customer device.
* `close_ticket` ends the run; no step after it executes.
* `fixed_recently` / `fix_cooldown_minutes` still refuses a second identical fix — a retry branch
  only fires if the author deliberately shortens the cooldown. A service that keeps dying is a
  human's problem.
* A fix that did not verify is never closed as done.
* Every mutating verb carries a `class` (`read` / `fix` / `reply` / `note` / `close` / `human` /
  `wait` / `stop`) so the bridge can keep gating on capability classes rather than on names.
* An unknown condition or action is rejected at save time — never ignored at run time.

---

## No IF, no run (owner, 2026-10-06)

> "should the script be applied only if it's in the IF and the IF is true… i think actions should
> be allowed to be there but they should NOT RUN unless an IF is setup in the rules"

An attached reviewed script is **library data, not authority**. Three things are now enforced in
code (`src/autowork-rule.js`, unit-tested in `test/autowork-fix.test.mjs`):

1. **A subject with no rule runs NO reviewed action.** `fix_actions` are kept (a person reviewed
   them) but they are inert. A `device_fix` subject with no `statements` is capped at read-only and
   may not close the ticket — nothing ran, so nothing is finished. *M365 Offboarding (subject #31)
   carried `m365-offboard-user` and no rule; it could never have run it.*
2. **A `run_script` only runs from inside an IF that is TRUE.** `rulePlan()` records the guard chain
   of every action and drops a script whose guard is false before it can reach the toolbelt:
   * `approved_by_support_contact` is settled from the recorded approval's **capacity** — a
     technician's approval does not satisfy it (account changes want the customer side);
   * the fix cooldown (`fix_allowed`) withholds every script on a ticket;
   * a `run_script` that is not inside any IF, or carries no body, is dropped;
   * the remaining conditions (`cause_known`, `details_sufficient`, `procedure_cause`, …) are the
     session's judgement, by design — but the step still has to sit inside an IF to be reachable.
   Dropped scripts are removed from `apply_fix` **and** named in the session prompt as unavailable.
3. **A script's own `RESULT: FAIL` line counts as a failure.** Every reviewed script ends with
   `RESULT: OK …` / `RESULT: FAIL …`; a FAIL now ends the run and hands the ticket to a human even
   if the script forgot to `exit 1` (subject #31's offboarding script printed FAIL and exited 0).

`_subject_payload` sends `fix_actions: []` and a `fix_allowed` boolean; the bridge never reads the
subject's attached actions for execution, only the rule's `run_script` steps. New scripted proposals
from the daily report are created **with** their rule (`rule_for_fix`), so a proposal can never be a
script that cannot run. Existing Fix subjects were migrated by
`python manage.py rules_for_fix_subjects --apply`.
