"""Ticket Automation Subjects: the stage after triage that WORKS a human-filed ticket.

Owner's brief (2026-09-15): "if a ticket falls into that group it is allowed to be worked on
automatically as long as there is some matching procedure or KB article to get it going",
and "if multiple tickets are in for the same exact thing, we need to NOT have the AI working
on it more than once".

The decision that a ticket may be worked is made HERE, in code, from data a person approved:
  1. an approved, enabled subject whose declarative match rules fire on this ticket;
  2. whose client rule admits this customer (all clients, or a named client/domain);
  3. that has at least one procedure or KB article to work from;
  4. and nobody is already working the same thing (core.ai_workclaims).
Only then is the bridge asked to work it, and the bridge's own surface classes decide how far
it may go (see pibridge/src/capabilities.js: `advise` has no device tools at all).

Nothing here closes a ticket. A confident verdict may reply to the customer; anything less
leaves an internal note and the needs-input tag - exactly what happened before, plus the
evidence gathered.
"""

from __future__ import annotations

import logging
import re
from typing import Optional

import requests
from django.conf import settings
from django.utils import timezone

from core import ai_workclaims as claims

logger = logging.getLogger("trmm")


def hd_op(core, operation: str, args: dict):
    """One helpdesk operation through the bridge (same path poll_helpdesk_tickets uses)."""
    bridge = getattr(settings, "PI_BRIDGE_URL", "http://127.0.0.1:8787")
    out = requests.post(
        f"{bridge}/pi/helpdesk-op",
        json={
            "operation": operation, "args": args,
            "helpdesk_api": {"base_url": core.ai_helpdesk_api_base_url or "",
                             "api_key": core.ai_helpdesk_api_key or ""},
            "helpdesk_code": core.ai_helpdesk_code or "",
        },
        timeout=(5, 90),
    ).json()
    return out.get("result") if isinstance(out, dict) else None


def find_subject(*, subject_line: str, body: str, sender: str, client: str = "") -> Optional[object]:
    """First live subject whose rules fire AND whose client rule admits this customer."""
    from core.ai_conditions import evaluate_match
    from core.models import AITicketAutomationSubject

    rows = AITicketAutomationSubject.objects.filter(status="approved", enabled=True).order_by("-tickets_worked", "id")
    for s in rows:
        if not s.is_live:
            continue
        ok, _ident = evaluate_match(s.match, subject=subject_line, body=body, sender=sender)
        if not ok:
            continue
        if not s.allows_client(client, sender):
            continue
        return s
    return None


def _subject_payload(subj, core) -> dict:
    """What the bridge needs: the rules of engagement plus the knowledge to work from."""
    procs = [
        {
            "id": p.pk, "title": p.title, "applies_to": p.applies_to, "symptom": p.symptom,
            "root_cause": p.root_cause, "fix": p.fix, "verification": p.verification,
        }
        for p in subj.procedures.exclude(status="retired").exclude(status="rejected")
    ]
    kbs = []
    ids = [int(x) for x in (subj.kb_article_ids or []) if str(x).isdigit()]
    if ids:
        for i in ids:
            try:
                a = hd_op(core, "get_kb_article", {"id": i})
                if isinstance(a, dict) and a.get("content") is not None:
                    kbs.append({"id": i, "title": a.get("title", ""), "company": a.get("company", ""), "content": a.get("content", "")})
            except Exception as e:  # a missing article is not a reason to skip the ticket
                logger.warning("autowork: kb %s unavailable: %s", i, e)
    # THE REVIEWED REMEDIATION (device_fix only). Sent as data the owner approved; the
    # model picks one by NAME and can never compose a command. Withheld entirely while the
    # subject is inside its cooldown, so a service that keeps dying escalates to a human
    # instead of being restarted on a loop.
    fix_actions, fix_agent_id, fix_withheld = [], "", ""
    if subj.mode == "device_fix":
        from django.utils import timezone as _tz

        cooldown = int(getattr(subj, "fix_cooldown_minutes", 60) or 0)
        last = getattr(subj, "last_fix_at", None)
        if last and cooldown and _tz.now() < last + _tz.timedelta(minutes=cooldown):
            mins = int((last + _tz.timedelta(minutes=cooldown) - _tz.now()).total_seconds() // 60) + 1
            fix_withheld = (f"the reviewed fix was already applied at {last:%H:%M} UTC; it is withheld for "
                            f"another {mins} minute(s). Investigate read-only and hand this to a human.")
        else:
            fix_actions = [a for a in (subj.fix_actions or []) if isinstance(a, dict) and a.get("name") and a.get("command")]
            fix_agent_id = str((subj.fix_target or {}).get("agent_id") or "") if isinstance(getattr(subj, "fix_target", None), dict) else ""
    return {
        "id": subj.pk, "name": subj.name, "description": subj.description, "mode": subj.mode,
        "instructions": subj.instructions, "procedures": procs, "kb_articles": kbs,
        "fix_actions": fix_actions, "fix_agent_id": fix_agent_id, "fix_withheld": fix_withheld,
        # A reply is allowed in both modes; the bridge only sends on a confident verdict.
        "reply_allowed": True,
        "reply_template": (subj.instructions and "{{findings}}" in subj.instructions) and subj.instructions or "",
    }


# ---------------------------------------------------------------------------
# WHEN A CUSTOMER REPLIES TO SOMETHING THE AUTOMATION CLOSED
# ---------------------------------------------------------------------------
# Owner's rule (2026-09-17): "if someone opens a ticket back up with 'this didn't fix it'
# or 'this is still down' or something similar, this is when we need to get a human tech
# involved. If they reply with a thank you, we can reclose the ticket."
#
# Done in CODE, deterministically, before any model call:
#   * the automation said it fixed something and the customer says otherwise. That is
#     exactly the moment to stop automating and fetch a person - a second automated attempt
#     on a customer who is already unhappy is how trust is lost;
#   * a thank-you needs no thought and no spend. Re-close it.
# Order matters: the STILL-BROKEN test runs first, so "thanks, but it's still down" is read
# as still down. Anything that is neither goes down the ordinary triage path, where the
# model decides - guessing is not required here, only recognising the two clear cases.
_STILL_BROKEN = re.compile(
    r"\b(did ?n[o']?t (?:work|fix|help)|does ?n[o']?t work|not fixed|still (?:down|broken|not working|"
    r"happening|an issue|the same)|back (?:down|again)|same (?:problem|issue|thing) again|"
    r"no (?:better|change|luck)|worse|again today|happening again|not resolved|unresolved|"
    r"re-?open|reopen|this is still|it'?s still|isn'?t (?:fixed|working)|nothing (?:changed|happened))\b",
    re.I,
)
_THANKS = re.compile(
    r"\b(thank(?:s| you)|much appreciated|appreciate it|that'?s (?:great|perfect|working)|"
    r"all (?:good|set|sorted)|working (?:now|again)|it'?s (?:working|fixed|back)|perfect|sorted|"
    r"resolved|no further (?:action|issues))\b",
    re.I,
)


def classify_reply(text: str) -> str:
    """'still_broken' | 'thanks' | 'unclear' - from the customer's own words."""
    body = re.sub(r"\s+", " ", str(text or "")).strip()
    if not body:
        return "unclear"
    # Only the NEW part matters; a quoted history would match everything.
    body = body[:1500]
    if _STILL_BROKEN.search(body):
        return "still_broken"
    if _THANKS.search(body):
        # A thank-you that also describes a problem is not a thank-you. Kept deliberately
        # cautious: length is a poor signal, but a long message with a question in it is
        # far more likely to be a new problem than gratitude.
        if "?" in body and len(body) > 200:
            return "unclear"
        return "thanks"
    return "unclear"


def handle_reply_to_resolved(st, *, body_text: str, core, decision_url: str = "") -> Optional[str]:
    """A reply landed on a ticket the AUTOMATION had resolved. Escalate or re-close.

    Returns "escalated", "reclosed", or None when the ordinary triage path should run.
    """
    verdict = classify_reply(body_text)
    if verdict == "still_broken":
        st.status = "escalated"
        st.proposed_action = "Customer says it is not fixed. Escalated to a human; automation stands down."
        try:
            hd_op(core, "add_note", {"ticket": st.ticket_ref, "message": (
                "\U0001F916 Pi.dev AI - STANDING DOWN, A HUMAN IS NEEDED\n"
                "This ticket was resolved automatically and the customer has replied to say it is "
                "NOT fixed. The automation will not try again on this ticket - a technician needs to "
                "take it, because a second automated attempt on someone who is already unhappy is not "
                "what they asked for.\n\nWhat the automation did before is in the notes above."
                + (_chat_anchor(decision_url) if decision_url else ""))})
            hd_op(core, "set_needs_input_tag", {"ticket": st.ticket_ref})
            # Un-assign from the bot (never from a human - release_ticket enforces that)
            # so it shows in the queue as waiting for a person.
            hd_op(core, "release_ticket", {"ticket": st.ticket_ref})
        except Exception as e:
            logger.warning("reply-escalation note failed for %s: %s", st.ticket_ref, e)
        return "escalated"
    if verdict == "thanks":
        st.status = "auto_closed"
        st.proposed_action = "Customer confirmed it is sorted. Re-closed."
        try:
            hd_op(core, "ai_close_ticket", {"ticket": st.ticket_ref, "reason": (
                "\U0001F916 Pi.dev AI - the customer replied to confirm this is sorted, so the ticket "
                "is filed back to AI Closed. No reply was sent: they were thanking us, not asking for "
                "anything. A human promotes it to Closed if they agree.")})
        except Exception as e:
            logger.warning("reply-reclose failed for %s: %s", st.ticket_ref, e)
        return "reclosed"
    return None


def _chat_anchor(url: str, label: str = "Chat with me to continue this ticket") -> str:
    """A clickable link that opens in a NEW TAB, so a technician reading the ticket keeps it.

    Bare URLs are not auto-linkified by Odoo in a message body - the previous plain-text
    version was not clickable at all. target/rel survive Odoo 19's sanitiser (verified).
    """
    if not url:
        return ""
    return ('\n\n<div>\u27A1 <a href="' + url + '" target="_blank" rel="noopener noreferrer" '
            'style="color:#0b5cad;font-weight:600;text-decoration:none">' + label + "</a></div>")


def _mark_duplicate_closed(dup_ref: str, primary_ref: str) -> None:
    """Record on the duplicate's own state that the primary resolved it."""
    from core.models import AITicketState

    AITicketState.objects.filter(ticket_ref=dup_ref).update(
        status="auto_closed_duplicate", duplicate_of=primary_ref,
    )


def work_ticket(st, *, subj, body_text: str, client: str, decision_url: str, core, model,
                shadow: bool = False) -> dict:
    """Work one ticket under a subject. Returns a small result dict; updates `st` in place
    (caller saves). Takes and releases the work claim around the bridge call."""
    subj.tickets_matched += 1
    subj.save(update_fields=["tickets_matched"])

    # ---- the dedup lock -----------------------------------------------------------
    cond_key = ""
    for p in subj.procedures.all():
        if p.condition_key:
            cond_key = p.condition_key
            break
    fp = (claims.condition_fingerprint(cond_key, client) if cond_key
          else claims.subject_fingerprint(st.subject or "", st.requester or "", client))
    # ALREADY DONE, MOMENTS AGO? A second person in the same office writes in a minute
    # after the first ticket finished, when the claim has already been released. Without
    # this the ticket is worked from scratch - another model session, another restart of a
    # service that was just restarted. Recently-completed work counts as handled, and this
    # ticket is answered from it instead of redoing it.
    recent = claims.find_recent(fp, minutes=int(getattr(subj, "fix_cooldown_minutes", 60) or 60))
    prior_incident = None
    if recent and recent.ticket_ref != st.ticket_ref:
        # WHAT JUST HAPPENED, handed to this session as fact.
        #
        # TICKET/61475 is why. It arrived 49 seconds after TICKET/61474 finished, probed
        # SendPlot, found it UP - because the first session had restarted it four minutes
        # earlier - and told the customer the fault was probably his PC. Every statement in
        # that reply was true and the conclusion was wrong, because the session had no idea
        # the service had just been fixed. So it is told.
        from core.models import AITicketState as _S

        prev = _S.objects.filter(ticket_ref=recent.ticket_ref).first()
        prior_incident = {
            "ticket_ref": recent.ticket_ref,
            "finished_at": recent.released_at.strftime("%Y-%m-%d %H:%M UTC") if recent.released_at else "",
            "outcome": recent.outcome or "",
            "summary": (prev.summary or prev.proposed_action or "")[:1500] if prev else "",
            "fix_applied": bool(getattr(subj, "last_fix_at", None)),
        }
    if prior_incident:
        # Not "stand down" - the requester still deserves an answer, and now the session has
        # the facts to give a correct one. The fix itself stays withheld by the cooldown
        # (see _subject_payload), so it explains and confirms rather than restarting again.
        subj.tickets_deduped += 1
        subj.save(update_fields=["tickets_deduped"])
        st.duplicate_of = prior_incident["ticket_ref"]
        st.held_fingerprint = fp

    taken = claims.claim(fp, ticket_ref=st.ticket_ref, worker="autowork",
                         what=f"{subj.name}: {(st.subject or '')[:120]}", subject=subj)
    if not taken["ok"]:
        other = taken["claim"]
        subj.tickets_deduped += 1
        subj.save(update_fields=["tickets_deduped"])
        note = (
            f"\U0001F916 Pi.dev AI \u2014 Automation subject \"{subj.name}\"\n"
            f"NOT WORKED - the same thing is already being handled on {other.ticket_ref} "
            f"(by {other.worker}, since {other.claimed_at:%Y-%m-%d %H:%M} UTC).\n\n"
            f"Owner's rule: one piece of work, one worker. This ticket is recorded as a duplicate "
            f"on {other.ticket_ref}; whoever finishes that one should reply here too or merge the tickets."
            + (_chat_anchor(decision_url) if decision_url else "")
        )
        try:
            hd_op(core, "add_note", {"ticket": st.ticket_ref, "message": note})
        except Exception:
            pass
        # ON HOLD, not finished: the primary is still running and will come back to this
        # ticket when it settles (see the duplicates sweep at the end of this function).
        st.status = "on_hold"
        st.duplicate_of = other.ticket_ref
        st.held_fingerprint = fp
        st.proposed_action = f"On hold behind {other.ticket_ref} (being worked now). Not worked twice."
        return {"action": "deduped", "duplicate_of": other.ticket_ref}

    bridge = getattr(settings, "PI_BRIDGE_URL", "http://127.0.0.1:8787")
    outcome = "error"
    try:
        r = requests.post(
            f"{bridge}/pi/autowork",
            json={
                "ticket_ref": st.ticket_ref,
                "requester_email": st.requester or "",
                "client": client or "",
                "provider": model.provider.name, "model_id": model.model_id,
                "api_key": model.provider.api_key, "thinking_level": model.thinking_level,
                "decision_url": decision_url,
                "shadow": bool(shadow),
                "subject": _subject_payload(subj, core),
                # Tickets already held behind this one when the session starts. More may
                # arrive while it works - the session re-reads them with
                # list_duplicate_tickets before it finishes.
                # What was just done about this same thing, if anything (see above).
                "prior_incident": prior_incident,
                "duplicates": list(
                    __import__("core.models", fromlist=["AITicketState"]).AITicketState.objects
                    .filter(duplicate_of=st.ticket_ref, status="on_hold")
                    .values_list("ticket_ref", flat=True)
                ),
                "helpdesk_prompt": core.ai_helpdesk_prompt or "",
                "helpdesk_api": {"base_url": core.ai_helpdesk_api_base_url or "",
                                 "api_key": core.ai_helpdesk_api_key or ""},
                "helpdesk_code": core.ai_helpdesk_code or "",
            },
            timeout=(10, 600),
        )
        data = r.json()
    except Exception as e:
        data = {"error": f"bridge error: {e}"}

    if data.get("error"):
        st.status = "error"
        st.error_detail = f"autowork: {str(data['error'])[:1500]}"
        outcome = "error"
        # The bridge posts its own failure note when IT failed. If we never reached it
        # (bridge down, timeout), nothing is on the ticket yet - so say it here, and hand
        # the ticket to a human. Silence is the one outcome that is never acceptable.
        if data.get("action") != "failed":
            try:
                hd_op(core, "add_note", {"ticket": st.ticket_ref, "message": (
                    f"\U0001F916 Pi.dev AI \u2014 Automation subject \"{subj.name}\"\n"
                    f"COULD NOT WORK THIS TICKET\n\nReason\n{str(data['error'])[:600]}\n\n"
                    f"Nothing was sent to the customer and nothing on any device was changed. "
                    f"A technician needs to pick this up."
                    + (_chat_anchor(decision_url) if decision_url else ""))})
                hd_op(core, "set_needs_input_tag", {"ticket": st.ticket_ref})
            except Exception:
                pass
    else:
        action = data.get("action") or "note"
        v = data.get("verdict") or {}
        st.status = {"replied": "auto_replied", "shadow_reply": "auto_shadow"}.get(action, "needs_input")
        st.summary = (v.get("summary") or st.summary or "")[:5000]
        st.proposed_action = (
            f"[{subj.name}] {action}: {v.get('kind') or '?'} ({v.get('confidence') or '?'}), "
            f"{len(v.get('findings') or [])} finding(s)"
        )[:5000]
        st.error_detail = ""
        outcome = action
        if action == "replied":
            subj.tickets_worked += 1
            subj.last_worked = timezone.now()
            subj.save(update_fields=["tickets_worked", "last_worked"])
        # DID IT ACTUALLY CHANGE SOMETHING? The bridge reports which reviewed actions ran.
        # Recorded here because the 60-minute cooldown reads last_fix_at - without this the
        # cooldown can never engage and a service that keeps dying gets restarted on every
        # new ticket. Found the hard way on TICKET/61474: the restart ran, counters stayed 0.
        applied = [str(x) for x in (data.get("fix_applied") or []) if x]
        if applied:
            subj.fixes_applied = (subj.fixes_applied or 0) + 1
            subj.last_fix_at = timezone.now()
            subj.save(update_fields=["fixes_applied", "last_fix_at"])
            logger.info("autowork: %s applied fix %s on %s", subj.name, applied, st.ticket_ref)
    # AI CLOSED WHEN THE AUTOMATION FINISHED IT (owner, 2026-09-17). Only on a CONFIDENT
    # verdict we actually replied to: unsure, a failed reply or an error stays OPEN with the
    # needs-input tag, because closing a ticket nobody answered is worse than leaving it.
    # AI Closed and never Closed - that stage exists so a human reviews the decision.
    v_final = data.get("verdict") or {}
    applied_final = [str(x) for x in (data.get("fix_applied") or []) if x]
    if outcome == "replied" and v_final.get("confidence") == "confident":
        try:
            hd_op(core, "ai_close_ticket", {"ticket": st.ticket_ref, "reason": (
                "\U0001F916 Pi.dev AI - worked automatically under \"" + subj.name + "\" and resolved.\n"
                + "Verdict: " + str(v_final.get("kind") or "?") + " (confident). The customer has been replied to"
                + ("; actions run: " + ", ".join(applied_final) if applied_final else "")
                + ".\n\nFiled to AI Closed for human review - a person promotes it to Closed if they agree.")})
            st.status = "auto_closed"
        except Exception as e:
            logger.warning("autowork: could not AI-close %s: %s", st.ticket_ref, e)

    row = claims.release(fp, ticket_ref=st.ticket_ref, outcome=outcome)
    # Tickets that arrived for the same thing while this was being worked were told "in
    # hand on <this ticket>". Now tell them how it ended, so a duplicate is never left
    # pointing at a finished ticket with no word of the outcome.
    if row and row.duplicates:
        v = data.get("verdict") or {}
        ended = {
            "replied": "the customer on that ticket has been replied to",
            "shadow_reply": "a reply was drafted on that ticket (shadow mode, not sent)",
            "note": "it was handed to a technician (no confident verdict)",
            "reply_failed": "the reply could not be sent; a technician has it",
            "failed": "the automation could not complete it; a technician has it",
            "error": "the automation hit an error; a technician has it",
        }.get(outcome, outcome)
        for dup_ref in row.duplicates:
            try:
                hd_op(core, "add_note", {"ticket": dup_ref, "message": (
                    f"\U0001F916 Pi.dev AI \u2014 Automation subject \"{subj.name}\"\n"
                    f"UPDATE: {st.ticket_ref}, which this ticket duplicates, has finished - {ended}."
                    + (f" Verdict there: {v.get('kind')} ({v.get('confidence')})." if v.get("kind") else "")
                    + ("\n\nThe same answer has been sent to this requester and this ticket is filed to AI Closed."
                       if (outcome == "replied" and v.get("confidence") == "confident")
                       else f"\n\nThis ticket still needs its own reply or to be merged into {st.ticket_ref}."))})
                if outcome == "replied" and v.get("confidence") == "confident":
                    # Each person who wrote in gets the answer. Closing a ticket without
                    # telling the person who raised it is the silent outcome we never allow,
                    # even when it is "only" a duplicate.
                    # The session was shown the duplicates (list_duplicate_tickets) and
                    # wrote an answer for each requester in their own context. Use that;
                    # fall back to the primary's reply only if it did not write one, so
                    # nobody is ever closed without being told something true.
                    per_ticket = {str(x.get("ticket") or "").strip(): str(x.get("reply") or "").strip()
                                  for x in (v.get("duplicate_replies") or []) if isinstance(x, dict)}
                    reply = per_ticket.get(dup_ref) or str(v.get("customer_reply") or "").strip()
                    if reply:
                        hd_op(core, "reply_to_ticket", {"ticket": dup_ref, "message": reply})
                    hd_op(core, "ai_close_ticket", {"ticket": dup_ref, "reason": (
                        "\U0001F916 Pi.dev AI - duplicate of " + st.ticket_ref
                        + ", which was resolved automatically. Filed to AI Closed for human review.")})
                    _mark_duplicate_closed(dup_ref, st.ticket_ref)
                else:
                    hd_op(core, "set_needs_input_tag", {"ticket": dup_ref})
            except Exception as e:
                logger.warning("autowork: duplicate follow-up failed for %s: %s", dup_ref, e)
    return data
