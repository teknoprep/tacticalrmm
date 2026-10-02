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
        "text": "run the script \"{name}\"",
        "plain": "run this reviewed script. Same script every time - no reasoning involved.",
        # PARAMETERS. A reviewed script usually NEEDS VALUES: `grant-mailbox-delegate-access`
        # takes a mailbox, a grantee and an access level, and without them PowerShell refuses to
        # start ("missing mandatory parameter"). Those values are exactly what the AI works out
        # from the ticket, so the rule declares the parameters and the AI fills them at run time -
        # and CODE validates every value before it is passed, because a value that comes out of a
        # ticket is untrusted input on a command line.
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
            {"name": "shell", "type": "choice", "choices": ["powershell", "cmd", "bash"], "required": True, "default": "powershell"},
            {"name": "script", "type": "text", "required": True},
            {"name": "timeout", "type": "int", "required": False, "default": 300},
            {"name": "wait", "type": "int", "required": False, "default": 0},
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
  run_script {name, shell, script, timeout, wait, params} - run a script. USE THIS when the work is
                                         mechanical and identical every time: you MUST write the
                                         finished script body (powershell | cmd | bash).
                                         If the script needs values (a mailbox, a user, a level),
                                         declare them in params so the AI fills them from the ticket
                                         and code validates them:
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
"""


def draft_content(*, description: str, procedures: list[dict], subject: dict | None = None) -> str:
    plist = "\n".join(
        f"#{p['id']} | {p['title']} | status={p.get('status')} | applies_to={p.get('applies_to') or '-'}\n"
        f"     symptom: {(p.get('symptom') or '')[:220]}\n"
        f"     fix: {(p.get('fix') or '')[:400]}"
        for p in procedures
    ) or "  (no procedures available)"
    s = subject or {}
    return (
        "WHAT THE TECHNICIAN WANTS THIS RULE TO DO:\n"
        f"{description.strip()}\n\n"
        "THE SUBJECT THIS RULE BELONGS TO:\n"
        f"name: {s.get('name') or '(new subject)'}\n"
        f"covers: {s.get('description') or '-'}\n"
        f"instructions: {(s.get('instructions') or '-')[:600]}\n\n"
        "PROCEDURES AVAILABLE (use these ids):\n" + plist
    )
