"""APPROVAL FOR AUTOMATION, BOUND TO THE PLAN THE TECHNICIAN ACTUALLY REVIEWED.

Owner, 2026-09-28:

  * "it can be approved by a tech and that should be allowed in the ai-decision area of the notes
    in the ticket... basically it would allow a tech to approve the workflow / take them to a
    window where it can watch the AI work & scripts run / and see the output live... so it doesn't
    just have to be support contact approval... it can be tech approval"
  * "when the tech get's take to the area where it works on things... it will be told what its
    about to do first... that way the tech can review before you say go"

So the gate has two channels - a support contact for the customer (customer-side authorisation,
via a signed single-use token) or one of our own technicians (authenticated in the AI Decision
window) - and approval is NOT a blanket permission for a subject. It is approval of a specific
PLAN, for one ticket, reviewed on screen first.

That is why two digests are stored:

  rule_digest  - which version of the rule the plan was written under. Edit the rule and every
                 outstanding approval stops matching: approving rule A must never authorise rule B.
  plan_digest  - the exact steps shown to the approver. If the plan is regenerated and differs,
                 `approve()` refuses and it goes back for review. "You approved X, and now it is Y"
                 is the failure this exists to prevent.

Nothing here runs anything. It records who reviewed what, and answers one question for the
interpreter: has THIS plan, under THIS rule, been approved for THIS ticket, by a person, and has
the approval not lapsed?
"""

from __future__ import annotations

import hashlib
import json
from datetime import timedelta

from django.utils import timezone

# How long an approval stays usable. Long enough to cover a technician reviewing and then letting
# the run proceed; short enough that an untouched approval does not sit around for weeks.
DEFAULT_TTL_HOURS = 24
MAX_TTL_HOURS = 24 * 7

CAPACITY_TECHNICIAN = "technician"
CAPACITY_SUPPORT_CONTACT = "support_contact"


def digest(obj) -> str:
    """Stable digest of a rule or a plan: sorted keys, no whitespace, so the same content always
    hashes the same and a reordering of nothing does not invalidate an approval by accident."""
    blob = json.dumps(obj or {}, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def plan_from_rule(subject, statements: dict) -> dict:
    """"Here is what I am about to do" - the rule instantiated for ONE subject, in the order it
    would run, with the machine and the scripts named.

    Deliberately derived from the rule and the subject's own settings rather than written by a
    model at review time: an approver must be reviewing the same thing the interpreter will do,
    and a model-written summary could describe something else. The plan is a rendering of the
    rule, so the two cannot drift.
    """
    from core.ai_rules import ACTIONS, CONDITIONS, english

    act = {a["id"]: a for a in ACTIONS}
    cond = {c["id"]: c for c in CONDITIONS}
    target = (getattr(subject, "fix_target", None) or {}) if subject is not None else {}
    host = target.get("hostname") or "the device on this ticket"
    steps: list[dict] = []

    def name(spec, args):
        try:
            return spec["text"].format(**(args or {}))
        except (KeyError, IndexError):
            return spec["id"]

    def walk_steps(steps_list, depth, where):
        """A branch body holds actions AND nested blocks. Skipping the blocks would hide the most
        important part of the plan from the person approving it - the "if it verified, reply and
        close; otherwise hand it to a human" part."""
        for a in steps_list or []:
            if "if" in a:
                walk_blocks([a], depth + 1, where)
                continue
            spec = act.get(a.get("action"))
            if not spec:
                continue
            text = name(spec, a.get("args"))
            detail = ""
            args = a.get("args") or {}
            if a.get("action") in ("fix_procedure", "run_script", "investigate", "verify_fix"):
                detail = f"on {host}"
            if a.get("action") == "run_script" and args.get("script"):
                # `timeout`, not `wait` - the two were conflated and a plan showing "timeout 1s" for a
                # mailbox-grant script was showing a rule that would kill it after a second.
                detail = f"{detail} · timeout {args.get('timeout', 300)}s"
            steps.append({
                "step": text,
                "detail": detail.strip(" ·"),
                "needs_ai": bool(spec.get("needs_ai")),
                "class": spec.get("class"),
                "mutating": spec.get("class") in ("fix", "reply", "close"),
                "where": where,
                "depth": depth,
            })

    def walk_blocks(blocks, depth, where):
        for b in blocks or []:
            c = (b.get("if") or {})
            cspec = cond.get(c.get("condition"))
            if cspec:
                steps.append({
                    "step": f"if {name(cspec, c.get('args'))}",
                    "detail": "the AI decides this" if cspec.get("needs_ai") else "checked by code",
                    "needs_ai": bool(cspec.get("needs_ai")),
                    "class": "condition",
                    "mutating": False,
                    "where": where,
                    "depth": depth,
                })
            walk_steps(b.get("then"), depth + 1, where)
            for e in b.get("elif") or []:
                walk_blocks([e], depth, "else if")
            if b.get("else"):
                steps.append({"step": "else", "detail": "", "needs_ai": False, "class": "branch",
                              "mutating": False, "where": where, "depth": depth})
                walk_steps(b.get("else"), depth + 1, where)

    walk_blocks((statements or {}).get("blocks") or [], 0, "")
    return {
        "subject_id": getattr(subject, "pk", None),
        "subject_name": getattr(subject, "name", "") or "",
        "host": host,
        "steps": steps,
        "english": english(statements) if statements else [],
        "mutates": any(s.get("mutating") for s in steps),
    }


def propose(*, ticket_ref: str, subject, statements: dict, plan: dict | None = None, proposed_by: str = "automation"):
    """Record the plan the technician will be asked to review. Returns the row, unapproved.

    A new proposal supersedes any earlier undecided one for the same ticket+subject: there is only
    ever one thing on screen to say yes to.
    """
    from core.models import AIAutomationApproval

    plan = plan or plan_from_rule(subject, statements)
    AIAutomationApproval.objects.filter(
        ticket_ref=ticket_ref, subject=subject, approved_at__isnull=True, declined_at__isnull=True
    ).update(revoked_at=timezone.now())
    return AIAutomationApproval.objects.create(
        ticket_ref=ticket_ref,
        subject=subject,
        rule_digest=digest(statements),
        plan=plan,
        plan_digest=digest(plan),
        proposed_by=(proposed_by or "")[:150],
    )


def approve(row, *, by: str, capacity: str, plan: dict | None = None, rule: dict | None = None,
            minutes: int | None = None):
    """A person says GO on the plan they were shown.

    Refuses when the thing on screen is no longer the thing that would run - the whole point of
    showing the plan first. Raising here is correct: the approver is told to look again instead of
    silently authorising something they did not read.
    """
    if row.approved_at:
        raise ValueError("this plan has already been approved")
    if row.declined_at:
        raise ValueError("this plan was declined - ask for a new one")
    if row.revoked_at:
        raise ValueError("this approval was withdrawn")
    if plan is not None and digest(plan) != row.plan_digest:
        raise ValueError("the plan changed since you reviewed it - review it again before approving")
    if rule is not None and digest(rule) != row.rule_digest:
        raise ValueError("the rule changed since you reviewed it - review it again before approving")
    minutes_given = minutes is not None
    if minutes_given:
        mins = max(1, min(int(minutes), MAX_TTL_HOURS * 60))
    else:
        mins = DEFAULT_TTL_HOURS * 60
    row.approved_at = timezone.now()
    row.approved_by = (by or "")[:150]
    row.approver_capacity = capacity if capacity in (CAPACITY_TECHNICIAN, CAPACITY_SUPPORT_CONTACT) else CAPACITY_TECHNICIAN
    row.expires_at = row.approved_at + timedelta(minutes=mins)
    row.save(update_fields=["approved_at", "approved_by", "approver_capacity", "expires_at"])
    return row


def decline(row, *, by: str, reason: str = ""):
    row.declined_at = timezone.now()
    row.declined_by = (by or "")[:150]
    row.decline_reason = (reason or "")[:200]
    row.save(update_fields=["declined_at", "declined_by", "decline_reason"])
    return row


def active_approval(ticket_ref: str, subject, statements: dict, plan_digest: str | None = None):
    """The approval the interpreter may act on, or None. Expiry is enforced here, so no cleanup
    job is needed - the same approach as the session capability grants."""
    from core.models import AIAutomationApproval

    now = timezone.now()
    qs = (
        AIAutomationApproval.objects.filter(
            ticket_ref=ticket_ref,
            subject=subject,
            approved_at__isnull=False,
            declined_at__isnull=True,
            revoked_at__isnull=True,
            rule_digest=digest(statements),
        )
        .order_by("-approved_at")
    )
    for row in qs:
        if row.expires_at and row.expires_at <= now:
            continue
        if plan_digest and row.plan_digest != plan_digest:
            continue
        return row
    return None


def review(row, statements: dict | None = None) -> dict:
    """Everything the AI Decision window needs to put in front of a technician: what the rule
    allows, what it is about to do on THIS ticket, who decided what so far, and whether the
    approval still matches the rule (an edited rule invalidates it - it must be re-reviewed)."""
    from core.ai_rules import english

    now = timezone.now()
    current = digest(statements) if statements is not None else None
    return {
        "id": row.pk,
        "ticket_ref": row.ticket_ref,
        "subject": {"id": getattr(row.subject, "pk", None), "name": getattr(row.subject, "name", "")},
        "plan": row.plan,
        "plan_digest": row.plan_digest,
        "rule_digest": row.rule_digest,
        "rule_still_matches": (current is None) or (current == row.rule_digest),
        "rule_english": english(statements) if statements else [],
        "proposed_by": row.proposed_by,
        "created": row.created.isoformat() if row.created else None,
        "approved_by": row.approved_by,
        "approver_capacity": row.approver_capacity,
        "approved_at": row.approved_at.isoformat() if row.approved_at else None,
        "expires_at": row.expires_at.isoformat() if row.expires_at else None,
        "declined_by": row.declined_by,
        "declined_at": row.declined_at.isoformat() if row.declined_at else None,
        "decline_reason": row.decline_reason,
        "revoked_at": row.revoked_at.isoformat() if row.revoked_at else None,
        "state": (
            "declined" if row.declined_at
            else "revoked" if row.revoked_at
            else "expired" if (row.expires_at and row.expires_at <= now)
            else "approved" if row.approved_at
            else "awaiting_review"
        ),
        "awaiting_go": bool(row.approved_at) and not row.declined_at and not row.revoked_at
                        and not (row.expires_at and row.expires_at <= now)
                        and ((current is None) or current == row.rule_digest),
    }
