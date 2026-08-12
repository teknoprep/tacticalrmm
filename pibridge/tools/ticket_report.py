#!/usr/bin/env python3
"""Open-ticket report generator - with working links, because a report you cannot act
from is just reading material.

Every row carries two links:
  * the TICKET in the helpdesk (review it)
  * the AI DECISION CHAT for that ticket (act on it) - /ai-decision/<token>, the same
    durable per-ticket thread the "Johnny 5 Need Input!" links use, so opening it keeps
    whatever history that ticket already has.

A decision token is created for any ticket that lacks one, seeded from the triage record,
so the link works on first click instead of 404ing.

Usage:
    python3 ticket_report.py classification.json  [--to chris@blueuc.com] [--dry-run]

classification.json is deliberately an INPUT, not something this script guesses: the
bucketing is a judgement call and belongs in a file a human can read and edit.
  {
    "title": "...",
    "intro_html": "...",
    "buckets": [
      {"name": "AI can finish now", "note": "...", "columns": ["What the AI would do",
       "What it needs"], "items": [{"ref": "TICKET/1", "what": "...", "blocker": "..."}]}
    ],
    "findings_html": "<li>...</li>",
    "closing_html": "..."
  }
"""

import argparse
import html
import json
import os
import sys

sys.path.insert(0, "/rmm/api/tacticalrmm")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tacticalrmm.settings")

import django  # noqa: E402

django.setup()

from django.conf import settings  # noqa: E402
from django.utils.crypto import get_random_string  # noqa: E402

from core.models import AIDecisionRequest, AITicketState, CoreSettings  # noqa: E402

HELPDESK_MODEL = "sh.helpdesk.ticket"


def rmm_base() -> str:
    w = getattr(settings, "CORS_ORIGIN_WHITELIST", None)
    return (w[0] if w else "").rstrip("/")


def ticket_url(core: CoreSettings, ticket_id: int) -> str:
    base = (core.ai_helpdesk_api_base_url or "").rstrip("/")
    return f"{base}/web#id={ticket_id}&model={HELPDESK_MODEL}&view_type=form" if base and ticket_id else ""


def decision_url(ref: str) -> str:
    """The durable per-ticket chat link. Creates the thread if this ticket never had one.

    Reuses ANY existing row for the ticket regardless of status - a closed thread still
    holds the history, and the chat reopens it - so a report link never starts a second
    parallel conversation about the same ticket.
    """
    base = rmm_base()
    if not base:
        return ""
    d = AIDecisionRequest.objects.filter(ticket_ref=ref).order_by("-updated").first()
    if not d:
        st = AITicketState.objects.filter(ticket_ref=ref).first()
        d = AIDecisionRequest.objects.create(
            token=get_random_string(32),
            ticket_ref=ref,
            question="",
            context={
                "client": "",
                "summary": (st.summary if st else ""),
                "requester": (st.requester if st else ""),
                "classification": (st.classification if st else ""),
                "affected_device": "",
            },
            messages=[],
            status="open",
        )
    return f"{base}/ai-decision/{d.token}"


TH = ('padding:6px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;'
      'color:#fff;font-size:12px')
TD = 'padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px'
LINK = 'color:#0b5cad;text-decoration:underline'
BTN = ('display:inline-block;padding:4px 10px;background:#1a3c6e;color:#ffffff;'
       'text-decoration:none;border-radius:4px;font-size:11.5px;white-space:nowrap')


def render(conf: dict, tix: dict, core: CoreSettings) -> str:
    def row(item):
        ref = item["ref"]
        t = tix.get(ref, {})
        turl = ticket_url(core, t.get("id"))
        durl = decision_url(ref)
        cust = (t.get("partner") or "").split(",")[0]
        left = (
            f'<b><a href="{turl}" style="{LINK}">{html.escape(ref.replace("TICKET/", "#"))}</a></b>'
            f'<br/><span style="color:#666;font-size:11px">{t.get("created","")[:10]}<br/>'
            f'{html.escape(t.get("stage",""))}<br/>{html.escape(t.get("assignee") or "unassigned")}</span>'
            f'<br/><a href="{durl}" style="{BTN}">Work it with AI &#8594;</a>'
        )
        cells = [left, html.escape(cust), html.escape(item.get("what", ""))]
        if item.get("blocker") is not None and len(bucket.get("columns", [])) > 1:
            cells.append(f'<span style="color:#8a4b00">{html.escape(item.get("blocker",""))}</span>')
        return "<tr>" + "".join(
            f'<td style="{TD}{";white-space:nowrap" if i == 0 else ""}">{c}</td>'
            for i, c in enumerate(cells)) + "</tr>"

    out = [
        '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.55;color:#24292f">',
        f'<div style="font-weight:700;color:#1a3c6e;font-size:19px;margin:0 0 4px">{conf["title"]}</div>',
        f'<div style="color:#666;font-size:12.5px;margin:0 0 8px">{conf.get("intro_html","")}</div>',
        '<div style="background:#eef3fa;border:1px solid #c9d8ea;border-radius:5px;padding:9px 12px;'
        'font-size:12.5px;margin:0 0 16px">Every ticket number links to the helpdesk. '
        '<b>Work it with AI</b> opens the AI chat already bound to that ticket - it can read the '
        'thread, run read-only checks, draft the reply and (with your approval) send and close.</div>',
    ]
    counts = "".join(
        f'<tr style="background:{"#fff" if i % 2 == 0 else "#f4f6f9"}">'
        f'<td style="{TD}"><b>{html.escape(b["name"])}</b></td>'
        f'<td style="{TD}">{len(b["items"])}</td>'
        f'<td style="{TD}">{b.get("note_short","")}</td></tr>'
        for i, b in enumerate(conf["buckets"]))
    out.append(
        f'<table style="border-collapse:collapse;width:100%;font-size:13px;margin:0 0 6px">'
        f'<tr><th style="{TH}">Bucket</th><th style="{TH}">Count</th><th style="{TH}">Meaning</th></tr>'
        f'{counts}</table>')

    for n, bucket in enumerate(conf["buckets"], 1):
        out.append(f'<div style="font-weight:700;color:#1a3c6e;font-size:16px;margin:22px 0 6px">'
                   f'{n}. {html.escape(bucket["name"])} '
                   f'<span style="color:#666;font-weight:400;font-size:14px">({len(bucket["items"])})</span></div>')
        if bucket.get("note"):
            out.append(f'<div style="font-size:13px;color:#444;margin:0 0 4px">{bucket["note"]}</div>')
        cols = ["Ticket", "Customer"] + bucket.get("columns", ["What the AI would do"])
        out.append(f'<table style="border-collapse:collapse;width:100%;margin:8px 0 18px">'
                   + "".join(f'<th style="{TH}">{html.escape(c)}</th>' for c in cols)
                   + "".join(row(i) for i in bucket["items"]) + "</table>")

    if conf.get("findings_html"):
        out.append('<div style="font-weight:700;color:#1a3c6e;font-size:16px;margin:22px 0 6px">'
                   'Things I found while reading, that are not about AI</div>'
                   f'<ul style="margin:6px 0 10px 22px;padding:0;font-size:13.5px">{conf["findings_html"]}</ul>')
    if conf.get("closing_html"):
        out.append('<div style="font-weight:700;color:#1a3c6e;font-size:16px;margin:22px 0 6px">'
                   'Recommendation</div>'
                   f'<div style="font-size:13.5px">{conf["closing_html"]}</div>')
    out.append("</div>")
    return "".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("classification")
    ap.add_argument("--tickets", default="/tmp/open_tickets.json",
                    help="JSON dump of open tickets (ref -> fields), from the helpdesk")
    ap.add_argument("--to", default="chris@blueuc.com")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    conf = json.load(open(a.classification))
    tix = {t["ref"]: t for t in json.load(open(a.tickets))}
    core = CoreSettings.objects.first()
    body = render(conf, tix, core)

    if a.dry_run:
        open("/tmp/report_preview.html", "w").write(body)
        print(f"dry run - {len(body)} chars written to /tmp/report_preview.html")
        return
    msg, ok = core.send_mail(
        subject=conf.get("subject", conf["title"]),
        body="This report is HTML with links - view it in an HTML-capable client.",
        html_body=body,
        override_recipients=[a.to],
    )
    print(f"sent_ok = {ok} | detail = {msg} | html chars = {len(body)}")


if __name__ == "__main__":
    main()
