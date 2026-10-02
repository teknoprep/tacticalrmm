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

SCRIPTED AUTOMATION (owner, 2026-10-02) - SUPERSEDES THE "HOW" ABOVE
  The report now proposes Fix-mode subjects with ONE reviewed PowerShell script each, chosen from
  the work technicians actually closed (recurring procedures + closed tickets), written by the
  group's planner. Intake/advise proposals and "Widen:" extensions are no longer produced here.
  Every proposal is checked against every subject in every status. See collect() below.
  Options (report schedule JSON): lookback_days (60), min_occurrences (3), max_proposals (3),
  model_role ("planner"), central_hosts (["m365-admin-w11", "m365-admin"]).

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

PROPOSE_PROMPT = """You are a senior MSP automation engineer. Our technicians close the same
multi-step jobs by hand again and again. Find the ones the helpdesk AI could do END TO END,
unattended, by running ONE reviewed script - and write that script.

You are given:
  (a) RECURRING WORK - procedures mined from tickets our technicians CLOSED (how often, and
      what they actually did to fix it),
  (b) recently closed tickets and new tickets that are not covered yet (real demand),
  (c) the central admin hosts scripts can run on,
  (d) every automation subject that already exists or was decided (approved, proposed,
      rejected or retired). NEVER propose any of those jobs again, under any wording.

WHAT TO PROPOSE - only real work, done by a script:
  * Multi-step technical work a technician did by hand: Microsoft 365 / Exchange / Entra /
    Teams admin (mailbox and calendar permissions, distribution and group membership,
    shared mailboxes, licence assignment, offboarding steps, SharePoint access), AD and file
    share permissions, PBX/VoIP changes through our own apps, device remediation with a
    known fix. Prefer the jobs that recur most and take a technician longest.
  * At least 3 closed tickets or a procedure seen 3+ times must show the job recurs.
  * The script must do the WHOLE job: read the current state, make the change, verify it,
    and print a final line "RESULT: OK - <what changed>" or "RESULT: FAIL - <why>".

WHAT NOT TO PROPOSE (these are too basic or already handled - skip them):
  intake / acknowledgement / "collect the details" subjects, spam or phishing judgement,
  notification or newsletter filtering, anything answered from the ticket text alone, any
  job that already has a subject in (d), anything needing on-site or physical work.

SCRIPT RULES (the script runs unattended on a customer's systems - be strict):
  * PowerShell only. Begin with a param() block; every input is a declared parameter whose
    value the AI reads from the ticket. Never hard-code a user, tenant or path that varies.
  * Input types allowed: email, person (display name or address), choice (give choices),
    int, ticket_ref, text (plain words). Pick the narrowest type.
  * Connect with the method our admin host already uses (certificate-based app auth for
    Microsoft Graph / Exchange Online / Teams on m365-admin-w11). Never put a password, secret
    or key in the script - say in "access" where the credential lives.
  * Idempotent (safe to run twice), additive and reversible. NO deletes, no data removal, no
    password or MFA resets, no disabling accounts unless the job is exactly that and it is
    the documented procedure. Check the target exists before changing it; stop on error.
  * Start with ONE clearly marked block "# --- CONNECT ---" ... "# --- END CONNECT ---" of at
    most 8 lines, using only the standard cmdlets (Connect-MgGraph -ClientId -TenantId
    -CertificateThumbprint; Connect-ExchangeOnline -AppId -Organization -CertificateThumbprint).
    NEVER call a helper function the script does not define itself. Where the per-tenant app id
    and certificate come from is not documented to you: say so in "access" - the reviewer
    confirms that block once.
  * The customer's tenant is NEVER a ticket input. Take a "CustomerDomain" input (type text,
    from the requester's email domain) and resolve the tenant and app connection from it.
  * Identity/access changes are privileged: they are only run after the requester is
    confirmed as an authorised support contact (the system checks this - mention it in risk).
  * Under ~120 lines. No interactive prompts.

OUR STANDING RULES (from our KB - a proposal that breaks one is rejected):
  * Licences: a script may only ASSIGN a licence the tenant already has spare. Buying or adding
    licences (including Teams Phone / MCOEV) is a BlueCloud admin task - stop and hand over.
  * Teams phone numbers, LineURI, voice routing policies and Direct Routing are owned by our
    MS Teams Integration FusionPBX app - never script them.
  * Never delete a user, mailbox, group, file or data. Offboarding blocks and converts; it does
    not delete.

Match rules for recognising the ticket (all optional, case-insensitive; keys are ANDed, a list
inside one key is alternatives): subject_regex, body_regex (string or list), body_any (list),
body_all (list), body_none (list of disqualifiers), sender_regex.

AT MOST {max_props} proposals, best first. If nothing qualifies, return {"proposals": []} -
an empty day is far better than a basic or duplicate proposal.

Return ONLY JSON:
{"proposals": [{
  "name": "short job name",
  "summary": "one sentence: what the AI would do end to end",
  "procedure_ids": [int], "ticket_refs": ["TICKET/123", ...],
  "tickets_per_month": number, "minutes_saved_per_ticket": number,
  "runs_on": "exactly one hostname from CENTRAL ADMIN HOSTS",
  "match": {...},
  "inputs": [{"name": "UserEmail", "type": "email", "choices": [], "from_ticket": "the user named in the request"}],
  "steps": ["what the script does, in order - short lines"],
  "precheck": "what it confirms before changing anything",
  "verify": "how it proves the change worked",
  "rollback": "how to undo it",
  "needs_human_when": "when the AI must stop and hand over",
  "access": "which connection/credential it uses and where that lives (never a value)",
  "risk": "what could go wrong",
  "why": "why the AI can do this alone",
  "reply_guidance": "what the customer reply says when it is done, 1-2 sentences",
  "script": {"name": "kebab-case-name", "what": "one line", "timeout": 300,
             "command": "the full PowerShell script"}
}]}"""

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
        # body_none lists what a subject must NOT handle. Counting those words as "what it
        # recognises" made the one job a subject explicitly excludes look like its duplicate
        # (2026-10-02: distribution-list changes vs the mailbox-access subject, which lists
        # "distribution list" as a disqualifier).
        if key == "body_none":
            continue
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


# ---------------------------------------------------------------------------------------------
# SCRIPTED AUTOMATION PROPOSALS (owner, 2026-10-02): "why is it giving me basic recommendations
# that are also most likely duplicates? I want more complicated tasks that tickets there were
# done can get done solely from the AI with a proper script."
#
# What changed and why:
#   * INPUT. It used to see only the last 24h of tickets that triage had NOT worked, as a subject
#     and a one-line summary - so all it could ever propose was "recognise this kind of request
#     and reply". It now works from what our technicians actually DID: the procedures mined from
#     closed tickets (with their fix steps and how often they recur), recently closed tickets,
#     and the central admin hosts a script can run on.
#   * OUTPUT. Every proposal is a Fix-mode subject carrying ONE reviewed PowerShell script with
#     typed parameters (the bridge validates them before anything runs), a pinned target host,
#     pre-check / verify / rollback. Intake, spam and notification-filter subjects are out.
#   * DUPLICATES. It was checked only against LIVE subjects, so anything proposed-but-pending,
#     disabled or rejected came back the next day; and every day added another "Widen: ..." for
#     the same handful of subjects. Now: every subject in every status is shown to the model AND
#     checked in code (rules, procedures, name/description words), and widening is no longer
#     part of this report.
#   * MODEL. The group's PLANNER (deep reasoning) writes these, not the orchestrator.
# ---------------------------------------------------------------------------------------------
_PARAM_TYPES = {"email", "person", "choice", "int", "ticket_ref", "text"}
# Where a script may run, and what it can reach from there. Scripts take typed inputs, which the
# bridge passes only to PowerShell, so a host must be Windows. Override per schedule with
# options.central_hosts = {"hostname": "what it can reach"}.
_DEFAULT_HOSTS = {
    "m365-admin-w11": ("Windows, PowerShell 7 with Microsoft.Graph, ExchangeOnlineManagement, MicrosoftTeams and "
                       "PnP.PowerShell; certificate-based app auth into each customer's Microsoft 365 tenant "
                       "(see the 'Microsoft 365 Admin Access' KB). Reaches Microsoft 365 / Exchange Online / Entra / "
                       "Teams / SharePoint only - NOT customer LANs, on-prem AD, file servers or the PBXs."),
}


def _words_overlap(a: str, b: str) -> float:
    x, y = _tokens(a), _tokens(b)
    if not x or not y:
        return 0.0
    return len(x & y) / float(min(len(x), len(y)))


def _report_model_fields(core, role: str):
    """The group's `role` member (planner by default) for this report; the orchestrator if the
    group has no such member or its provider has no key; the default model if there is no group."""
    from core.agent_groups import headless_orchestrator_fields, model_fallback_fields
    from core.tasks import _resolve_ai_model

    fields = headless_orchestrator_fields(core, surface="subjects")
    if fields and role and role != "orchestrator":
        group = fields.get("agent_group") or {}
        member = next((m for m in (group.get("roles") or group.get("members") or [])
                       if m.get("role") == role), None)
        key = (fields.get("agent_group_keys") or {}).get((member or {}).get("provider", ""), "")
        if member and key:
            fields = {**fields, "provider": member["provider"], "model_id": member["model_id"],
                      "api_key": key, "thinking_level": member.get("thinking_level") or "high"}
    # A daily, one-call design job: think hard regardless of the role's chat setting
    # (the IT planner runs at "low" because chat drafts must be quick).
    if fields:
        fields = {**fields, "thinking_level": "high"}
    if fields:
        return fields
    model = _resolve_ai_model(None)
    return model_fallback_fields(model) if model else None


def collect(hours=24, options=None) -> dict:
    """Read-only except for creating the `proposed` rows."""
    from agents.models import Agent
    from core.ai_conditions import evaluate_match
    from core.models import AIProcedure, AITicketAutomationSubject, AITicketState
    from core.utils import get_core_settings

    opts = options or {}
    core_settings = get_core_settings()
    now = timezone.now()
    lookback_days = max(7, int(opts.get("lookback_days") or 60))
    min_occ = max(2, int(opts.get("min_occurrences") or 3))
    max_props = max(1, min(5, int(opts.get("max_proposals") or 3)))
    since = now - timezone.timedelta(hours=max(1, int(hours or 24)))

    # Recent demand: new tickets triage understood but no live subject covers.
    tickets = list(
        AITicketState.objects.filter(
            created__gte=since, is_alert=False,
            classification__in=["regular", "unknown"],
            status__in=["triaged", "needs_input"],
        ).order_by("-created")[:120]
    )
    all_subjects = list(AITicketAutomationSubject.objects.all().prefetch_related("procedures").order_by("pk"))
    live = [s for s in all_subjects if s.status == "approved" and s.enabled and s.is_live]
    uncovered = [t for t in tickets if not any(
        evaluate_match(s.match, subject=t.subject or "", body=t.summary or "", sender=t.requester or "")[0]
        for s in live)]

    # What our technicians actually did: recurring procedures from closed tickets that no subject
    # (in ANY status - a rejected job stays rejected) already owns.
    owned_procs = {p.pk for s in all_subjects for p in s.procedures.all()}
    procs = list(
        AIProcedure.objects.exclude(status="retired").filter(
            merged_into__isnull=True, occurrence_count__gte=min_occ,
            last_seen__gte=now - timezone.timedelta(days=lookback_days),
        ).exclude(pk__in=owned_procs).order_by("-occurrence_count")[:40]
    )
    closed = list(
        AITicketState.objects.filter(status="closed", is_alert=False,
                                     updated__gte=now - timezone.timedelta(days=14))
        .exclude(summary="").order_by("-updated")[:80]
    )
    host_caps = opts.get("central_hosts") if isinstance(opts.get("central_hosts"), dict) else _DEFAULT_HOSTS
    hosts = {a.hostname.lower(): a for a in Agent.objects.filter(hostname__in=list(host_caps)).select_related("site__client")
             if a.plat == "windows"}

    result = {
        "hours": hours, "generated": now, "tickets": len(tickets), "uncovered": len(uncovered),
        "live_subjects": len(live), "lookback_days": lookback_days, "procedures_considered": len(procs),
        "closed_considered": len(closed), "proposals": [], "skipped_existing": [], "error": "",
        "model": "",
    }
    if not procs and not uncovered:
        return result

    ai_fields = _report_model_fields(core_settings, str(opts.get("model_role") or "planner"))
    if not ai_fields:
        result["error"] = "no enabled AI model"
        return result
    result["model"] = f"{ai_fields.get('provider')}/{ai_fields.get('model_id')}"

    def clip(s, n):
        s = re.sub(r"\s+", " ", str(s or "")).strip()
        return s if len(s) <= n else s[: n - 1] + "..."

    plines = [
        f"{p.pk} | {p.title} | {p.category or '-'} | seen {p.occurrence_count}x"
        + (f" | last {p.last_seen:%Y-%m-%d}" if p.last_seen else "")
        + (f" | ~{int(p.baseline_minutes)} min" if p.baseline_minutes else "")
        + f"\n     FIX: {clip(p.fix, 600)}\n     VERIFY: {clip(p.verification, 220)}"
        + (f"\n     TICKETS: {', '.join((p.source_ticket_refs or [])[:6])}" if p.source_ticket_refs else "")
        for p in procs
    ]
    hlines = [f"- {a.hostname}: {host_caps.get(a.hostname) or host_caps.get(a.hostname.lower(), '')}" for a in hosts.values()]
    clines = [f"{t.ticket_ref} | {clip(t.subject, 90)} | {clip(t.summary, 200)}" for t in closed]
    ulines = [f"{t.ticket_ref} | {clip(t.subject, 90)} | {clip(t.summary, 200)}" for t in uncovered[:60]]
    slines = [f"{s.pk} | {s.name} | {s.status}{'/on' if s.enabled else '/off'} | mode={s.mode} | {clip(s.description, 160)}"
              for s in all_subjects if s.proposal_kind != "extend"]
    content = (
        "CENTRAL ADMIN HOSTS - a script runs on ONE of these, and can only do what the host can reach. "
        "Do NOT propose a job no listed host can reach (PBX/VoIP, on-prem AD, file shares, customer LANs):\n"
        + ("\n".join(hlines) or "  (none found)")
        + f"\n\nRECURRING WORK - procedures from tickets our technicians closed (last {lookback_days} days, "
          f"seen {min_occ}+ times; id | title | category | seen | last seen):\n" + ("\n".join(plines) or "  (none)")
        + "\n\nRECENTLY CLOSED TICKETS (ref | subject | what happened):\n" + ("\n".join(clines) or "  (none)")
        + "\n\nNEW TICKETS NOT COVERED YET (ref | subject | summary):\n" + ("\n".join(ulines) or "  (none)")
        + "\n\nSUBJECTS THAT ALREADY EXIST OR WERE DECIDED - never propose these jobs again:\n"
        + ("\n".join(slines) or "  (none)")
    )
    bridge = getattr(settings, "PI_BRIDGE_URL", "http://127.0.0.1:8787")
    try:
        r = requests.post(
            f"{bridge}/pi/analyze",
            json={**ai_fields,
                  "system_prompt": PROPOSE_PROMPT.replace("{max_props}", str(max_props)), "content": content,
                  "purpose": "report:automation_subjects", "username": "report"},
            timeout=(10, 600),
        )
        out = r.json()
    except Exception as e:
        out = {"error": str(e)}
    if out.get("error"):
        result["error"] = str(out["error"])[:300]
        return result
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", (out.get("text") or "").strip(), flags=re.I | re.M)
    try:
        data = json.loads(text)
    except Exception:
        m = re.search(r"\{[\s\S]*\}", text)
        try:
            data = json.loads(m.group(0)) if m else {}
        except Exception:
            data = {}
    raw_list = data.get("proposals") or data.get("subjects") or []

    proc_by_id = {p.pk: p for p in procs}
    taken_names: set = set()
    for raw in raw_list[:max_props]:
        name = clip(raw.get("name"), 160)
        match = raw.get("match") if isinstance(raw.get("match"), dict) else {}
        script = raw.get("script") if isinstance(raw.get("script"), dict) else {}
        command = str(script.get("command") or "").strip()
        summary = clip(raw.get("summary"), 400)
        skip = lambda why: result["skipped_existing"].append({"name": name or "(unnamed)", "status": why})  # noqa: E731
        if not name or not match or len(command) < 60:
            skip("incomplete - no recognition rules or no real script")
            continue
        if name.lower() in taken_names:
            continue
        # ---- THE SAME JOB AS ANYTHING THAT EXISTS, IN ANY STATUS? (checked in code, not trusted)
        pids = [int(x) for x in (raw.get("procedure_ids") or []) if str(x).isdigit()]
        dup = next((s for s in all_subjects if s.name.strip().lower() == name.lower()), None)
        dup = dup or nearest_subject({"match": match, "procedure_ids": pids},
                                     [s for s in all_subjects if s.proposal_kind != "extend"], threshold=0.7)
        dup = dup or next((s for s in all_subjects if s.proposal_kind != "extend" and
                           _words_overlap(f"{name} {summary}", f"{s.name} {s.description}") >= 0.6), None)
        if dup is not None:
            skip(f"same job as '{dup.name}' [{dup.status}]")
            continue
        if pids and set(pids) & owned_procs:
            skip("its procedure already belongs to a subject")
            continue
        # ---- EVIDENCE: the job must actually recur
        refs = [str(x) for x in (raw.get("ticket_refs") or []) if re.match(r"^TICKET/\d+$", str(x))][:30]
        seen = max([proc_by_id[i].occurrence_count for i in pids if i in proc_by_id] or [0])
        if len(refs) < 3 and seen < 3:
            skip("not enough evidence that it recurs")
            continue
        # ---- THE REVIEWED ACTION, in the exact shape the bridge executes
        params = []
        for p in raw.get("inputs") or []:
            pname, ptype = str(p.get("name") or ""), str(p.get("type") or "")
            if not re.match(r"^[A-Za-z][A-Za-z0-9]{0,39}$", pname) or ptype not in _PARAM_TYPES:
                continue
            decl = {"name": pname, "type": ptype}
            if ptype == "choice":
                decl["choices"] = [str(c) for c in (p.get("choices") or []) if str(c)][:20]
                if not decl["choices"]:
                    continue
            params.append(decl)
        slug = re.sub(r"[^a-z0-9]+", "-", str(script.get("name") or name).lower()).strip("-")[:60] or "run"
        action = {"name": slug, "what": clip(script.get("what") or summary, 200), "shell": "powershell",
                  "command": command, "timeout": max(60, min(900, int(script.get("timeout") or 300))),
                  "params": params}
        runs_on = str(raw.get("runs_on") or "").strip()
        agent = hosts.get(runs_on.lower())
        if agent is None:
            skip(f"no listed host can run it (runs_on '{runs_on or '-'}')")
            continue
        fix_target = {"agent_id": agent.agent_id, "hostname": agent.hostname} if agent else {}
        steps = [clip(x, 200) for x in (raw.get("steps") or []) if str(x).strip()][:10]
        desc = "\n".join(filter(None, [
            summary,
            ("Steps:\n" + "\n".join(f"{i}. {s}" for i, s in enumerate(steps, 1))) if steps else "",
            f"Pre-check: {clip(raw.get('precheck'), 300)}" if raw.get("precheck") else "",
            f"Verify: {clip(raw.get('verify'), 300)}" if raw.get("verify") else "",
            f"Rollback: {clip(raw.get('rollback'), 300)}" if raw.get("rollback") else "",
            f"Hand to a human when: {clip(raw.get('needs_human_when'), 300)}" if raw.get("needs_human_when") else "",
            f"Access: {clip(raw.get('access'), 300)}" if raw.get("access") else "",
        ]))
        try:
            minutes = float(raw.get("minutes_saved_per_ticket") or 0) or None
        except (TypeError, ValueError):
            minutes = None
        subj = AITicketAutomationSubject.objects.create(
            name=name, description=desc[:4000], status="proposed", enabled=False, mode="device_fix",
            match=match, instructions=clip(raw.get("reply_guidance"), 1000), all_clients=True,
            fix_actions=[action], fix_target=fix_target, baseline_minutes=minutes,
            approve_token=get_random_string(40), reject_token=get_random_string(40),
            proposed_by_report=now, proposal_tickets=refs,
            proposal_reason=(clip(raw.get("why"), 1500) + ("\n\nRisk: " + clip(raw.get("risk"), 1500) if raw.get("risk") else ""))[:4000],
        )
        if pids:
            subj.procedures.set(AIProcedure.objects.filter(pk__in=pids))
        taken_names.add(name.lower())
        owned_procs |= set(pids)
        result["proposals"].append({
            "subject": subj, "target": None, "tickets": refs, "summary": summary, "steps": steps,
            "why": clip(raw.get("why"), 600), "risk": clip(raw.get("risk"), 600),
            "precheck": clip(raw.get("precheck"), 300), "verify": clip(raw.get("verify"), 300),
            "rollback": clip(raw.get("rollback"), 300), "needs_human": clip(raw.get("needs_human_when"), 300),
            "access": clip(raw.get("access"), 300), "runs_on": agent.hostname if agent else (runs_on or "not set"),
            "pinned": bool(agent), "inputs": params, "seen": max(seen, len(refs)),
            "per_month": raw.get("tickets_per_month"), "minutes": minutes, "action": action,
            "procedures": list(subj.procedures.values_list("title", flat=True)),
            "approve_url": _decide_url(subj.approve_token, "approve"),
            "reject_url": _decide_url(subj.reject_token, "reject"),
        })
    return result


def render_html(data: dict, core) -> str:
    """One clean card per proposal: what it does, the evidence, the script, two buttons.
    Same type sizes everywhere, no raw JSON, long text kept short (the full detail is on the
    approval page and in the console)."""
    e = escape
    base = _links(core)
    console = (base.get("frontend") or "").rstrip("/")
    font = "font-family:Segoe UI,Arial,Helvetica,sans-serif"
    ink, muted, line = "#1f2937", "#6b7280", "#e5e7eb"

    def row(label, value):
        if not value:
            return ""
        return (f"<tr><td style='padding:5px 12px 5px 0;color:{muted};font-size:13px;white-space:nowrap;"
                f"vertical-align:top;width:120px'>{e(label)}</td>"
                f"<td style='padding:5px 0;font-size:13px;color:{ink}'>{value}</td></tr>")

    def button(href, label, bg, fg="#ffffff", border=None):
        b = border or bg
        return (f"<a href='{e(href)}' style='display:inline-block;background:{bg};color:{fg};border:1px solid {b};"
                f"padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px;"
                f"margin:0 8px 0 0'>{e(label)}</a>")

    n = len(data["proposals"])
    parts = [
        f"<div style='{font};color:{ink};max-width:760px;font-size:14px;line-height:1.5'>",
        "<div style='font-size:20px;font-weight:700;margin:0 0 4px'>Automation proposals</div>",
        f"<div style='color:{muted};font-size:13px;margin:0 0 18px'>"
        f"{n} job{'s' if n != 1 else ''} the AI could do end to end with a reviewed script, chosen from "
        f"{data.get('procedures_considered', 0)} recurring procedures and {data.get('closed_considered', 0)} "
        f"closed tickets (last {data.get('lookback_days', 60)} days)."
        + (f" Written by {e(data['model'])}." if data.get("model") else "") + "</div>",
    ]
    if data.get("error"):
        parts.append(f"<div style='background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:10px 14px;"
                     f"font-size:13px;margin:0 0 16px'>Proposals unavailable: {e(data['error'])}</div>")
    if not n and not data.get("error"):
        parts.append(f"<div style='background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:10px 14px;"
                     f"font-size:13px'>Nothing worth proposing today.</div>")

    for i, p in enumerate(data["proposals"], 1):
        s = p["subject"]
        act = p.get("action") or {}
        lines = str(act.get("command") or "").splitlines()
        shown = "\n".join(lines[:40]) + (f"\n... {len(lines) - 40} more lines on the approval page" if len(lines) > 40 else "")
        evidence = f"{p['seen']} times" + (f" &middot; about {e(str(p['per_month']))} a month" if p.get("per_month") else "")
        saves = f"about {int(p['minutes'])} min of technician time each" if p.get("minutes") else ""
        runs = e(p["runs_on"]) + ("" if p.get("pinned") else
                                   " <span style='color:#b45309'>(not pinned &mdash; choose a device in Review before it can run)</span>")
        inputs = ", ".join(f"<code style='font-size:12px'>{e(x['name'])}</code> ({e(x['type'])})" for x in p.get("inputs") or [])
        steps = "".join(f"<li style='margin:0 0 3px'>{e(x)}</li>" for x in p.get("steps") or [])
        review = f"{console}/ai-procedures?tab=subjects&subject={s.pk}" if console else ""
        tix = ", ".join(e(t) for t in p["tickets"][:6]) + (f" +{len(p['tickets']) - 6} more" if len(p["tickets"]) > 6 else "")
        parts.append(
            f"<div style='border:1px solid {line};border-radius:8px;padding:16px 18px;margin:0 0 18px;background:#ffffff'>"
            f"<div style='font-size:12px;color:{muted};margin:0 0 2px'>Proposal {i} of {n}</div>"
            f"<div style='font-size:17px;font-weight:700;margin:0 0 6px'>{e(s.name)}</div>"
            f"<div style='font-size:14px;margin:0 0 12px'>{e(p.get('summary') or '')}</div>"
            f"<table style='border-collapse:collapse;margin:0 0 10px'>"
            + row("Seen", evidence) + row("Saves", saves) + row("Runs on", runs) + row("Reads from ticket", inputs)
            + row("Example tickets", tix) + row("Hands to a human", e(p.get("needs_human") or ""))
            + row("Risk", e(p.get("risk") or "")) +
            "</table>"
            + (f"<div style='font-size:13px;font-weight:600;margin:6px 0 4px'>What it does</div>"
               f"<ol style='margin:0 0 10px 18px;padding:0;font-size:13px'>{steps}</ol>" if steps else "")
            + "<table style='border-collapse:collapse;margin:0 0 10px'>"
            + row("Checks first", e(p.get("precheck") or "")) + row("Proves it worked", e(p.get("verify") or ""))
            + row("Undo", e(p.get("rollback") or "")) + row("Access", e(p.get("access") or "")) +
            "</table>"
            f"<div style='font-size:13px;font-weight:600;margin:6px 0 4px'>Script <span style='font-weight:400;color:{muted}'>"
            f"({e(act.get('name') or '')}, PowerShell)</span></div>"
            f"<pre style='background:#f6f8fa;border:1px solid {line};border-radius:6px;padding:10px 12px;margin:0 0 14px;"
            f"font-family:Consolas,Menlo,monospace;font-size:12px;line-height:1.45;color:#24292f;white-space:pre-wrap;"
            f"word-break:break-word'>{e(shown)}</pre>"
            "<div>" + button(p["approve_url"], "Review script & approve", "#166534")
            + button(p["reject_url"], "Reject", "#ffffff", fg="#991b1b", border="#fca5a5")
            + (button(review, "Edit in console", "#ffffff", fg=ink, border="#d1d5db") if review else "") + "</div>"
            f"</div>"
        )

    footer = []
    if data.get("skipped_existing"):
        footer.append(f"{len(data['skipped_existing'])} idea(s) dropped as duplicates or too thin: "
                      + "; ".join(f"{e(x['name'])} ({e(x['status'])})" for x in data["skipped_existing"][:6]))
    footer.append("Before approving, check the script's CONNECT block - the report does not know your per-tenant "
                  "app id and certificate, so that is the one part a technician must confirm.")
    footer.append("Nothing runs until you approve. Approved scripts run only on the pinned device, only with "
                  "values that pass their input types, and every run is still judged before it executes.")
    if base.get("procedures"):
        footer.append(f"<a href='{e(base['procedures'])}' style='color:#1d4ed8'>Procedures &amp; subjects</a>")
    parts.append(f"<div style='color:{muted};font-size:12px;line-height:1.6;border-top:1px solid {line};"
                 f"padding-top:10px'>" + "<br>".join(footer) + "</div></div>")
    return "".join(parts)
