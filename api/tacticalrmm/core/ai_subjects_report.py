"""Daily "Ticket Automation Subjects" report: which tickets could the AI have worked on its
own, if someone approved a subject for them - and the approve link to do it.

Owner's brief (2026-09-15): "a new report that shows me daily what tickets should/could be
handled by adding a simple ticket automation subject... there only needs to be a couple a
day, easily approved by clicking a link in the email."

HOW
  * Take the window's human-filed tickets that ended in triage without being worked
    (status triaged / needs_input, classification regular/unknown), minus any that an
    existing live subject already covers.
  * Give the model their subjects + one-line summaries, the approved procedure titles, AND
    THE SUBJECTS THAT ALREADY EXIST with their rules, and ask for AT MOST three proposals.
  * Persist each as AITicketAutomationSubject(status="proposed") with approve / reject
    tokens. The email is a card per proposal with the two links.

EXTEND, DON'T MULTIPLY (owner, 2026-09-25)
  The report was only ever shown the tickets, never the subjects that already existed, so it
  could only invent new ones. Three separate subjects arrived for what is one job - "Spam /
  phishing verification", "Unexpected account-verification emails", "Phishing or BEC
  impersonation report" - each a slightly different wording of "a customer is asking about a
  suspicious email". The owner's rule: if a new pattern is the same job as a live subject,
  propose WIDENING that subject instead of adding another one.

  So a proposal now has a kind:
    new    - a genuinely different job; becomes its own subject on approval.
    extend - extra recognition rules for subject N; approving MERGES them into N and retires
             the proposal row. No second near-duplicate subject is ever created.

Approval is a tokenised URL (see core.views.AutomationSubjectDecide). The link opens a
confirmation page and the decision is taken on the button POST - because mail-security
scanners fetch every link in an email and were silently consuming the one-click approvals.
The token is 40 random characters, good for one decision, and the only thing it can do is
flip that one proposal. It cannot edit rules or widen a mode.
"""

from __future__ import annotations

import json
import re
from html import escape

import requests
from django.conf import settings
from django.utils import timezone
from django.utils.crypto import get_random_string

PROPOSE_PROMPT = """You are helping an MSP decide what its helpdesk AI may handle WITHOUT a
human. You are given (a) recent human-filed tickets the AI understood but was not allowed to
work, (b) the library of approved troubleshooting procedures (title + keywords), and (c) THE
AUTOMATION SUBJECTS THAT ALREADY EXIST, with their current match rules.

MOST IMPORTANT RULE - DO NOT MULTIPLY SUBJECTS.
Before proposing anything new, check the existing subjects. If a ticket is THE SAME JOB as an
existing subject and only the wording differs, you must propose kind="extend" on that subject
- extra phrases/patterns added to its rules - NOT a new subject. "Is this email spam?", "is
this phishing?", "someone is impersonating my boss", "I got an unexpected verification code"
are ALL the same job: a customer asking us to judge a suspicious email. One subject, widened.
Propose kind="new" only when the WORK is genuinely different - a different system, a
different answer, a different procedure - not merely different vocabulary.

AT MOST THREE proposals total. Prefer ones that (1) recur, (2) are answered from the ticket
text or a read-only check, (3) never need a change on a device.

Rules shape (all optional, all case-insensitive). Note every declared key must pass (they are
ANDed), while the LIST inside one key is alternatives (any one matches):
  subject_regex: regex on the subject line
  body_regex: regex, or list of alternative regexes, on subject+body
  body_any: list of phrases, at least one must appear (subject+body)
  body_all: list of phrases, all must appear
  body_none: list of phrases that disqualify
  sender_regex: regex on the requester email
Because keys are ANDed, an EXTENSION that adds recognition must add to the SAME key the
subject already uses for recognition (usually body_regex or body_any) - adding a new key
would narrow the subject instead of widening it. Put disqualifiers in body_none.

mode: "advise" (reply to the customer from the ticket text; no device access) or
"device_readonly" (a read-only probe on a device is needed to be sure). Never propose fixes.

Return ONLY JSON:
{"subjects": [
  {"kind": "new", "name": str, "description": str, "mode": "advise"|"device_readonly",
   "match": {...}, "procedure_ids": [int], "ticket_refs": [str], "why": str, "risk": str,
   "reply_guidance": "what a good customer reply says, 2-3 sentences"},
  {"kind": "extend", "extends_subject_id": int, "name": "short label for the widening",
   "match": {"body_regex": ["...only the NEW alternatives..."], "body_none": ["..."]},
   "ticket_refs": [str], "why": "why this is the same job as that subject", "risk": str}
]}
If nothing is a safe candidate, return {"subjects": []}."""

# Keys whose value is a list of ALTERNATIVES: merging two rule sets means unioning these.
_LIST_KEYS = ("body_any", "body_all", "body_none", "body_regex")

# Words that carry no meaning about WHICH job a subject covers. Without this, every proposal
# looks similar to every other one ("the", "customer", "email", "issue").
_STOP = set(
    "the a an and or of for to in on at is are was were be been being this that these those "
    "with without from by as it its if then than so not no any all our your their his her "
    "customer client user users email e-mail ticket issue problem help please need needs "
    "cant cannot can't unable error failed failure fails new old get got has have had do does "
    "did done when what which who why how there here about into over under again more most".split()
)


def _tokens(text) -> set:
    return {w for w in re.findall(r"[a-z0-9]{3,}", str(text or "").lower()) if w not in _STOP}


def match_phrases(match: dict) -> set:
    """The meaningful words a subject's rules look for, across every list- and scalar-shaped key.

    This is what a subject IS, in recognition terms: two subjects that look for the same words are
    the same job however they are worded, and that is the duplicate the owner is asking about.
    """
    out: set = set()
    if not isinstance(match, dict):
        return out
    for key, val in match.items():
        if isinstance(val, list):
            for v in val:
                out |= _tokens(v)
        elif isinstance(val, str):
            out |= _tokens(val)
    return out


def subject_similarity(match_a: dict, match_b: dict) -> float:
    """How much of the SMALLER vocabulary sits inside the larger one (containment, not Jaccard).

    Jaccard was the obvious choice and it was wrong: "is this email phishing?" scores 0.14 against
    a subject that already recognises phishing, because the existing subject lists more phrases and
    the union grows. The question being asked is not "are these equally broad", it is "does the
    existing subject already recognise what this proposal recognises" - which is exactly
    |intersection| / |smaller set|.
    """
    a, b = match_phrases(match_a), match_phrases(match_b)
    if not a or not b:
        return 0.0
    return len(a & b) / float(min(len(a), len(b)))


def nearest_subject(proposal: dict, subjects, *, threshold: float = 0.5, procedures=None):
    """The existing subject this proposal is really about, or None.

    Deliberately NOT a prompt rule. The model is told not to multiply subjects, but "told" is not
    a guarantee, and a duplicate subject is not a cosmetic problem: two subjects that fire on the
    same ticket both work it, both reply, and both count the time saved. This check runs on the
    proposals the model actually returned.

    Two independent signals, because they fail differently:
      * RULE OVERLAP - the words the two subjects recognise. Catches re-wording of one job.
      * PROCEDURE OVERLAP - the same how-to attached. Catches the same job described from a
        different angle ("printer offline" vs "MFP not responding" sharing one procedure).
    """
    best, best_score = None, 0.0
    prop_procs = {int(x) for x in (procedures or proposal.get("procedure_ids") or []) if str(x).isdigit()}
    for s in subjects or []:
        score = subject_similarity(proposal.get("match") or {}, s.match or {})
        if score < 1.0 and prop_procs:
            try:
                have = set(s.procedures.values_list("pk", flat=True))
            except Exception:
                have = set()
            if prop_procs & have:
                # Shared how-to lifts a weak rule overlap over the line, but never on its own -
                # one procedure can legitimately serve several different jobs.
                score = max(score, threshold + 0.05)
        if score > best_score:
            best, best_score = s, score
    return best if best_score >= threshold else None


def merge_subject_match(target, addition: dict) -> dict:
    """Widen `target.match` with `addition`, in place, and return only what was ADDED.

    Only the list-shaped keys are merged, and only by union - an extension can teach a
    subject to recognise more tickets (or to disqualify more), it can never rewrite or
    remove a rule a human already approved. Scalar keys (subject_regex, sender_regex) are
    deliberately ignored: replacing them would silently narrow the subject.
    """
    if not isinstance(addition, dict):
        return {}
    match = dict(target.match or {})
    added: dict = {}
    for key in _LIST_KEYS:
        new_vals = addition.get(key)
        if not new_vals:
            continue
        if not isinstance(new_vals, list):
            new_vals = [new_vals]
        cur = match.get(key)
        cur = list(cur) if isinstance(cur, list) else ([cur] if cur else [])
        seen = {str(x).strip().lower() for x in cur}
        fresh = []
        for v in new_vals:
            s = str(v).strip()
            if s and s.lower() not in seen:
                seen.add(s.lower())
                cur.append(s)
                fresh.append(s)
        if fresh:
            match[key] = cur
            added[key] = fresh
    target.match = match
    return added


def _links(core):
    from core.ai_autowork_report import _links as _l

    return _l(core)


def _api_base():
    # The API host is what nginx routes /core/ to; the frontend origin is not it.
    return (getattr(settings, "ALLOWED_HOSTS", None) or ["api"])[0]


def _decide_url(token: str, action: str) -> str:
    host = _api_base()
    if host and not host.startswith("http"):
        host = f"https://{host}"
    return f"{host}/core/ai/automation-subjects/decide/{action}/{token}/"


def collect(hours=24, options=None) -> dict:
    """Read-only except for creating the `proposed` rows."""
    from core.ai_conditions import evaluate_match
    from core.models import AIProcedure, AITicketAutomationSubject, AITicketState
    from core.tasks import _resolve_ai_model

    core_settings = None
    from core.utils import get_core_settings

    core_settings = get_core_settings()
    since = timezone.now() - timezone.timedelta(hours=max(1, int(hours or 24)))
    tickets = list(
        AITicketState.objects.filter(
            created__gte=since, is_alert=False,
            classification__in=["regular", "unknown"],
            status__in=["triaged", "needs_input"],
        ).order_by("-created")[:120]
    )
    live = [s for s in AITicketAutomationSubject.objects.filter(status="approved", enabled=True) if s.is_live]
    uncovered = []
    for t in tickets:
        covered = False
        for s in live:
            ok, _ = evaluate_match(s.match, subject=t.subject or "", body=t.summary or "", sender=t.requester or "")
            if ok:
                covered = True
                break
        if not covered:
            uncovered.append(t)

    approved_procs = list(AIProcedure.objects.filter(status="approved").order_by("-occurrence_count")[:150])
    result = {
        "hours": hours, "generated": timezone.now(), "tickets": len(tickets),
        "uncovered": len(uncovered), "live_subjects": len(live), "proposals": [],
        "skipped_existing": [], "error": "",
    }
    if not uncovered:
        return result

    from core.agent_groups import headless_orchestrator_fields, model_fallback_fields

    ai_fields = headless_orchestrator_fields(core_settings, surface="subjects")
    if not ai_fields:
        model = _resolve_ai_model(None)
        if not model:
            result["error"] = "no enabled AI model"
            return result
        ai_fields = model_fallback_fields(model)

    lines = [f"{t.ticket_ref} | {t.requester or ''} | {(t.subject or '')[:110]} | {(t.summary or '')[:220]}" for t in uncovered]
    plist = [f"{p.pk} | {p.title} | {p.applies_to} | seen {p.occurrence_count}x" for p in approved_procs]
    # The model cannot avoid duplicating what it has never been shown. Give it every subject
    # that is not rejected, with its rules, so "extend #1" is an option it can actually take.
    known = list(
        AITicketAutomationSubject.objects.exclude(status="rejected").order_by("pk")
    )
    slist = [
        f"{s.pk} | {s.name} | status={s.status}{'/on' if s.enabled else '/off'} | mode={s.mode}\n"
        f"     covers: {(s.description or '')[:200]}\n"
        f"     rules: {json.dumps(s.match or {}, ensure_ascii=False)[:900]}"
        for s in known
    ]
    content = ("TICKETS (ref | requester | subject | AI summary):\n" + "\n".join(lines)
               + "\n\nEXISTING AUTOMATION SUBJECTS (id | name | status | mode) - extend these "
                 "rather than duplicating them:\n"
               + ("\n".join(slist) or "  (none yet)")
               + "\n\nAPPROVED PROCEDURES (id | title | keywords):\n" + "\n".join(plist))
    bridge = getattr(settings, "PI_BRIDGE_URL", "http://127.0.0.1:8787")
    try:
        r = requests.post(
            f"{bridge}/pi/analyze",
            json={**ai_fields,
                  "system_prompt": PROPOSE_PROMPT, "content": content,
                  "purpose": "report:automation_subjects", "username": "report"},
            timeout=(10, 420),
        )
        out = r.json()
    except Exception as e:
        out = {"error": str(e)}
    if out.get("error"):
        result["error"] = str(out["error"])[:300]
        return result
    text = (out.get("text") or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I | re.M)
    try:
        data = json.loads(text)
    except Exception:
        m = re.search(r"\{[\s\S]*\}", text)
        data = json.loads(m.group(0)) if m else {"subjects": []}

    existing_names = {s.name.strip().lower(): s for s in AITicketAutomationSubject.objects.all()}
    by_id = {s.pk: s for s in known}
    for raw in (data.get("subjects") or [])[:3]:
        name = str(raw.get("name") or "").strip()[:160]
        match = raw.get("match") if isinstance(raw.get("match"), dict) else {}
        if not name or not match:
            continue

        # ---- IS THIS ACTUALLY A NEW JOB? -------------------------------------------------
        # The prompt tells the model not to multiply subjects, but "told" is not a guarantee, and a
        # duplicate subject is not cosmetic: two subjects that fire on the same ticket both work
        # it, both reply, and both count the time saved. So a proposal the model marked "new" is
        # checked here against every live subject ON THE WORDS IT RECOGNISES, and if it is the same
        # job it is rewritten as an extension and flows down the reviewed extension path below -
        # one subject, widened, rather than a second one competing with it.
        if str(raw.get("kind") or "").lower() != "extend":
            near = nearest_subject(raw, live)
            if near is not None:
                probe = AITicketAutomationSubject(match=dict(near.match or {}))
                added = merge_subject_match(probe, match)
                if not added:
                    result["skipped_existing"].append({
                        "name": name,
                        "status": f"already covered by '{near.name}' - it recognises the same words",
                        "id": near.pk,
                    })
                    continue
                raw = dict(raw, kind="extend", extends_subject_id=near.pk, match=added)

        # ---- EXTENSION: widen a subject that already does this job -----------------
        if str(raw.get("kind") or "").lower() == "extend":
            tgt = by_id.get(int(raw["extends_subject_id"])) if str(raw.get("extends_subject_id") or "").isdigit() else None
            if not tgt or tgt.status == "rejected":
                pass  # unusable target - fall through and treat it as a new subject
            else:
                # Would it actually add anything? Merge against a throwaway copy first.
                probe = AITicketAutomationSubject(match=dict(tgt.match or {}))
                would_add = merge_subject_match(probe, match)
                if not would_add:
                    result["skipped_existing"].append(
                        {"name": name, "status": f"already covered by '{tgt.name}'", "id": tgt.pk})
                    continue
                if AITicketAutomationSubject.objects.filter(
                    status="proposed", proposal_kind="extend", extends_subject=tgt
                ).exists():
                    result["skipped_existing"].append(
                        {"name": name, "status": f"an extension of '{tgt.name}' is already waiting", "id": tgt.pk})
                    continue
                refs = [str(x) for x in (raw.get("ticket_refs") or []) if str(x).startswith("TICKET/")][:30]
                ext = AITicketAutomationSubject.objects.create(
                    name=f"Widen: {tgt.name}"[:160],
                    description=str(raw.get("description") or f"Extra recognition rules for '{tgt.name}'.")[:4000],
                    status="proposed", enabled=False, mode=tgt.mode, match=would_add,
                    proposal_kind="extend", extends_subject=tgt,
                    all_clients=tgt.all_clients, clients=list(tgt.clients or []), domains=list(tgt.domains or []),
                    approve_token=get_random_string(40), reject_token=get_random_string(40),
                    proposed_by_report=timezone.now(),
                    proposal_reason=(str(raw.get("why") or "") + ("\n\nRisk: " + str(raw.get("risk") or "") if raw.get("risk") else ""))[:4000],
                    proposal_tickets=refs,
                )
                result["proposals"].append({
                    "subject": ext, "target": tgt, "tickets": refs,
                    "why": raw.get("why") or "", "risk": raw.get("risk") or "", "procedures": [],
                    "approve_url": _decide_url(ext.approve_token, "approve"),
                    "reject_url": _decide_url(ext.reject_token, "reject"),
                })
                continue

        dup = existing_names.get(name.lower())
        if dup:
            result["skipped_existing"].append({"name": name, "status": dup.status, "id": dup.pk})
            continue
        # A different NAME for the same thing is still the same thing. If a live subject
        # already fires on the tickets this proposal says it would cover, it is covered -
        # do not re-propose it under new wording (the first run did exactly that).
        refs_claimed = [str(x) for x in (raw.get("ticket_refs") or [])]
        by_ref = {t.ticket_ref: t for t in uncovered}
        by_ref.update({t.ticket_ref: t for t in tickets})
        overlap = None
        for ref in refs_claimed:
            t = by_ref.get(ref)
            if not t:
                continue
            for lv in live:
                ok, _ = evaluate_match(lv.match, subject=t.subject or "", body=t.summary or "", sender=t.requester or "")
                if ok:
                    overlap = lv
                    break
            if overlap:
                break
        if overlap:
            result["skipped_existing"].append({"name": name, "status": f"covered by live subject '{overlap.name}'", "id": overlap.pk})
            continue
        mode = "device_readonly" if raw.get("mode") == "device_readonly" else "advise"
        refs = [str(x) for x in (raw.get("ticket_refs") or []) if str(x).startswith("TICKET/")][:30]
        subj = AITicketAutomationSubject.objects.create(
            name=name,
            description=str(raw.get("description") or "")[:4000],
            status="proposed", enabled=True, mode=mode, match=match,
            instructions=str(raw.get("reply_guidance") or "")[:4000],
            all_clients=True,
            approve_token=get_random_string(40), reject_token=get_random_string(40),
            proposed_by_report=timezone.now(),
            proposal_reason=(str(raw.get("why") or "") + ("\n\nRisk: " + str(raw.get("risk") or "") if raw.get("risk") else ""))[:4000],
            proposal_tickets=refs,
        )
        pids = [int(x) for x in (raw.get("procedure_ids") or []) if str(x).isdigit()]
        if pids:
            subj.procedures.set(AIProcedure.objects.filter(pk__in=pids))
        result["proposals"].append({
            "subject": subj, "target": None, "tickets": refs, "why": raw.get("why") or "", "risk": raw.get("risk") or "",
            "procedures": list(subj.procedures.values_list("title", flat=True)),
            "approve_url": _decide_url(subj.approve_token, "approve"),
            "reject_url": _decide_url(subj.reject_token, "reject"),
        })
    return result


def render_html(data: dict, core) -> str:
    e = escape
    base = _links(core)
    console = (base.get("frontend") or "").rstrip("/")

    def _review_url(sid):
        """Deep link into the console editor for one subject (tab + row).

        Approve/Reject are not the only sensible answers to a proposal: a reviewer often
        wants to see the match rules in context, attach a procedure, narrow the client scope
        or change how far the subject may go. That editor already exists - this is the link
        to it, scoped to the subject in question (an unscoped link opens the full list, which
        looks like it worked and quietly shows you everything).
        """
        try:
            sid = int(sid)
        except (TypeError, ValueError):
            return ""
        return f"{console}/ai-procedures?tab=subjects&subject={sid}" if console else ""

    css_card = ("border:1px solid #d8dee7;border-left:5px solid #1a3c6e;background:#fbfcfe;"
                "padding:14px 18px;margin:0 0 16px;font-family:Segoe UI,Arial,sans-serif")
    parts = [
        '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#1f2937;max-width:820px">',
        f"<h2 style='margin:0 0 4px'>Ticket Automation Subjects &mdash; what to automate next</h2>",
        f"<div style='color:#6b7280;margin-bottom:14px'>Last {int(data['hours'])}h: {data['tickets']} human-filed ticket(s) the AI understood but was not allowed to work; "
        f"{data['uncovered']} not covered by any of the {data['live_subjects']} live subject(s).</div>",
    ]
    if data.get("error"):
        parts.append(f"<div style='color:#92400e;background:#fffbeb;border:1px solid #fcd34d;padding:10px'>Proposals unavailable: {e(data['error'])}</div>")
    if not data["proposals"] and not data.get("error"):
        parts.append("<div style='padding:10px;background:#f0fdf4;border:1px solid #86efac'>Nothing new to propose today"
                     + (" &mdash; every uncovered ticket was a one-off, or already has a proposal waiting." if data["uncovered"] else " &mdash; everything that arrived was covered or was an alert.")
                     + "</div>")
    for p in data["proposals"]:
        s = p["subject"]
        target = p.get("target")
        # For an extension this is the subject being widened; for a new proposal it is the
        # proposed row itself (persisted before the email renders, tokens and all).
        review = _review_url(target.pk if target else s.pk)
        rules = "<br>".join(f"<code>{e(k)}</code>: {e(json.dumps(v))}" for k, v in (s.match or {}).items())
        procs = "".join(f"<li>{e(t)}</li>" for t in p["procedures"]) or "<li><i>none &mdash; will work from the ticket text and the subject's guidance</i></li>"
        tix = ", ".join(e(t) for t in p["tickets"][:12]) + (f" &hellip; +{len(p['tickets'])-12}" if len(p["tickets"]) > 12 else "")
        mode_txt = ("Advise &mdash; reply to the customer from the ticket; <b>no device access at all</b>"
                    if s.mode == "advise" else "Investigate &mdash; read-only probes on the device, then advise; <b>nothing is changed</b>")

        if target:
            # AN EXTENSION, not a new subject. Say plainly that nothing new is being created.
            card = css_card.replace("#1a3c6e", "#0f766e")
            parts.append(
                f"<div style='{card}'>"
                f"<div style='font-size:11px;font-weight:700;letter-spacing:.06em;color:#0f766e'>WIDEN AN EXISTING SUBJECT</div>"
                f"<div style='font-size:15px;font-weight:600;margin-top:2px'>{e(target.name)}</div>"
                f"<div style='margin:6px 0 10px'>{e(s.description)}</div>"
                f"<div><b>Already covers:</b> {e((target.description or '')[:300])}</div>"
                f"<div style='margin-top:6px'><b>Mode stays:</b> {mode_txt}</div>"
                f"<div style='margin-top:6px'><b>Tickets it missed:</b> {tix or '&mdash;'}</div>"
                f"<div style='margin-top:6px'><b>Why it is the same job:</b> {e(p['why'])}</div>"
                + (f"<div style='margin-top:6px;color:#92400e'><b>Risk:</b> {e(p['risk'])}</div>" if p["risk"] else "")
                + f"<div style='margin-top:8px'><b>Rules to ADD</b> (nothing existing is changed or removed):<div style='font-size:12px;margin:4px 0 0 10px'>{rules}</div></div>"
                f"<div style='margin-top:14px'>"
                f"<a href='{e(p['approve_url'])}' style='background:#0f766e;color:#fff;padding:9px 16px;text-decoration:none;border-radius:4px;font-weight:600'>Approve &mdash; widen this subject</a>"
                f"&nbsp;&nbsp;<a href='{e(p['reject_url'])}' style='background:#991b1b;color:#fff;padding:9px 16px;text-decoration:none;border-radius:4px'>Reject</a>"
                + (f"&nbsp;&nbsp;<a href='{e(review)}' style='background:#1f2937;color:#fff;padding:9px 16px;text-decoration:none;border-radius:4px'>Review &amp; modify</a>" if review else "")
                + f"</div>"
                f"<div style='font-size:11px;color:#6b7280;margin-top:8px'>No new subject is created. The rules above are added to <b>{e(target.name)}</b>, which keeps its mode, clients and reply guidance. You will be asked to confirm on the page that opens.</div>"
                f"</div>"
            )
            continue

        parts.append(
            f"<div style='{css_card}'>"
            f"<div style='font-size:11px;font-weight:700;letter-spacing:.06em;color:#1a3c6e'>NEW SUBJECT</div>"
            f"<div style='font-size:15px;font-weight:600;margin-top:2px'>{e(s.name)}</div>"
            f"<div style='margin:6px 0 10px'>{e(s.description)}</div>"
            f"<div><b>Mode:</b> {mode_txt}</div>"
            f"<div style='margin-top:6px'><b>Would have covered:</b> {tix or '&mdash;'}</div>"
            f"<div style='margin-top:6px'><b>Why:</b> {e(p['why'])}</div>"
            + (f"<div style='margin-top:6px;color:#92400e'><b>Risk:</b> {e(p['risk'])}</div>" if p["risk"] else "")
            + f"<div style='margin-top:8px'><b>Match rules</b> (a ticket must fit these):<div style='font-size:12px;margin:4px 0 0 10px'>{rules}</div></div>"
            f"<div style='margin-top:8px'><b>Works from:</b><ul style='margin:4px 0'>{procs}</ul></div>"
            f"<div style='margin-top:14px'>"
            f"<a href='{e(p['approve_url'])}' style='background:#166534;color:#fff;padding:9px 16px;text-decoration:none;border-radius:4px;font-weight:600'>Approve &mdash; start working these tickets</a>"
            f"&nbsp;&nbsp;<a href='{e(p['reject_url'])}' style='background:#991b1b;color:#fff;padding:9px 16px;text-decoration:none;border-radius:4px'>Reject</a>"
            + (f"&nbsp;&nbsp;<a href='{e(review)}' style='background:#1f2937;color:#fff;padding:9px 16px;text-decoration:none;border-radius:4px'>Review &amp; modify</a>" if review else "")
            + f"</div>"
            f"<div style='font-size:11px;color:#6b7280;margin-top:8px'>Not sure it is ready? <b>Review &amp; modify</b> opens this subject in the console - adjust the match rules, the mode, the client scope or the procedures it works from, then approve it yourself. Approving makes it live for all clients in the mode above; it can be edited, narrowed or switched off any time on the Procedures page &rarr; Ticket Automation Subjects. The AI never closes a ticket under a subject, and replies only on a confident verdict with two or more concrete findings. You will be asked to confirm on the page that opens.</div>"
            f"</div>"
        )
    if data.get("skipped_existing"):
        parts.append("<div style='color:#6b7280;font-size:12px'>Not re-proposed (already exists): "
                     + ", ".join(f"{e(x['name'])} [{e(x['status'])}]" for x in data["skipped_existing"]) + "</div>")
    if base.get("procedures"):
        parts.append(f"<div style='margin-top:14px;font-size:12px'><a href='{e(base['procedures'])}'>Open the Procedures page</a> &middot; subjects are under the Ticket Automation Subjects tab.</div>")
    parts.append("</div>")
    return "".join(parts)
