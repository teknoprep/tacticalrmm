"""THE RULE LANGUAGE for ticket automation subjects.

Owner's shape (2026-09-28): "a simple in english if then else endif type statements... if
approved by a support contact should be default for ALL and should still be there visible but
not editable... if sendplot is down, go investigate why, if you know why, go fix, if fixed send
ticket update and close, elseif stop processing, endif stop processing."

Why this is structured data and not free text: the model may never compose a command, and the
judge can only say NO - so permission has to be DATA a person can read and approve. Free text is
prose, and nothing can enforce prose. These sentences are therefore BLOCKS: a fixed vocabulary of
conditions and actions, rendered as English for the person writing the rule, then interpreted by
code at run time.

Two clauses are not the author's to write:

  * the PRELUDE - "if approved by a support contact". Every rule carries it, always, first, and
    it is not editable. Automation cannot act on a ticket until an authenticated approval exists
    (a console approval or a signed single-use token), never an emailed "yes".
  * the TERMINATOR - "stop processing". Always last, and a close_ticket implies it, so nothing
    after a close can ever run.

Neither is a prompt rule. `with_defaults()` puts them in every tree that is saved, and the
interpreter (and the bridge) treats them as structural: an action after a close is not reached
because the close ends the run.

Vocabulary note: an action marked `needs_ai` means the AI has to reason at that step every time
("go investigate why"). An action carrying a script body is deterministic - it runs the same
reviewed script every time. That is exactly the split the owner asked for, and it is what the
rule-drafting assistant decides when it writes a rule for you.
"""

from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# THE VOCABULARY. The editor renders straight from this, so the UI can never offer
# a verb the interpreter does not know, and the interpreter can never be handed one.
# ---------------------------------------------------------------------------

PRELUDE = {
    "id": "approval_gate",
    "text": "if approved by a support contact or a technician",
    "note": (
        "Every rule starts here and it cannot be edited. Automation may not act on a ticket "
        "until a PERSON has approved it: either a support contact for the customer (customer-side "
        "authorisation) or one of our own technicians (owner, 2026-09-28: \"it doesn't just have "
        "to be support contact approval... it can be tech approval\"). Approval is given in the "
        "AI Decision area of the ticket, which also opens the live run so the approver can watch "
        "the AI work and the scripts run, and see the output as it happens. An emailed 'yes' is "
        "never an approval."
    ),
}

TERMINATOR = {
    "id": "stop",
    "text": "stop processing",
    "note": "Always the last line. Closing a ticket also stops: nothing after a close ever runs.",
}

# ---------------------------------------------------------------------------
# HOW DESTRUCTIVE A REVIEWED ACTION IS (owner, 2026-10-15).
#
# The approval gate is ONE person saying "go" on ONE plan. The owner asked for a narrow way
# around it for actions that cannot destroy anything: "if it is bypassed the only actions
# that can be done are IMMUTABLE actions which have 0 affect on data... restarts of services
# when needed / computer updates / things like this... no deletion of files or change of
# licenses".
#
# CODE CANNOT PROVE a PowerShell body is non-destructive, so this is a DECLARED class on each
# reviewed action - reviewed data, exactly like the command body itself - and code enforces
# that ONLY the classes marked bypass=True may ever run without a per-ticket approval. The
# DEFAULT is "mutating", so an action that does not say what it is stays gated. The class is a
# claim by the person who saved the action; because the command and the class are reviewed
# together, a wrong class is a review failure - it is not something a ticket or a prompt can
# flip, which is what makes the boundary structural.
# ---------------------------------------------------------------------------
ACTION_SAFETY = [
    {
        "id": "read",
        "text": "read-only",
        "bypass": True,
        "plain": "it only reads (probe, query, list). Nothing on the device changes.",
    },
    {
        "id": "restart",
        "text": "restart a service or host",
        "bypass": True,
        "plain": "start / stop / restart a service, scheduled task or process, or reboot the host. "
                 "It does not create, change or delete customer data.",
    },
    {
        "id": "update",
        "text": "apply updates",
        "bypass": True,
        "plain": "install OS or software updates. It changes the system, but it does not delete or "
                 "rewrite customer data or accounts.",
    },
    {
        "id": "mutating",
        "text": "change data, files or accounts",
        "bypass": False,
        "plain": "anything else: creating, changing or deleting files, licences, mailboxes, users, "
                 "groups, configuration or credentials. ALWAYS needs a person's approval.",
    },
]
DEFAULT_ACTION_SAFETY = "mutating"
ACTION_SAFETY_IDS = frozenset(c["id"] for c in ACTION_SAFETY)
# The only classes that may ever skip the per-ticket approval. Everything else is gated.
BYPASSABLE_ACTION_SAFETY = frozenset(c["id"] for c in ACTION_SAFETY if c["bypass"])


def action_safety(action) -> str:
    """The declared safety of a reviewed action. Absent or unrecognised means 'mutating'."""
    c = str((action or {}).get("safety") or "").strip().lower()
    return c if c in ACTION_SAFETY_IDS else DEFAULT_ACTION_SAFETY


def is_bypassable(action) -> bool:
    """May this reviewed action run without a per-ticket approval? Only if its safety says so."""
    return action_safety(action) in BYPASSABLE_ACTION_SAFETY

# Conditions are evaluated by CODE. `needs_ai` marks the ones that require a model call at run
# time (the alternative would be a deterministic ruling from an approved procedure).
CONDITIONS = [
    {
        "id": "procedure_cause",
        "text": "procedure #{procedure} is the confirmed cause",
        "plain": "we know exactly what is wrong, from an approved procedure",
        "params": [{"name": "procedure", "type": "procedure", "required": True}],
        "needs_ai": False,
    },
    {
        "id": "probe_confirms",
        "text": "the read-only probe confirms procedure #{procedure}",
        "plain": "a read-only probe on the device proves it",
        "params": [{"name": "procedure", "type": "procedure", "required": True}],
        "needs_ai": False,
    },
    {
        # A PERMISSION REQUEST IS NOT A FAULT. "the cause is known" is the right question for a
        # printer that will not print; it is nonsense for "please give me access to X's mailbox",
        # where the question is whether the ticket SAYS ENOUGH to do the work. A dry run stalled on
        # exactly that: the model was asked whether it knew the cause of an access request.
        "id": "details_sufficient",
        "text": "the ticket says enough to do this",
        "plain": "the people are identifiable and the access is stated or is the normal level. A name as written in the ticket counts - the reviewed script resolves it on the tenant and REFUSES an ambiguous match rather than granting to the wrong person",
        "params": [],
        "needs_ai": True,
    },
    {
        "id": "cause_known",
        "text": "the cause is known",
        "plain": "the AI is confident enough to name the cause (no procedure matched)",
        "params": [],
        "needs_ai": True,
    },
    {
        "id": "fix_verified",
        "text": "the fix verified",
        "plain": "the procedure's own verification step passed after the fix",
        "params": [],
        "needs_ai": False,
    },
    {
        "id": "customer_replied",
        "text": "the customer replied",
        "plain": "the requester wrote back on this ticket",
        "params": [],
        "needs_ai": False,
    },
    {
        "id": "requester_is_support_contact",
        "text": "the requester is a support contact",
        "plain": "the person who filed it is already a primary/support contact",
        "params": [],
        "needs_ai": False,
    },
    {
        # The gate itself accepts a technician. This condition is for the rules that must NOT:
        # anything that changes a customer ACCOUNT (a password or MFA reset) still wants the
        # customer-side verification, so those rules narrow the gate themselves instead of
        # relying on a prompt to remember. Data, not discipline.
        "id": "approved_by_support_contact",
        "text": "the approval came from a support contact (not just a technician)",
        "plain": "narrow the gate: for account changes, a technician's approval is not enough",
        "params": [],
        "needs_ai": False,
    },
    {
        "id": "fixed_recently",
        "text": "a fix already ran in the last {minutes} minutes",
        "plain": "the cooldown - a service that keeps dying is a human's problem",
        "params": [{"name": "minutes", "type": "int", "required": True, "default": 60}],
        "needs_ai": False,
    },
    {
        "id": "nothing_matched",
        "text": "nothing else matched",
        "plain": "the catch-all, for the final ELSE",
        "params": [],
        "needs_ai": False,
    },
]

# Actions. `class` is what the bridge gates on; a script body is REVIEWED data (a person saved
# it), never text the model wrote at run time.
ACTIONS = [
    {
        "id": "investigate",
        "text": "investigate the device",
        "plain": "read-only probes on the customer's device. Nothing is changed.",
        "params": [],
        "needs_ai": True,
        "class": "read",
    },
    {
        "id": "verify_fix",
        "text": "check that it is back up",
        "plain": "run the procedure's verification step and record pass/fail - what the next IF reads.",
        "params": [{"name": "procedure", "type": "procedure", "required": False}],
        "needs_ai": False,
        "class": "read",
    },
    {
        "id": "fix_procedure",
        "text": "fix it with procedure #{procedure}",
        "plain": "run that procedure's reviewed remedy, on the ticket's device or the host the procedure pins.",
        "params": [{"name": "procedure", "type": "procedure", "required": True}],
        "needs_ai": False,
        "class": "fix",
    },
    {
        "id": "run_script",
        "text": "run the reviewed action \"{name}\"",
        "plain": "run a script you attached to this subject (Reviewed actions), by NAME. The command body lives there, reviewed by a person; the rule only names it, so the rule stays short and the command has one home. It runs ONLY from inside an IF that is true: a script the rule does not reach through a condition never executes (enforced in code, see the bridge's autowork-rule.js).",
        # PARAMETERS. A reviewed action on the subject carries its own parameter DECLARATIONS
        # (mailbox, grantee, access level, ...). The rule normally names the action and nothing
        # else; the AI reads the values from the ticket at run time and CODE validates every one,
        # because a value that comes out of a ticket is untrusted input on a command line. A rule
        # may still override `shell`, `timeout`, `wait` or `params`, and may carry an inline
        # `script` body for a one-off, but the library is the normal home for the command.
        #
        # Each parameter is:
        #   {"name": "Mailbox", "type": "email",   "required": true}
        #   {"name": "AccessLevel", "type": "choice", "choices": ["FullAccess","SendAs","SendOnBehalf"]}
        # Types: email (strict address), person (a display name OR an address), choice (fixed set),
        #        int, ticket_ref (TICKET/123), text (plain words, no quotes or newlines, 300 max).
        # A type that cannot be passed safely is refused rather than escaped hopefully.
        #
        # TIMEOUT AND WAIT ARE DIFFERENT THINGS and were conflated here. `timeout` is how long the
        # script may run before it is killed; `wait` is a pause AFTER it finishes. The first
        # version had only `wait`, which the bridge used as the kill limit - so a drafted rule
        # carrying wait=1 (meaning "do not pause") killed a mailbox-grant script after one second.
        "params": [
            {"name": "name", "type": "str", "required": True},
            {"name": "shell", "type": "choice", "choices": ["powershell", "cmd", "bash"], "required": False},
            {"name": "script", "type": "text", "required": False},
            {"name": "timeout", "type": "int", "required": False},
            {"name": "wait", "type": "int", "required": False},
            {"name": "params", "type": "params", "required": False},
        ],
        "needs_ai": False,
        "class": "fix",
    },
    {
        "id": "reply_customer",
        "text": "update the customer",
        "plain": "send the reply, using the subject's template if it has {{findings}}.",
        "params": [],
        "needs_ai": True,
        "class": "reply",
    },
    {
        "id": "note_ticket",
        "text": "note the ticket",
        "plain": "an internal note on the ticket - the customer does not see it.",
        "params": [],
        "needs_ai": True,
        "class": "note",
    },
    {
        "id": "close_ticket",
        "text": "close the ticket",
        "plain": "close it. Closing also STOPS this run - nothing after it is reached.",
        "params": [],
        "needs_ai": False,
        "class": "close",
    },
    {
        "id": "hand_to_human",
        "text": "hand it to a human",
        "plain": "tag the ticket for a technician and stop - the automation is done with it.",
        "params": [],
        "needs_ai": False,
        "class": "human",
    },
    {
        "id": "wait_customer",
        "text": "wait for the customer",
        "plain": "do nothing further and let the customer respond.",
        "params": [],
        "needs_ai": False,
        "class": "wait",
    },
    {
        "id": "stop",
        "text": "stop processing",
        "plain": "stop this run here.",
        "params": [],
        "needs_ai": False,
        "class": "stop",
    },
]

_BY_COND = {c["id"]: c for c in CONDITIONS}
_BY_ACTION = {a["id"]: a for a in ACTIONS}

MAX_DEPTH = 4          # deeper than this stops being readable English
MAX_ACTIONS = 40       # per rule, so a runaway draft cannot become a program

# A second fix_procedure inside one rule is legal - "if it is still down, try again" - but the
# interpreter refuses to re-run the same fix inside fix_cooldown_minutes (the existing loop
# guard, and the reason last_fix_at exists), so a retry only fires if the author deliberately
# shortens the cooldown. The editor warns when a rule names the same procedure to fix twice.
RETRY_NOTE = (
    "Naming the same procedure twice means 'try again', but the fix cooldown still refuses the "
    "second attempt unless you shorten it - that guard is what stops a dying service being "
    "restarted on a loop."
)


def vocabulary() -> dict:
    """Everything the editor needs to render the language, from this one place."""
    return {
        "prelude": PRELUDE,
        "terminator": TERMINATOR,
        "conditions": CONDITIONS,
        "actions": ACTIONS,
        "action_safety": ACTION_SAFETY,
        "max_depth": MAX_DEPTH,
    }


# The value types a reviewed script may declare. Anything not here cannot be passed to a command
# line, because "escaping it carefully" is a hope and a strict type is a guarantee.
# `person` exists because a TICKET says "Anna Marie", not "anna.marie@customer.com". The value may
# be a display name or an address, and the script resolves it on the tenant - where the truth is -
# rather than the rule guessing an address. Still a strict charset: no quotes, no symbols, so it
# cannot become anything other than a name or an address on the command line.
PARAM_TYPES = ("email", "person", "choice", "int", "ticket_ref", "text")
MAX_SCRIPT_PARAMS = 8


def _check_script_params(raw, where: str, errors: list) -> list:
    """Validate the parameter DECLARATIONS on a run_script action (not the values - those are
    supplied per run by the AI and validated there)."""
    if raw in (None, [], ""):
        return []
    if not isinstance(raw, list):
        errors.append(f"{where}: 'params' must be a list")
        return []
    out = []
    for j, pd in enumerate(raw[:MAX_SCRIPT_PARAMS]):
        if not isinstance(pd, dict):
            errors.append(f"{where}.params[{j}]: not a parameter")
            continue
        name = str(pd.get("name") or "").strip()
        typ = str(pd.get("type") or "").strip()
        if not name:
            errors.append(f"{where}.params[{j}]: needs a name")
            continue
        if typ not in PARAM_TYPES:
            errors.append(f"{where}.params[{j}] {name}: type must be one of {', '.join(PARAM_TYPES)}")
            continue
        entry = {"name": name, "type": typ}
        if typ == "choice":
            choices = [str(c)[:60] for c in (pd.get("choices") or [])][:20]
            if not choices:
                errors.append(f"{where}.params[{j}] {name}: a choice parameter needs its choices")
                continue
            entry["choices"] = choices
        if pd.get("required") is False:
            entry["required"] = False
        out.append(entry)
    if len(raw) > MAX_SCRIPT_PARAMS:
        errors.append(f"{where}: at most {MAX_SCRIPT_PARAMS} script parameters")
    return out


def _check_params(item: dict, args: dict, where: str, errors: list) -> dict:
    """Keep only the declared parameters, coerce their types, and require the required ones."""
    out = {}
    for p in item.get("params", []):
        name, typ = p["name"], p["type"]
        val = (args or {}).get(name, p.get("default"))
        if val is None or val == "":
            if p.get("required"):
                errors.append(f"{where}: '{name}' is required")
            continue
        try:
            if typ == "int":
                val = int(val)
            elif typ == "str" or typ == "text":
                val = str(val)
            elif typ == "choice":
                val = str(val)
                if p.get("choices") and val not in p["choices"]:
                    errors.append(f"{where}: '{name}' must be one of {', '.join(p['choices'])}")
                    continue
            elif typ == "procedure":
                val = int(val)
            elif typ == "params":
                out[name] = _check_script_params(val, where, errors)
                continue
        except (TypeError, ValueError):
            errors.append(f"{where}: '{name}' must be a {typ}")
            continue
        out[name] = val
    return out


def _check_steps(steps, where: str, errors: list, depth: int) -> list:
    """A branch body is a list of STEPS, and a step is either an action or a nested if-block.

    Blocks inside a branch are what makes the owner's rule expressible at all: "fix it... then
    check it is back up: if it is up, close the ticket; else hand it to a human" is an IF that
    comes AFTER actions. An `elif` is a sibling branch of the same IF, so it cannot say that.
    """
    if not isinstance(steps, list):
        errors.append(f"{where}: expected a list of steps")
        return []
    clean = []
    for i, s in enumerate(steps):
        if not isinstance(s, dict):
            errors.append(f"{where}[{i}]: not an action or a nested if")
            continue
        if "if" in s or s.get("block"):
            sub = _check_block(s, f"{where}[{i}]", errors, depth + 1)
            if sub:
                clean.append(sub)
            continue
        aid = str(s.get("action") or "")
        spec = _BY_ACTION.get(aid)
        if not spec:
            errors.append(f"{where}[{i}]: unknown action '{aid}'")
            continue
        clean.append({"action": aid, "args": _check_params(spec, s.get("args") or {}, f"{where}[{i}] {aid}", errors)})
    return clean


def _check_block(block, where: str, errors: list, depth: int) -> dict:
    if depth > MAX_DEPTH:
        errors.append(f"{where}: rules nested more than {MAX_DEPTH} deep stop being readable - flatten them")
        return {}
    if not isinstance(block, dict):
        errors.append(f"{where}: not an if-block")
        return {}
    cond = block.get("if") if isinstance(block.get("if"), dict) else {}
    cid = str(cond.get("condition") or "")
    spec = _BY_COND.get(cid)
    if not spec:
        errors.append(f"{where}: unknown condition '{cid}'")
        return {}
    out = {
        "if": {"condition": cid, "args": _check_params(spec, cond.get("args") or {}, f"{where} if {cid}", errors)},
        "then": _check_steps(block.get("then"), f"{where} then", errors, depth),
    }
    elifs = []
    for j, e in enumerate(block.get("elif") or []):
        cleaned = _check_block(e, f"{where} elseif[{j}]", errors, depth + 1)
        if cleaned:
            elifs.append(cleaned)
    if elifs:
        out["elif"] = elifs
    else_steps = _check_steps(block.get("else"), f"{where} else", errors, depth) if block.get("else") else []
    if else_steps:
        out["else"] = else_steps
    return out


def _count_steps(steps) -> int:
    n = 0
    for s in steps or []:
        if "action" in s:
            n += 1
        else:
            n += _count_steps(s.get("then")) + sum(_count_steps(e.get("then")) for e in s.get("elif") or []) + _count_steps(s.get("else"))
    return n


def _has_terminal(steps) -> bool:
    """Does every path end in close / hand over / wait? If not, the rule just falls out of the
    bottom, which is legal (the terminator stops it) but almost always a mistake."""
    for s in steps or []:
        if s.get("action") in ("close_ticket", "hand_to_human", "wait_customer"):
            return True
        if "if" in s:
            if _has_terminal(s.get("then")) and (_has_terminal(s.get("else")) if s.get("else") else True):
                return True
    return False


def validate(statements, *, require_terminator: bool = True) -> tuple[dict, list[str]]:
    """Validate a rule tree. Returns (clean_tree, errors) - errors are shown to the author, and a
    tree with errors is never saved, so the interpreter can trust what it reads."""
    errors: list[str] = []
    if statements in (None, {}, []):
        return {}, []
    if not isinstance(statements, dict):
        return {}, ["rule must be an object"]
    blocks = statements.get("blocks")
    if blocks is None:
        return {}, ["rule has no blocks"]
    if not isinstance(blocks, list):
        return {}, ["blocks must be a list"]
    clean = {"blocks": []}
    for i, b in enumerate(blocks):
        cb = _check_block(b, f"block {i + 1}", errors, 1)
        if cb:
            clean["blocks"].append(cb)
    n = _count_steps(clean["blocks"])
    if n > MAX_ACTIONS:
        errors.append(f"a rule may contain at most {MAX_ACTIONS} actions")
    if len(clean["blocks"]) > MAX_DEPTH:
        errors.append(f"a rule may contain at most {MAX_DEPTH} top-level if-blocks")
    # A rule whose paths never close, hand over or wait just runs out of steps. That is legal -
    # the terminator stops it - but it is almost always a mistake, so it is reported.
    if clean["blocks"] and not any(_has_terminal(b.get("then")) or _has_terminal(b.get("else")) for b in clean["blocks"]):
        errors.append("this rule never closes the ticket, hands it to a human, or waits - it will just stop")
    return clean, errors


def with_defaults(statements: dict) -> dict:
    """The saved shape. The prelude and the terminator are added here, so they exist in the data
    and not only in the interface - a rule read straight out of the database still has its gate."""
    out = dict(statements or {})
    out["prelude"] = PRELUDE["id"]
    out["terminator"] = TERMINATOR["id"]
    return out


# ---------------------------------------------------------------------------
# RUN_SCRIPT NAMES AN ATTACHED ACTION, IT DOES NOT CARRY THE BODY
#
# The owner (2026-10-06): "we either should just remove Actions altogether or call the action's
# name in the Rule so the rule isn't so long... i like the 2nd option here so we can collapse the
# scripts in this and then choose that in the rules".
#
# So the Reviewed actions ARE the library, and a rule's `run_script` step names one:
#
#     {"action": "run_script", "args": {"name": "m365-offboard-user"}}
#
# The command body, shell, timeout and parameter declarations live on the attached action. An inline
# `script` body is still accepted (older rules, one-offs) but `bind_run_scripts()` folds it into the
# library and leaves the rule naming it, so a saved rule never gets long again and the command has
# exactly one home.
# ---------------------------------------------------------------------------


def iter_run_scripts(statements):
    """Yield (step, where) for every run_script action in a rule tree."""
    def walk_steps(steps, where):
        for i, s in enumerate(steps or []):
            if not isinstance(s, dict):
                continue
            if "if" in s or s.get("block"):
                yield from walk_block(s, f"{where}[{i}]")
            elif s.get("action") == "run_script":
                yield s, f"{where}[{i}]"

    def walk_block(block, where):
        yield from walk_steps(block.get("then"), f"{where} then")
        for j, e in enumerate(block.get("elif") or []):
            if isinstance(e, dict):
                yield from walk_block(e, f"{where} elseif[{j}]")
        yield from walk_steps(block.get("else"), f"{where} else")

    if not isinstance(statements, dict):
        return
    for i, b in enumerate(statements.get("blocks") or []):
        if isinstance(b, dict):
            yield from walk_block(b, f"block {i + 1}")


def unbound_run_scripts(statements, action_names) -> list:
    """run_script steps that neither carry a `script` body nor name an attached reviewed action.

    These are not runnable - the bridge drops them - so they are a save-time error rather than a
    rule that quietly does nothing.
    """
    names = {str(n) for n in (action_names or []) if n}
    out = []
    for step, where in iter_run_scripts(statements):
        args = step.get("args") or {}
        if not args.get("script") and str(args.get("name") or "") not in names:
            out.append(
                f"{where}: run_script names '{args.get('name') or ''}', which is not an attached "
                f"reviewed action, and carries no script body"
            )
    return out


def bind_run_scripts(statements: dict, actions) -> tuple:
    """Normalise a rule so every run_script step REFERENCES an attached action by name.

    Returns (statements, actions, added_names, changed).

      * an inline `script` body whose name has no attached action is MOVED into the action list, so
        nothing the author wrote is lost and the rule becomes a reference;
      * an action that already exists is used as-is; the rule keeps only `name` (plus a deliberate
        `wait` if the author set one), so the duplicated body/overrides disappear.
    """
    import copy

    out = copy.deepcopy(statements or {})
    acts = [dict(a) for a in (actions or []) if isinstance(a, dict) and a.get("name")]
    by_name = {str(a["name"]): a for a in acts if a.get("name") and a.get("command")}
    added: list = []
    changed = False

    def fix_step(step):
        nonlocal changed
        args = step.get("args") if isinstance(step.get("args"), dict) else {}
        name = str(args.get("name") or "")
        if not name:
            return
        existing = by_name.get(name)
        if existing is None and args.get("script"):
            existing = {"name": name, "shell": args.get("shell") or "powershell",
                        "command": args["script"], "timeout": int(args.get("timeout") or 300),
                        "params": args.get("params") or []}
            acts.append(existing)
            by_name[name] = existing
            added.append(name)
        if existing is not None:
            keep = {"name": name}
            if "wait" in args:
                # Keep only a DELIBERATE pause: a wait that already matches the action's own wait
                # (or the 0 default) is noise and would only lengthen the rule.
                try:
                    deliberate = int(args["wait"]) != int(existing.get("wait") or 0)
                except (TypeError, ValueError):
                    deliberate = True
                if deliberate:
                    keep["wait"] = args["wait"]
            if args != keep:
                step["args"] = keep
                changed = True

    def walk_steps(steps):
        for s in steps or []:
            if not isinstance(s, dict):
                continue
            if "if" in s or s.get("block"):
                walk_block(s)
            elif s.get("action") == "run_script":
                fix_step(s)

    def walk_block(block):
        walk_steps(block.get("then"))
        for e in block.get("elif") or []:
            if isinstance(e, dict):
                walk_block(e)
        walk_steps(block.get("else"))

    for b in out.get("blocks") or []:
        if isinstance(b, dict):
            walk_block(b)
    return out, acts, added, changed


# ---------------------------------------------------------------------------
# ENGLISH. The rule is stored as blocks; people read sentences. Used by the editor, by the
# report, and by the tests that check a rule says what its author thought it said.
# ---------------------------------------------------------------------------

def _args_text(spec: dict, args: dict) -> dict:
    out = dict(args or {})
    for p in spec.get("params", []):
        if p["type"] == "script" or p["name"] == "script":
            out["script"] = "(script body)"
    return out


def _render_steps(steps, indent: int, lines: list):
    pad = "  " * indent
    for s in steps or []:
        if "if" in s:
            _render_block(s, indent, lines, first=True)
            continue
        spec = _BY_ACTION.get(s.get("action"))
        if not spec:
            continue
        try:
            text = spec["text"].format(**_args_text(spec, s.get("args") or {}))
        except (KeyError, IndexError):
            text = spec["id"]
        tag = "  [AI decides]" if spec.get("needs_ai") else ""
        lines.append(f"{pad}{text}{tag}")


def _render_block(block, indent: int, lines: list, first: bool):
    pad = "  " * indent
    cond = block.get("if") or {}
    spec = _BY_COND.get(cond.get("condition"))
    try:
        ctext = spec["text"].format(**(cond.get("args") or {})) if spec else "?"
    except (KeyError, IndexError):
        ctext = cond.get("condition", "?")
    lines.append(f"{pad}{'IF' if first else 'ELSE IF'} {ctext}")
    _render_steps(block.get("then"), indent + 1, lines)
    for e in block.get("elif") or []:
        _render_block(e, indent, lines, first=False)
    if block.get("else"):
        lines.append(f"{pad}ELSE")
        _render_steps(block.get("else"), indent + 1, lines)


def english(statements: dict, *, include_defaults: bool = True) -> list[str]:
    """The rule as the author reads it."""
    lines: list[str] = []
    if include_defaults:
        lines.append(f"IF {PRELUDE['text'][3:]}")
    for b in (statements or {}).get("blocks") or []:
        _render_block(b, 1 if include_defaults else 0, lines, first=True)
    if include_defaults:
        lines.append(TERMINATOR["text"].upper())
    return lines


# ---------------------------------------------------------------------------
# THE RULE-DRAFTING ASSISTANT
# ---------------------------------------------------------------------------

DRAFT_SYSTEM_PROMPT = """You write automation RULES for a managed-service helpdesk, in the shape
of English IF / THEN / ELSE IF / ELSE blocks. You are given a description of what the technician
wants, plus the procedures this subject may use.

You do not write prose. You return JSON:

{"statements": {"blocks": [ ... ]}, "notes": "one short paragraph on the choices you made"}

A block is:
{"if":   {"condition": "<condition id>", "args": {...}},
 "then": [ <step>, ... ],
 "elif": [ <nested block> ],          // optional, repeatable - a SIBLING branch
 "else": [ <step>, ... ]}

A step is EITHER an action  {"action": "<action id>", "args": {...}}
           OR a nested block {"if": {...}, "then": [...], "else": [...]}

Put a nested block INSIDE "then" when the check comes AFTER some actions. This is the shape the
SendPlot rule needs: fix it, check it is back up, and only then branch on the result. "elif" is a
sibling of the same IF and cannot express that.

CONDITION IDS (use args exactly as named):
  procedure_cause {procedure}          - an approved procedure has determined the cause
  probe_confirms {procedure}           - a read-only probe proves it
  details_sufficient                   - the ticket says enough to do the work (use for intake /
                                         permission requests, where there is no "cause")
  cause_known                          - the AI is confident enough to name the cause
  fix_verified                         - the procedure's verification passed
  customer_replied                     - the requester replied
  requester_is_support_contact         - the filer is already a support contact
  fixed_recently {minutes}             - a fix already ran inside the cooldown
  nothing_matched                      - catch-all for a final ELSE

ACTION IDS:
  investigate                          - read-only probes on the device
  verify_fix {procedure}               - run the procedure's verification and record pass/fail
                                         (put this after a fix, then branch on fix_verified)
  fix_procedure {procedure}            - run that procedure's reviewed remedy
  run_script {name, shell, script, timeout, wait, params} - run a reviewed action. USE THIS when
                                         the work is mechanical and identical every time.
                                         NORMAL SHAPE: name an action the subject already has
                                         attached (the person writing the rule sees them in the
                                         Reviewed actions list) - just {"name": "the-action"}. The
                                         command body, shell, timeout and parameter declarations
                                         live on that action, so the rule stays short.
                                         If NO attached action fits, write the finished body in
                                         `script` (powershell | cmd | bash) and declare any values
                                         it needs in `params`; the app moves the body into the
                                         subject's reviewed actions and the rule then names it.
                                         params: [{"name":"Mailbox","type":"email","required":true},
                                                  {"name":"AccessLevel","type":"choice",
                                                   "choices":["FullAccess","SendAs","SendOnBehalf"]}]
                                         Types: email | choice | int | ticket_ref | text.
  reply_customer                       - send the customer reply
  note_ticket                          - internal note
  close_ticket                         - close (stops the run)
  hand_to_human                        - tag for a technician and stop
  wait_customer                        - do nothing, wait for the customer
  stop                                 - stop processing

RULES YOU MUST FOLLOW:
1. Before writing anything, decide for each step: is this MECHANICAL (the same commands every
   time) or does it need JUDGEMENT each time? Mechanical -> run_script with the full script body
   written out. Judgement -> investigate / cause_known / fix_procedure / reply_customer, which
   call the AI at run time. Say which you chose and why in "notes".
2. Never invent a condition or action id, and never put a parameter in args that is not named above.
3. Every branch must end in one of: close_ticket, hand_to_human, wait_customer, or stop. Do not
   leave a branch that runs out of actions silently.
4. Prefer: investigate -> (cause known) -> fix -> verify_fix -> (fix_verified) -> reply +
   close, with hand_to_human or stop on every failure path. A fix that did not verify is NEVER
   closed as done - it is handed to a human.
5. You cannot approve anything and you cannot act: the rule always begins with the approval gate
   (a support contact OR a technician), which is added for you. Never write it yourself, and never
   write a stop at the end - also added. Where a step changes a customer ACCOUNT (password or MFA
   reset, group membership), add an `approved_by_support_contact` condition: the gate accepts a
   technician, but those steps want the customer-side verification.
6. Keep it shallow: two or three levels at most, so a technician can read it in one pass.
7. Only use procedure ids from the list you are given.
8. EVERY action that changes something (run_script, fix_procedure) MUST sit inside an IF branch. An
   action that is not guarded by an IF is never reached and never runs - the interpreter enforces
   this in code - so never write a bare action expecting it to run. A run_script normally names a
   reviewed action ATTACHED to the subject; only write a `script` body when no attached action
   fits, and the app will store it as one. The subject's attached `fix_actions` are library data,
   NOT authority: without a rule that reaches a run_script inside an IF, nothing on any device is
   touched.
"""


def draft_content(*, description: str, procedures: list[dict], subject: dict | None = None) -> str:
    plist = "\n".join(
        f"#{p['id']} | {p['title']} | status={p.get('status')} | applies_to={p.get('applies_to') or '-'}\n"
        f"     symptom: {(p.get('symptom') or '')[:220]}\n"
        f"     fix: {(p.get('fix') or '')[:400]}"
        for p in procedures
    ) or "  (no procedures available)"
    s = subject or {}
    acts = [str(a) for a in (s.get("actions") or []) if str(a).strip()]
    return (
        "WHAT THE TECHNICIAN WANTS THIS RULE TO DO:\n"
        f"{description.strip()}\n\n"
        "THE SUBJECT THIS RULE BELONGS TO:\n"
        f"name: {s.get('name') or '(new subject)'}\n"
        f"covers: {s.get('description') or '-'}\n"
        f"instructions: {(s.get('instructions') or '-')[:600]}\n"
        "REVIEWED ACTIONS ALREADY ATTACHED (name one in run_script instead of writing a body):\n"
        + ("\n".join(f"  - {a}" for a in acts) if acts else "  (none - write the script body if you need one; it will be stored as a reviewed action)")
        + "\n\nPROCEDURES AVAILABLE (use these ids):\n" + plist
    )
