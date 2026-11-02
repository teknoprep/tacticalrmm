"""Turn a finished "Complete this ticket" run into rows a person can approve.

Owner (2026-10-15): the console button runs the AI on one ticket, and when it succeeds it hands
back "an automation rule and the procedures that were required to get this done", which a person
then approves. This module is the ONLY place that writes those artifacts, so the approval is
enforced in one spot rather than trusted to each caller.

Two rules it keeps:

  * NOTHING IS LIVE UNTIL APPROVED. `validate_artifacts()` only cleans and checks what the run
    proposed - it writes nothing. `apply_artifacts()` is what creates/updates the AIProcedure rows
    and the AITicketAutomationSubject, and it is only called from the approve endpoint.
  * A RULE GOES THROUGH THE SAME VALIDATOR AS A HAND-WRITTEN ONE. `ai_rules.validate()` +
    `bind_run_scripts()` are applied here exactly as the subject serializer applies them, so an
    AI-authored rule can never contain a verb, condition or script reference the interpreter would
    refuse. The model writes JSON; code decides whether it is a rule.
"""

from __future__ import annotations

MAX_PROCEDURES = 6
MAX_MATCH_PHRASES = 12
PROCEDURE_FIELDS = (
    "title", "category", "applies_to", "symptom", "root_cause", "fix", "verification",
)
PROCEDURE_TEXT_MAX = 6000


def _text(value, limit=PROCEDURE_TEXT_MAX) -> str:
    return str(value if value is not None else "").strip()[:limit]


def _rule_name(value, fallback: str) -> str:
    name = _text(value, 160)
    return name or fallback


def validate_artifacts(raw) -> tuple[dict, list[str]]:
    """Clean what a run proposed. Returns ({procedures, rule, notes}, errors).

    `errors` is non-empty only when the proposed RULE is unusable (an unknown verb, a bad nest, a
    run_script naming an action that was not carried with it). Procedures never fail the run - a bad
    one is dropped with a note, because the fix the AI just performed is still real evidence even if
    its write-up is thin.
    """
    from core.ai_rules import bind_run_scripts, unbound_run_scripts, validate, with_defaults

    raw = raw if isinstance(raw, dict) else {}
    errors: list[str] = []
    notes: list[str] = []

    # ---- procedures -----------------------------------------------------------
    procedures: list[dict] = []
    seen_titles: set[str] = set()
    for i, p in enumerate(raw.get("procedures") or []):
        if len(procedures) >= MAX_PROCEDURES:
            notes.append(f"more than {MAX_PROCEDURES} procedures proposed; the rest were ignored")
            break
        if not isinstance(p, dict):
            continue
        title = _text(p.get("title"), 300)
        if not title:
            notes.append(f"procedure {i + 1} had no title and was ignored")
            continue
        key = title.lower()
        if key in seen_titles:
            continue
        seen_titles.add(key)
        procedures.append({
            "title": title,
            "category": _text(p.get("category"), 100),
            "applies_to": _text(p.get("applies_to"), 400),
            "symptom": _text(p.get("symptom")),
            "root_cause": _text(p.get("root_cause")),
            "fix": _text(p.get("fix")),
            "verification": _text(p.get("verification")),
            "origin": "ai_resolution",
            "status": "approved",
        })

    # ---- rule -----------------------------------------------------------------
    rule_in = raw.get("rule") if isinstance(raw.get("rule"), dict) else {}
    rule: dict = {}
    if rule_in and (rule_in.get("statements") or {}).get("blocks"):
        statements, rule_errors = validate(rule_in.get("statements"))
        if rule_errors:
            errors.extend(f"rule: {e}" for e in rule_errors[:8])
        else:
            actions = [a for a in (rule_in.get("fix_actions") or []) if isinstance(a, dict) and a.get("name")]
            from core.serializers import AITicketAutomationSubjectSerializer

            actions = AITicketAutomationSubjectSerializer().validate_fix_actions(actions)
            bound, actions, _added, _changed = bind_run_scripts(with_defaults(statements), actions)
            missing = unbound_run_scripts(bound, [a.get("name") for a in actions])
            if missing:
                errors.extend(f"rule: {m}" for m in missing[:8])
            else:
                match_in = rule_in.get("match") if isinstance(rule_in.get("match"), dict) else {}
                clean_match: dict = {}
                for field in ("subject_regex", "body_all", "body_any", "body_none", "sender_regex"):
                    val = match_in.get(field)
                    if isinstance(val, list):
                        vals = [str(v)[:200] for v in val if str(v).strip()][:MAX_MATCH_PHRASES]
                        if vals:
                            clean_match[field] = vals
                    elif isinstance(val, str) and val.strip():
                        clean_match[field] = val.strip()[:300]
                rule = {
                    "name": _rule_name(rule_in.get("name"), "AI-completed ticket"),
                    "description": _text(rule_in.get("description"), 2000),
                    "mode": rule_in.get("mode") if rule_in.get("mode") in ("advise", "device_readonly", "device_fix") else "device_fix",
                    "match": clean_match,
                    "statements": bound,
                    "fix_actions": actions,
                }
    elif rule_in:
        notes.append("a rule was proposed without any IF-blocks and was ignored")

    return {"procedures": procedures, "rule": rule, "notes": notes}, errors


def apply_artifacts(completion) -> dict:
    """Save the approved procedures + rule. Called ONLY from the approve endpoint.

    Returns {procedure_ids, subject_id, created_subject}. Extends the subject the run matched
    rather than creating a near-duplicate (owner choice 2026-10-15); creates one only when nothing
    matched.
    """
    from django.utils import timezone

    from core.models import AIProcedure, AITicketAutomationSubject

    proc_ids: list[int] = []
    for p in completion.proposed_procedures or []:
        title = _text((p or {}).get("title"), 300)
        if not title:
            continue
        # Re-use an existing procedure with the same title instead of duplicating the knowledge.
        existing = AIProcedure.objects.filter(title__iexact=title).first()
        if existing:
            changed = []
            for field in PROCEDURE_FIELDS:
                val = _text((p or {}).get(field), 400 if field == "applies_to" else 300 if field == "category" else PROCEDURE_TEXT_MAX)
                if val and not getattr(existing, field):
                    setattr(existing, field, val)
                    changed.append(field)
            if changed:
                existing.updated_by = (completion.started_by or "")[:120]
                existing.save(update_fields=changed + ["updated_by", "updated"])
            proc_ids.append(existing.pk)
            continue
        proc = AIProcedure.objects.create(
            title=title,
            category=_text((p or {}).get("category"), 100),
            applies_to=_text((p or {}).get("applies_to"), 400),
            symptom=_text((p or {}).get("symptom")),
            root_cause=_text((p or {}).get("root_cause")),
            fix=_text((p or {}).get("fix")),
            verification=_text((p or {}).get("verification")),
            origin="ai_resolution",
            status="approved",
            confidence="medium",
            source_ticket_refs=[completion.ticket_ref],
            first_seen=timezone.now(),
            last_seen=timezone.now(),
            updated_by=(completion.started_by or "")[:120],
        )
        proc_ids.append(proc.pk)

    subject_id = None
    created_subject = False
    rule = completion.proposed_rule or {}
    if rule:
        subj = completion.subject
        if subj is None:
            subj = AITicketAutomationSubject()
            created_subject = True
        subj.name = _rule_name(rule.get("name"), subj.name or f"AI: {completion.ticket_ref}")
        if rule.get("description"):
            subj.description = _text(rule.get("description"), 2000)
        if (rule.get("statements") or {}).get("blocks"):
            subj.statements = rule["statements"]
        if rule.get("fix_actions"):
            subj.fix_actions = rule["fix_actions"]
        want_mode = rule.get("mode") if rule.get("mode") in ("advise", "device_readonly", "device_fix") else "device_fix"
        subj.mode = want_mode
        if rule.get("match"):
            subj.match = {**(subj.match or {}), **rule["match"]}
        if created_subject:
            subj.status = "approved"
            subj.approved_at = timezone.now()
            subj.approved_by = (completion.started_by or "")[:150]
        subj.save()
        subject_id = subj.pk

    completion.applied_procedure_ids = proc_ids
    completion.applied_subject_id = subject_id
    completion.status = "approved"
    completion.save(update_fields=["applied_procedure_ids", "applied_subject_id", "status", "updated"])
    return {"procedure_ids": proc_ids, "subject_id": subject_id, "created_subject": created_subject}
