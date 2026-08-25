"""Auto-work readiness report.

The question this answers, for every ticket that arrived in the window:

    Would the AI have worked this by itself? Using which procedure? And if not, what
    exactly is stopping it?

Written because the honest answer to "is this ready to trust" is not a number, it is a
list of specific tickets with specific verdicts you can click through and check. A
percentage would be easy to produce and impossible to audit.

Nothing here changes any ticket or arms any procedure. It reports what WOULD happen if
the blockers were cleared, which is what makes it safe to run daily while trust is still
being built.
"""
import re

from django.utils import timezone

# The five conditions AIProcedure.is_live_rule requires. Kept as data so the report
# names the SAME blockers the engine enforces, rather than a paraphrase that can drift
# out of step with it.
LIVE_RULE_REQUIREMENTS = (
    ("approved", "not approved yet", lambda p: p.status == "approved"),
    ("auto_enabled", "auto-work switched off", lambda p: bool(p.auto_enabled)),
    ("condition_key", "no condition key", lambda p: bool((p.condition_key or "").strip())),
    ("disposition", "no disposition set", lambda p: bool((p.disposition or "").strip())),
    ("match", "no match rules", lambda p: isinstance(p.match, dict) and bool(p.match)),
)

# Extras that are not required to rule, but are required to ACT safely, so they belong in
# the same conversation.
ACTION_REQUIREMENTS = (
    ("probe", "no probe to confirm the condition",
     lambda p: isinstance(p.probe, dict) and bool(p.probe)),
    ("baseline_minutes", "no baseline minutes (time saved cannot be measured)",
     lambda p: p.baseline_minutes is not None),
)

_WORD = re.compile(r"[a-z0-9][a-z0-9\-\.']{2,}")
_STOP = {
    "the", "and", "for", "with", "that", "this", "from", "not", "are", "was", "has",
    "have", "you", "your", "our", "their", "please", "thanks", "thank", "hello", "hi",
    "issue", "problem", "ticket", "help", "need", "can", "will", "would", "should",
    "when", "what", "where", "there", "been", "they", "them", "any", "all", "get",
    "into", "out", "about", "email", "user", "users", "still", "just", "know", "let",
}


def _words(text):
    return {w for w in _WORD.findall((text or "").lower()) if w not in _STOP}


def _proc_text(p):
    return " ".join([p.title or "", p.applies_to or "", p.symptom or ""])


def _idf(procs):
    """How distinctive is each word, measured across the procedure library itself.

    Counting shared words was wrong and produced exactly the failure it deserved:
    TICKET/59833 ("I am having trouble opening our SendPlot program") was matched to a
    SharePoint procedure on cloud + having + opening -- three ordinary words, one of which
    came from the greeting "Hi Blue Cloud Support" -- while the correct SendPlot procedure
    matched on the single word "sendplot" and was DISCARDED for having only one hit.

    So weight by rarity instead. A word in one procedure out of 386 identifies it; a word
    in eighty identifies nothing. No hand-maintained list of banned words to keep in step
    with the library, because the library defines its own vocabulary.
    """
    import math

    df = {}
    for p in procs:
        for w in _words(_proc_text(p)):
            df[w] = df.get(w, 0) + 1
    n = max(1, len(procs))
    return {w: math.log(n / (1.0 + c)) for w, c in df.items()}, df


# A shared word must clear this much accumulated rarity before a procedure is offered.
MATCH_SCORE_MIN = 3.2
# ...but rarity alone was not enough, and the data said so. Measured against the procedure
# library, "having" appears in 4 of 386 and "cloud" in 3, so ordinary correspondence words
# score as HIGHLY distinctive -- the library is small and written in prose, which makes it
# the wrong yardstick for how English is normally used. #234 still beat #143 15.58 to 6.95.
#
# So a match must be ANCHORED IN THE SUBJECT LINE. The subject is the requester's own
# one-line statement of the problem, which is the closest thing to ground truth available
# without asking a model. "SendPlot" anchors on sendplot; nothing in "having trouble
# opening" reaches the subject at all, so the SharePoint procedure stops being offered.
#
# There is deliberately NO body-only escape hatch. One was tried -- "a sufficiently rare
# term anywhere in the body also qualifies" -- and it immediately readmitted the same bad
# match: "opening" scored 6.7 once the title boost was applied, so the SharePoint procedure
# won again on the phrase "having trouble opening". Any threshold high enough to exclude
# ordinary English would need a model of ordinary English, and the procedure library is not
# one: it says "having" appears in 4 documents of 386 and is therefore distinctive.
#
# The consequence is accepted on purpose. A ticket whose subject is "Help" or "Issue" now
# gets NO procedure offered, and is reported as such. That understates readiness, which is
# the correct direction for a report whose whole purpose is deciding what to trust.
# Words in the title or applies_to are what the procedure is ABOUT, rather than prose that
# happens to mention them, so they count for more.
TITLE_BOOST = 1.6


def _match_hits(match, subject, body):
    """Evaluate a procedure's match dict the way the engine does.

    Returns (fired, explanation). Unknown keys make it NOT fire: a rule the report does
    not understand must never be reported as a hit, because that would overstate
    readiness -- which is the one error this report cannot afford.
    """
    if not isinstance(match, dict) or not match:
        return False, "no match rules"
    hay_subject = (subject or "").lower()
    hay_body = ((subject or "") + "\n" + (body or "")).lower()
    reasons, ok = [], True
    for key, terms in match.items():
        terms = [str(t).lower() for t in (terms if isinstance(terms, list) else [terms])]
        if key in ("body_all", "all"):
            miss = [t for t in terms if t not in hay_body]
            if miss:
                ok = False
                reasons.append("missing all-terms: " + ", ".join(miss[:3]))
            else:
                reasons.append("all-terms present")
        elif key in ("body_any", "any"):
            hit = [t for t in terms if t in hay_body]
            if not hit:
                ok = False
                reasons.append("no any-terms matched")
            else:
                reasons.append("matched: " + ", ".join(hit[:3]))
        elif key in ("subject_any", "subject"):
            hit = [t for t in terms if t in hay_subject]
            if not hit:
                ok = False
                reasons.append("subject did not match")
            else:
                reasons.append("subject matched: " + ", ".join(hit[:2]))
        elif key in ("body_none", "none", "exclude"):
            bad = [t for t in terms if t in hay_body]
            if bad:
                ok = False
                reasons.append("excluded term present: " + ", ".join(bad[:2]))
        else:
            ok = False
            reasons.append("unsupported rule %r" % key)
    return ok, "; ".join(reasons)


def _blockers(proc):
    out = []
    for _, label, test in LIVE_RULE_REQUIREMENTS:
        try:
            if not test(proc):
                out.append(label)
        except Exception:
            out.append(label)
    return out


def _action_gaps(proc):
    out = []
    for _, label, test in ACTION_REQUIREMENTS:
        try:
            if not test(proc):
                out.append(label)
        except Exception:
            out.append(label)
    return out


def collect(hours=24, options=None, fetch_bodies=True, body_cap=60):
    """Build the report data. Read-only."""
    from core.models import AIProcedure, AITicketState

    opts = options or {}
    since = timezone.now() - timezone.timedelta(hours=max(1, int(hours or 24)))
    tickets = list(
        AITicketState.objects.filter(created__gte=since).order_by("-created")
    )
    procs = list(AIProcedure.objects.exclude(status="rejected"))

    bodies, hd_ids = {}, {}
    if fetch_bodies and tickets:
        fetched = _fetch_bodies([t.ticket_ref for t in tickets[:body_cap]])
        for ref, v in fetched.items():
            bodies[ref] = v["text"]
            if v.get("id"):
                hd_ids[ref] = v["id"]

    idf, df = _idf(procs)

    rows = []
    for st in tickets:
        body = bodies.get(st.ticket_ref, "")
        subject = st.subject or ""
        twords = _words(subject + " " + body)

        armed_hit, candidates = None, []
        for p in procs:
            fired, why = _match_hits(p.match, subject, body)
            live = getattr(p, "is_live_rule", False)
            if fired and live and armed_hit is None:
                armed_hit = (p, why)
            elif fired:
                # Rules fire but the procedure is not armed: the blockers are the real
                # reason, and they are what the reader must clear.
                candidates.append((p, why, _blockers(p), _action_gaps(p), "match rules fire",
                               99.0))
            else:
                # Knowledge match: does this procedure clearly cover this ticket even
                # though its machine-readable rules do not fire (or do not exist)?
                # Scored by rarity, not by how many words happen to coincide.
                pw = _words(_proc_text(p))
                title_words = _words(" ".join([p.title or "", p.applies_to or ""]))
                overlap = twords & pw
                subject_words = _words(st.subject or "")
                score = 0.0
                contributors = []
                anchored = False
                for w in overlap:
                    if len(w) < 4:
                        continue
                    weight = idf.get(w, 0.0) * (TITLE_BOOST if w in title_words else 1.0)
                    if weight <= 0:
                        continue
                    score += weight
                    contributors.append((weight, w))
                    if w in subject_words:
                        anchored = True
                contributors.sort(reverse=True)
                strong = [w for _, w in contributors[:4]]
                if anchored and score >= MATCH_SCORE_MIN:
                    # Covered by knowledge, but its rules did NOT fire on this text. That
                    # is itself the blocker, and it has to be said explicitly: an empty
                    # blocker list next to a "blocked" verdict reads like a bug, and on
                    # an already-armed procedure it would imply the engine simply failed.
                    blk = _blockers(p)
                    if isinstance(p.match, dict) and p.match:
                        blk = blk + ["match rules exist but did not fire on this ticket"]
                    else:
                        blk = blk + ["matched on wording only, no rules to fire"]
                    subj_hits = [(wt, w) for wt, w in contributors if w in subject_words]
                    why_txt = ("subject: "
                               + ", ".join("%s (%.1f)" % (w, wt) for wt, w in subj_hits[:2])
                               + (" + body: " + ", ".join(
                                   w for wt, w in contributors if w not in subject_words)[:60]
                                  if len(contributors) > len(subj_hits) else ""))
                    candidates.append((p, why_txt, blk, _action_gaps(p),
                                       "knowledge only", score))
        # Best evidence first: strongest wording match, then fewest blockers, then how
        # often it has actually been seen. Sorting by blocker count alone let a junk match
        # with the same blockers outrank the right procedure.
        candidates.sort(key=lambda c: (-(c[5] if len(c) > 5 else 0.0),
                                       len(c[2]), -(c[0].occurrence_count or 0)))

        if armed_hit:
            verdict, why = "would_auto_work", armed_hit[1]
            best = armed_hit[0]
            blockers, gaps = [], _action_gaps(best)
        elif candidates:
            verdict = "blocked"
            best, why, blockers, gaps = candidates[0][0], candidates[0][1], candidates[0][2], candidates[0][3]
        else:
            verdict, best, why, blockers, gaps = "no_procedure", None, "", [], []

        rows.append({
            "state": st, "ref": st.ticket_ref, "subject": subject,
            "classification": st.classification or "", "status": st.status,
            "verdict": verdict, "why": why, "procedure": best,
            "blockers": blockers, "action_gaps": gaps,
            "alternatives": [c for c in candidates[:4] if c[0] is not best],
            "body_seen": st.ticket_ref in bodies,
        })

    counts = {k: sum(1 for r in rows if r["verdict"] == k)
              for k in ("would_auto_work", "blocked", "no_procedure")}

    # What would buy the most coverage: group blocked tickets by the procedure that
    # would have handled them. This is the actionable half of the report -- it turns
    # "not ready" into a short ordered list of things to fix.
    by_proc = {}
    for r in rows:
        if r["verdict"] == "blocked" and r["procedure"] is not None:
            e = by_proc.setdefault(r["procedure"].pk, {
                "procedure": r["procedure"], "tickets": [],
                "blockers": r["blockers"], "action_gaps": r["action_gaps"]})
            e["tickets"].append(r["ref"])
    leverage = sorted(by_proc.values(), key=lambda e: -len(e["tickets"]))

    return {
        "hours": hours, "generated": timezone.now(), "hd_ids": hd_ids,
        "rows": rows, "counts": counts, "total": len(rows),
        "leverage": leverage,
        "procedure_totals": {
            "all": len(procs),
            "approved": sum(1 for p in procs if p.status == "approved"),
            "armed": sum(1 for p in procs if getattr(p, "is_live_rule", False)),
        },
        "bodies_fetched": len(bodies),
        "body_cap": body_cap,
    }


def _fetch_bodies(refs):
    """Pull ticket text through the bridge so match rules can be evaluated honestly.

    Match rules mostly test the BODY. Judging them on the subject alone would report
    procedures as non-matching when they would in fact fire, which understates readiness
    just as badly as overstating it. Failures are tolerated per ticket: a report that
    renders with gaps beats a report that does not arrive.
    """
    import requests

    from django.conf import settings

    from core.utils import get_core_settings

    core = get_core_settings()
    if not (core.ai_helpdesk_code or "").strip():
        return {}
    bridge = getattr(settings, "PI_BRIDGE_URL", "http://127.0.0.1:8787")
    api = {"base_url": core.ai_helpdesk_api_base_url or "",
           "api_key": core.ai_helpdesk_api_key or ""}
    out = {}
    for ref in refs:
        try:
            r = requests.post(
                f"{bridge}/pi/helpdesk-op",
                json={"operation": "get_ticket", "args": {"ticket": ref},
                      "helpdesk_api": api, "helpdesk_code": core.ai_helpdesk_code or ""},
                timeout=(5, 45),
            ).json()
            tk = ((r.get("result") or {}).get("ticket")) or {}
            parts = [str(tk.get("description") or "")]
            for m in (tk.get("messages") or [])[:6]:
                parts.append(str(m.get("body") or ""))
            text = re.sub(r"<[^>]+>", " ", " ".join(parts))
            out[ref] = {"text": re.sub(r"\s+", " ", text)[:8000],
                        "id": tk.get("id")}
        except Exception:
            continue
    return out


# ---------------------------------------------------------------------------
# Rendering
#
# Interactive means every claim is clickable: the ticket it judged, the procedure it
# would have used, and the KB article that procedure points at. A verdict you cannot
# check is not evidence, and this report exists to be checked rather than believed.
# ---------------------------------------------------------------------------

CYAN, DARK, MUTED, RULE = "#00C4FF", "#1B1319", "#6c757d", "#dee2e6"
OK_BG, WARN_BG, BAD_BG = "#e6f9ef", "#fff6e5", "#fdecea"
OK_FG, WARN_FG, BAD_FG = "#0f7a3d", "#8a5a00", "#a12622"


def _links(core):
    """Base URLs for the three things this report links to."""
    from django.conf import settings

    front = ""
    wl = getattr(settings, "CORS_ORIGIN_WHITELIST", None) or []
    if wl:
        front = wl[0].rstrip("/")
    return {
        "frontend": front,
        # Deep links use ?q=<id>, not ?id=<id>. The procedures page filters on q and the
        # API matches a numeric q against the primary key; ?id= was simply ignored, so the
        # link opened the page listing all 386 procedures. A link that looks like it worked
        # and silently shows everything is worse than no link at all.
        "procedures": f"{front}/ai-procedures" if front else "",
        "helpdesk": (core.ai_helpdesk_api_base_url or "").rstrip("/"),
    }


def _ticket_links(ref, core, base, hd_id=None):
    """Every route to the same ticket, because different people review differently.

    The helpdesk link needs Odoo's RECORD id, not the ticket number: /helpdesk/ticket/59833
    is a guess and it 404s. get_ticket returns the real id (TICKET/59833 is record 44922),
    so the Odoo form URL is built from that and only offered when the id is known.

    Order matters -- the first entry becomes the link on the reference itself, so it must be
    one that is known to resolve rather than one that looks plausible.
    """
    out = []
    if base["helpdesk"] and hd_id:
        out.append(("open ticket",
                    f"{base['helpdesk']}/web#id={hd_id}&model=sh.helpdesk.ticket"
                    f"&view_type=form"))
    from core.models import AIDecisionRequest
    d = AIDecisionRequest.objects.filter(ticket_ref=ref).order_by("-updated").first()
    if d and base["frontend"]:
        out.append(("AI decision chat", f"{base['frontend']}/ai-decision/{d.token}"))
    if base["frontend"]:
        out.append(("ticket console", f"{base['frontend']}/ai-ticket-console/{ref}"))
    return out


def _kb_links(proc, base):
    """KB articles a procedure names.

    Procedures do not yet carry a KB field, so any URL written into the fix or
    verification text is surfaced instead. Stated plainly in the report when there is
    none, rather than leaving a blank the reader has to interpret.
    """
    if proc is None:
        return []
    text = " ".join([proc.fix or "", proc.verification or "", proc.root_cause or ""])
    urls = re.findall(r"https?://[^\s)>\"']+", text)
    seen, out = set(), []
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out[:4]


def _chip(text, bg, fg):
    return (f'<span style="display:inline-block;background:{bg};color:{fg};'
            f'font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;'
            f'margin:0 4px 4px 0;white-space:nowrap">{text}</span>')


def render_html(data, core):
    base = _links(core)
    c, tot = data["counts"], data["total"]
    pt = data["procedure_totals"]

    def pct(n):
        return f"{round(100.0 * n / tot)}%" if tot else "0%"

    o = []
    o.append(f'<div style="background:#F6F5F4;padding:20px 0;font-family:-apple-system,'
             f'Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:{DARK}">')
    o.append('<table width="700" cellspacing="0" cellpadding="0" align="center" '
             f'style="background:#fff;border:1px solid {RULE};border-top:4px solid {CYAN}">')
    o.append(f'<tr><td style="padding:18px 22px 6px 22px">'
             f'<div style="font-size:19px;font-weight:700">AI auto-work readiness</div>'
             f'<div style="font-size:12px;color:{MUTED};margin-top:3px">'
             f'Last {data["hours"]}h &middot; {tot} ticket(s) examined &middot; '
             f'generated {data["generated"].strftime("%Y-%m-%d %H:%M UTC")}</div></td></tr>')

    # headline
    o.append('<tr><td style="padding:12px 22px">')
    o.append('<table width="100%" cellspacing="0" cellpadding="0"><tr>')
    for label, n, bg, fg in (
        ("would auto-work", c["would_auto_work"], OK_BG, OK_FG),
        ("blocked", c["blocked"], WARN_BG, WARN_FG),
        ("no procedure", c["no_procedure"], BAD_BG, BAD_FG),
    ):
        o.append(f'<td width="33%" valign="top" style="padding:0 5px">'
                 f'<table width="100%" cellspacing="0" cellpadding="0" '
                 f'style="background:{bg};border-radius:6px"><tr>'
                 f'<td style="padding:12px 14px">'
                 f'<div style="font-size:22px;font-weight:700;color:{fg}">{n}'
                 f'<span style="font-size:12px;font-weight:400"> &nbsp;{pct(n)}</span></div>'
                 f'<div style="font-size:11px;color:{fg};text-transform:uppercase;'
                 f'letter-spacing:.04em">{label}</div></td></tr></table></td>')
    o.append('</tr></table></td></tr>')

    o.append(f'<tr><td style="padding:2px 22px 10px 22px;font-size:12px;color:{MUTED}">'
             f'Procedures: {pt["all"]} total, {pt["approved"]} approved, '
             f'<b>{pt["armed"]} armed</b> (approved + auto-enabled + condition key + '
             f'disposition + match rules). Bodies fetched for {data["bodies_fetched"]} '
             f'ticket(s); match rules mostly test the body, so any beyond that cap were '
             f'judged on subject alone and are marked.</td></tr>')

    # leverage
    if data["leverage"]:
        o.append(f'<tr><td style="padding:6px 22px 4px 22px">'
                 f'<div style="font-size:14px;font-weight:700">Clear these to gain the most '
                 f'coverage</div></td></tr>')
        o.append('<tr><td style="padding:0 22px 8px 22px">')
        for e in data["leverage"][:6]:
            p = e["procedure"]
            plink = f'{base["procedures"]}?q={p.pk}' if base["procedures"] else ""
            title = (f'<a href="{plink}" style="color:{DARK}">{p.title}</a>' if plink
                     else p.title)
            o.append(f'<div style="border-left:3px solid {CYAN};padding:8px 0 8px 10px;'
                     f'margin-bottom:8px">'
                     f'<div style="font-size:13px;font-weight:600">{title} '
                     f'<span style="color:{MUTED};font-weight:400">#{p.pk} &middot; '
                     f'{len(e["tickets"])} ticket(s) in this window &middot; seen '
                     f'{p.occurrence_count or 0}x all time</span></div>'
                     f'<div style="margin-top:5px">'
                     + "".join(_chip(b, WARN_BG, WARN_FG) for b in e["blockers"])
                     + "".join(_chip(g, BAD_BG, BAD_FG) for g in e["action_gaps"])
                     + f'</div><div style="font-size:11px;color:{MUTED};margin-top:3px">'
                     + ", ".join(e["tickets"][:8]) + '</div></div>')
        o.append('</td></tr>')

    # per ticket
    o.append(f'<tr><td style="padding:10px 22px 4px 22px">'
             f'<div style="font-size:14px;font-weight:700">Every ticket, and the verdict'
             f'</div></td></tr>')
    o.append('<tr><td style="padding:0 22px 16px 22px">')
    for r in data["rows"]:
        badge = {"would_auto_work": _chip("WOULD AUTO-WORK", OK_BG, OK_FG),
                 "blocked": _chip("BLOCKED", WARN_BG, WARN_FG),
                 "no_procedure": _chip("NO PROCEDURE", BAD_BG, BAD_FG)}[r["verdict"]]
        links = _ticket_links(r["ref"], core, base,
                              hd_id=(data.get("hd_ids") or {}).get(r["ref"]))
        tl = " &middot; ".join(
            f'<a href="{u}" style="color:{CYAN};text-decoration:none">{lbl}</a>'
            for lbl, u in links)
        # The reference itself is the thing a reader reaches for first, so it is the
        # link -- not just the small row of captions underneath it.
        primary = links[0][1] if links else ""
        ref_html = (f'<a href="{primary}" style="color:{DARK};text-decoration:underline">'
                    f'{r["ref"]}</a>' if primary else r["ref"])
        o.append(f'<div style="border:1px solid {RULE};border-radius:6px;padding:10px 12px;'
                 f'margin-bottom:8px">')
        o.append(f'<div style="font-size:13px;font-weight:600">{ref_html} '
                 f'<span style="font-weight:400">- {r["subject"][:90]}</span></div>')
        o.append(f'<div style="margin:6px 0 4px 0">{badge}'
                 + _chip(r["classification"] or "unclassified", "#eef1f4", MUTED)
                 + _chip("status: " + r["status"], "#eef1f4", MUTED)
                 + ("" if r["body_seen"] else _chip("subject only", "#eef1f4", MUTED))
                 + '</div>')
        if tl:
            o.append(f'<div style="font-size:11px;margin-bottom:4px">{tl}</div>')
        p = r["procedure"]
        if p is not None:
            plink = f'{base["procedures"]}?q={p.pk}' if base["procedures"] else ""
            ptitle = (f'<a href="{plink}" style="color:{DARK}">{p.title}</a>' if plink
                      else p.title)
            o.append(f'<div style="font-size:12px">Procedure: <b>{ptitle}</b> '
                     f'<span style="color:{MUTED}">#{p.pk} &middot; {p.confidence} '
                     f'confidence &middot; seen {p.occurrence_count or 0}x</span></div>')
            o.append(f'<div style="font-size:11px;color:{MUTED};margin:3px 0">'
                     f'Why it matched: {r["why"]}</div>')
            fix = (p.fix or "").strip().replace("\n", " ")
            if fix:
                o.append(f'<div style="font-size:11px;margin:3px 0"><b>Fix it would '
                         f'apply:</b> {fix[:260]}</div>')
            kb = _kb_links(p, base)
            if kb:
                o.append('<div style="font-size:11px;margin:3px 0"><b>KB:</b> '
                         + " &middot; ".join(f'<a href="{u}" style="color:{CYAN}">{u[:60]}</a>'
                                             for u in kb) + '</div>')
            else:
                o.append(f'<div style="font-size:11px;color:{MUTED};margin:3px 0">'
                         f'KB: none linked on this procedure</div>')
            if r["blockers"] or r["action_gaps"]:
                o.append('<div style="margin-top:5px">'
                         + "".join(_chip("blocked: " + b, WARN_BG, WARN_FG) for b in r["blockers"])
                         + "".join(_chip("needs: " + g, BAD_BG, BAD_FG) for g in r["action_gaps"])
                         + '</div>')
        else:
            o.append(f'<div style="font-size:12px;color:{MUTED}">No procedure covers this '
                     f'yet. If it recurs, mining will propose one; if it is already '
                     f'familiar, write one.</div>')
        if r["alternatives"]:
            o.append(f'<div style="font-size:11px;color:{MUTED};margin-top:4px">Also '
                     f'considered: '
                     + ", ".join(f'#{a[0].pk} {a[0].title[:40]}' for a in r["alternatives"])
                     + '</div>')
        o.append('</div>')
    o.append('</td></tr>')

    o.append(f'<tr><td style="padding:10px 22px 18px 22px;border-top:1px solid {RULE};'
             f'font-size:11px;color:{MUTED}">'
             f'This report changed nothing. "Would auto-work" means the procedure passes '
             f'every check the engine itself applies (AIProcedure.is_live_rule) and its '
             f'match rules fire against this ticket\'s text -- it does not mean it ran. '
             f'A rule this report cannot parse is never counted as a match, so readiness '
             f'is understated rather than overstated.</td></tr>')
    o.append('</table></div>')
    return "".join(o)
