"""Daily "Ticket Automation Subjects" report: which tickets could the AI have worked on its
own, if someone approved a subject for them - and the approve link to do it.

Owner's brief (2026-09-15): "a new report that shows me daily what tickets should/could be
handled by adding a simple ticket automation subject... there only needs to be a couple a
day, easily approved by clicking a link in the email."

HOW
  * Take the window's human-filed tickets that ended in triage without being worked
    (status triaged / needs_input, classification regular/unknown), minus any that an
    existing live subject already covers.
  * Give the model their subjects + one-line summaries + the approved procedure titles, and
    ask for AT MOST three subjects: name, plain description, declarative match rules (same
    shape as AIProcedure.match), the procedures that back each, the mode (advise unless a
    device really must be probed), which tickets each would have covered, and the risk.
  * Persist each as AITicketAutomationSubject(status="proposed") with one-time approve /
    reject tokens. The email is a card per proposal with the two links.
  * A proposal that duplicates an existing subject (same name, or same match) is not
    re-proposed; the report says so instead of nagging.

Approval is a GET on a tokenised URL (see core.views.AutomationSubjectDecide) - one click
from the email, no login - because the owner asked for exactly that. The token is 40 random
characters, single-use, and the only thing it can do is flip that one proposal to approved
or rejected. It cannot edit rules or widen a mode.
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
work, and (b) the library of approved troubleshooting procedures (title + keywords).

Propose AT MOST THREE "ticket automation subjects": kinds of ticket the AI could safely work
alone. Prefer subjects that (1) recur, (2) are answered from the ticket text or a read-only
check, (3) never need a change on a device. Each subject needs DECLARATIVE match rules that
would fire on those tickets and not on unrelated ones - patterns a human can read and approve.

Rules shape (all optional, all case-insensitive):
  subject_regex: regex on the subject line
  body_any: list of phrases, at least one must appear (subject+body)
  body_all: list of phrases, all must appear
  body_none: list of phrases that disqualify
  sender_regex: regex on the requester email

mode: "advise" (reply to the customer from the ticket text; no device access) or
"device_readonly" (a read-only probe on a device is needed to be sure). Never propose fixes.

Return ONLY JSON:
{"subjects": [{"name": str, "description": str, "mode": "advise"|"device_readonly",
  "match": {...}, "procedure_ids": [int], "ticket_refs": [str], "why": str, "risk": str,
  "reply_guidance": "what a good customer reply says, 2-3 sentences"}]}
If nothing is a safe candidate, return {"subjects": []}."""


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

    model = _resolve_ai_model(None)
    if not model:
        result["error"] = "no enabled AI model"
        return result

    lines = [f"{t.ticket_ref} | {t.requester or ''} | {(t.subject or '')[:110]} | {(t.summary or '')[:220]}" for t in uncovered]
    plist = [f"{p.pk} | {p.title} | {p.applies_to} | seen {p.occurrence_count}x" for p in approved_procs]
    content = ("TICKETS (ref | requester | subject | AI summary):\n" + "\n".join(lines)
               + "\n\nAPPROVED PROCEDURES (id | title | keywords):\n" + "\n".join(plist))
    bridge = getattr(settings, "PI_BRIDGE_URL", "http://127.0.0.1:8787")
    try:
        r = requests.post(
            f"{bridge}/pi/analyze",
            json={"provider": model.provider.name, "api_key": model.provider.api_key,
                  "model_id": model.model_id, "thinking_level": model.thinking_level or "medium",
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
    for raw in (data.get("subjects") or [])[:3]:
        name = str(raw.get("name") or "").strip()[:160]
        match = raw.get("match") if isinstance(raw.get("match"), dict) else {}
        if not name or not match:
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
            "subject": subj, "tickets": refs, "why": raw.get("why") or "", "risk": raw.get("risk") or "",
            "procedures": list(subj.procedures.values_list("title", flat=True)),
            "approve_url": _decide_url(subj.approve_token, "approve"),
            "reject_url": _decide_url(subj.reject_token, "reject"),
        })
    return result


def render_html(data: dict, core) -> str:
    e = escape
    base = _links(core)
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
        rules = "<br>".join(f"<code>{e(k)}</code>: {e(json.dumps(v))}" for k, v in (s.match or {}).items())
        procs = "".join(f"<li>{e(t)}</li>" for t in p["procedures"]) or "<li><i>none &mdash; will work from the ticket text and the subject's guidance</i></li>"
        tix = ", ".join(e(t) for t in p["tickets"][:12]) + (f" &hellip; +{len(p['tickets'])-12}" if len(p["tickets"]) > 12 else "")
        mode_txt = ("Advise &mdash; reply to the customer from the ticket; <b>no device access at all</b>"
                    if s.mode == "advise" else "Investigate &mdash; read-only probes on the device, then advise; <b>nothing is changed</b>")
        parts.append(
            f"<div style='{css_card}'>"
            f"<div style='font-size:15px;font-weight:600'>{e(s.name)}</div>"
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
            f"</div>"
            f"<div style='font-size:11px;color:#6b7280;margin-top:8px'>Approving makes it live for all clients in the mode above; it can be edited, narrowed or switched off any time on the Procedures page &rarr; Ticket Automation Subjects. The AI never closes a ticket under a subject, and replies only on a confident verdict with two or more concrete findings.</div>"
            f"</div>"
        )
    if data.get("skipped_existing"):
        parts.append("<div style='color:#6b7280;font-size:12px'>Not re-proposed (already exists): "
                     + ", ".join(f"{e(x['name'])} [{e(x['status'])}]" for x in data["skipped_existing"]) + "</div>")
    if base.get("procedures"):
        parts.append(f"<div style='margin-top:14px;font-size:12px'><a href='{e(base['procedures'])}'>Open the Procedures page</a> &middot; subjects are under the Ticket Automation Subjects tab.</div>")
    parts.append("</div>")
    return "".join(parts)
