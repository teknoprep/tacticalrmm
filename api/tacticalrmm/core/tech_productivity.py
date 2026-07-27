"""Technician Productivity Analysis - the coaching report.

WHY THIS EXISTS. The activity report answers "what happened on the desk". It does not answer
"how is Sean doing, and what should I say to him on Monday". That is a different question, and
it needs three things the activity report does not have:

  1. PHONE TIME. A technician's day is not only tickets. Talk time lives in the PBX and nowhere
     else, so this module reads FusionPBX CDRs and folds them in. Without it, the tech who
     spends five hours a day on the phone reads as the laziest person on the desk.
  2. COMPLEXITY, ON A 1-5 SCALE. Closing forty backup-success alerts is not the same day's work
     as rebuilding a domain controller. Counting tickets without weighting them rewards the
     wrong behaviour, so every ticket is rated 1-5 and the ratings are shown, not hidden.
  3. WHERE THE TIME DID NOT LAND. Days with open tickets and no recorded activity anywhere -
     no ticket message, no call, no AI chat, no RMM session. Deliberately named "unaccounted",
     never "idle": off-system work is real work, and the report's job is to start the
     conversation, not to deliver the verdict.

EVERY SCALE IN THIS FILE IS 1-5 (owner's ruling), where 5 is best - except complexity, where 5
means hardest, not best. Each score is reported twice, because the owner asked for both: an
ABSOLUTE score against fixed thresholds (is this good work, full stop) and a RELATIVE score
against this desk's own median (is this good work here, this week). A small team can be
uniformly excellent or uniformly slipping, and only one of those two views notices.

ATTRIBUTION IS THE HARD PART, AND IT IS NOT GUESSWORK - it was derived by reading the CDRs:

  * OUTBOUND: `caller_id_number` is the shared company DID (14843351444) for everyone, so it
    identifies nobody. `caller_id_name` carries the technician's name ("Cosmus Melly"), so
    outbound is attributed by NAME.
  * INBOUND ANSWERED: the answered leg has `direction IS NULL`, `last_app='intercept'` and an
    internal destination like `9201214`. That is NOT `920`+extension: the trailing three digits
    are the extension (214), so the destination is resolved by matching its last three digits
    against the extensions that actually exist on the domain, and ignored if none match.
    Attributed by EXTENSION.
  * DUPLICATE ANSWERED LEGS. A queue-recorded call is written twice - once as `last_app='bridge'`
    with the caller ID prefixed `TQ-`, once as `last_app='intercept'` - with different
    `bridge_uuid`s, so no UUID column collapses them. They are deduplicated on
    (extension, start_epoch, billsec), which is exact: the same person cannot answer two calls
    of identical length in the same second. Left in, this inflated talk time by ~28%.
  * INBOUND UNANSWERED IS NOT A PERSONAL MISS. Inbound rings every extension at once (a ring
    group): one answer, and everyone else gets a row with `billsec=0` and `LOSE_RACE` or
    `ORIGINATOR_CANCEL`. Charging those to individuals would invent a dozen "missed calls" per
    real call for every tech who was simply not the fastest to the handset. They are counted
    once, for the TEAM.
  * Internal extension-to-extension calls are excluded entirely (owner's ruling).
  * Only rows with `billsec>0` are used for talk time, which the data shows is one row per
    real call - so talk time cannot double-count a transferred call.

READ-ONLY, AND NO NEW CREDENTIALS. Option A per the owner: the query runs as a read-only SELECT
through the existing TRMM agent on the database host. Nothing is installed, no PostgreSQL user
is created, no password is stored in this deployment.
"""

from __future__ import annotations

import asyncio
import json
import re
import statistics
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

# The database host that carries the FusionPBX cluster's CDRs, as a TRMM agent hostname.
CDR_AGENT_HOSTNAME = "ip-10-254-12-161"
CDR_DATABASE = "fusionpbx"
# BlueCloud's own PBX domain. Technicians never place client calls from anywhere else
# (owner's ruling), so anything outside this domain is a customer's own phone system.
STAFF_DOMAIN = "pbx.blueuc.com"
# Internal dial prefix: extension 213 is reached as 9201213.
EXT_PREFIX = "920"


# --------------------------------------------------------------------------------------
# CDR collection (read-only, through the RMM agent on the database host)
# --------------------------------------------------------------------------------------

def _psql(agent, sql: str, timeout: int = 90) -> Tuple[bool, str]:
    """Run one read-only SELECT on the CDR database and return raw pipe-delimited rows.

    The statement is wrapped so a syntax error or a permissions problem comes back as text
    instead of an exception - a phone-system hiccup must degrade this report, never kill it.
    """
    safe = sql.replace('"', '\\"')
    cmd = f'sudo -n -u postgres psql -d {CDR_DATABASE} -tAF"|" -c "{safe}" 2>&1'
    try:
        out = asyncio.run(agent.nats_cmd(
            {"func": "rawcmd", "timeout": timeout,
             "payload": {"command": cmd, "shell": "/bin/bash"}},
            timeout=timeout + 20,
        ))
    except Exception as e:
        return False, f"agent call failed: {e}"
    if not isinstance(out, str):
        return False, f"unexpected agent response: {str(out)[:200]}"
    if re.search(r"^(psql:|ERROR:|FATAL:)", out.strip(), re.M):
        return False, out.strip()[:400]
    return True, out


def _rows(raw: str) -> List[List[str]]:
    out = []
    for line in (raw or "").splitlines():
        line = line.strip()
        if not line:
            continue
        out.append(line.split("|"))
    return out


def fetch_extensions(agent) -> Tuple[Dict[str, str], str]:
    """{extension: display name} for the staff PBX domain."""
    ok, raw = _psql(agent, (
        "select e.extension, coalesce(nullif(e.effective_caller_id_name,''), e.extension) "
        "from v_extensions e join v_domains d on d.domain_uuid=e.domain_uuid "
        f"where d.domain_name='{STAFF_DOMAIN}' order by e.extension"
    ))
    if not ok:
        return {}, raw
    return {r[0]: (r[1] if len(r) > 1 else r[0]) for r in _rows(raw) if r and r[0]}, ""


def _resolve_ext(dest: str, extensions: Dict[str, str]) -> Optional[str]:
    """'9201214' -> '214'. Only returns an extension that exists on the domain.

    The internal dial string is not a fixed prefix plus the extension, so it is not parsed
    arithmetically - the trailing digits are tested against reality. A destination we cannot tie
    to a real extension is dropped rather than credited to whoever looks closest.
    """
    d = re.sub(r"\D", "", dest or "")
    if not d:
        return None
    if d in extensions:
        return d
    for n in (3, 4, 2):
        if len(d) >= n and d[-n:] in extensions:
            return d[-n:]
    return None


def fetch_calls(agent, hours: int, extensions: Dict[str, str]) -> Tuple[Dict[str, Any], str]:
    """Per-call facts for the window, already filtered to real external calls.

    Returns {"answered_in": [...], "outbound": [...], "team_unanswered": n, "per_day": {...}}.
    Aggregation is left to Python so the same rows can feed several metrics (per-day activity,
    longest call, talk time) without querying three times.
    """
    hours = max(1, int(hours or 24))
    window = f"now() - interval '{hours} hours'"

    # Answered inbound: the intercepted leg, carrying real talk time, addressed to 920<ext>.
    ok, raw = _psql(agent, (
        "select c.destination_number, c.billsec, c.start_stamp, coalesce(c.caller_id_name,''), "
        "coalesce(c.caller_id_number,''), coalesce(c.waitsec,0), coalesce(c.hold_accum_seconds,0), "
        "c.start_epoch, coalesce(c.last_app,'') "
        "from v_xml_cdr c join v_domains d on d.domain_uuid=c.domain_uuid "
        f"where d.domain_name='{STAFF_DOMAIN}' and c.start_stamp > {window} "
        "and c.billsec > 0 and coalesce(c.direction,'') <> 'outbound' "
        "and coalesce(c.direction,'') <> 'local' "
        f"and c.destination_number ~ '^[0-9]{{3,7}}$' "
        "order by c.start_stamp"
    ))
    if not ok:
        return {}, raw
    answered_in, seen, dropped_dest, dup_in = [], {}, 0, 0
    for r in _rows(raw):
        if len(r) < 9:
            continue
        ext = _resolve_ext(r[0], extensions)
        if not ext:
            dropped_dest += 1
            continue
        billsec = int(float(r[1] or 0))
        key = (ext, r[7], billsec)          # extension, start_epoch, duration
        name = re.sub(r"^TQ-", "", r[3])    # queue-recorded copy of the same conversation
        rec = {"ext": ext, "billsec": billsec, "at": r[2], "peer_name": name,
               "peer_number": r[4], "waitsec": int(float(r[5] or 0)),
               "hold": int(float(r[6] or 0)), "last_app": r[8]}
        if key in seen:
            dup_in += 1
            # Prefer the intercepted leg: it is the one that represents the answered call.
            if rec["last_app"] == "intercept" and seen[key]["last_app"] != "intercept":
                seen[key].update(rec)
            continue
        seen[key] = rec
        answered_in.append(rec)

    # Outbound: attributed by caller_id_name, because every tech shares one outbound DID.
    ok, raw = _psql(agent, (
        "select coalesce(c.caller_id_name,''), c.billsec, c.start_stamp, "
        "coalesce(c.destination_number,''), (c.answer_stamp is null), c.start_epoch "
        "from v_xml_cdr c join v_domains d on d.domain_uuid=c.domain_uuid "
        f"where d.domain_name='{STAFF_DOMAIN}' and c.start_stamp > {window} "
        "and c.direction = 'outbound' order by c.start_stamp"
    ))
    if not ok:
        return {}, raw
    outbound, seen_out, dup_out = [], set(), 0
    for r in _rows(raw):
        if len(r) < 6:
            continue
        name = re.sub(r"^TQ-", "", r[0])
        billsec = int(float(r[1] or 0))
        key = (name, r[5], billsec, r[3])
        if key in seen_out:
            dup_out += 1
            continue
        seen_out.add(key)
        outbound.append({"name": name, "billsec": billsec, "at": r[2],
                         "dest": r[3], "unanswered": (r[4] == "t")})

    # Calls nobody picked up, counted ONCE for the team (see module docstring).
    ok, raw = _psql(agent, (
        "select count(distinct coalesce(nullif(c.sip_call_id,''), c.xml_cdr_uuid::text)) "
        "from v_xml_cdr c join v_domains d on d.domain_uuid=c.domain_uuid "
        f"where d.domain_name='{STAFF_DOMAIN}' and c.start_stamp > {window} "
        "and c.billsec = 0 and coalesce(c.direction,'') not in ('outbound','local') "
        f"and c.destination_number ~ '^[0-9]{{3,7}}$'"
    ))
    team_unanswered_legs = 0
    if ok:
        rr = _rows(raw)
        if rr and rr[0] and rr[0][0].isdigit():
            team_unanswered_legs = int(rr[0][0])

    return {"answered_in": answered_in, "outbound": outbound,
            "team_unanswered": team_unanswered_legs,
            "dedup_dropped": dup_in + dup_out,
            "unresolved_destinations": dropped_dest}, ""


def collect_phone(hours: int) -> Dict[str, Any]:
    """Everything the PBX can tell us for the window, or a reason why it cannot."""
    from agents.models import Agent

    agent = Agent.objects.filter(hostname=CDR_AGENT_HOSTNAME).first()
    if not agent:
        return {"ok": False, "error": f"CDR host agent '{CDR_AGENT_HOSTNAME}' not found in RMM"}
    if agent.status != "online":
        return {"ok": False, "error": f"CDR host agent is {agent.status}"}
    exts, err = fetch_extensions(agent)
    if err:
        return {"ok": False, "error": f"extension lookup failed: {err[:200]}"}
    calls, err = fetch_calls(agent, hours, exts)
    if err:
        return {"ok": False, "error": f"CDR query failed: {err[:200]}"}
    calls["extensions"] = exts
    calls["ok"] = True
    return calls


# --------------------------------------------------------------------------------------
# Matching helpdesk technicians to PBX identities
# --------------------------------------------------------------------------------------

_STOP = {"jr", "sr", "ii", "iii", "the", "tech", "support", "bluecloud", "llc", "iaas"}


def _tokens(name: str) -> List[str]:
    parts = re.split(r"[^a-z0-9]+", (name or "").lower())
    return [p for p in parts if p and p not in _STOP and not p.isdigit()]


def name_match_score(a: str, b: str) -> float:
    """How confident are we that two names are the same person? 0.0-1.0.

    Names are kept "the same or VERY SIMILAR" between the helpdesk and the PBX (owner), so this
    only has to survive "Fred Ortiz" vs "Fred" and "Dan B" vs "Dan Bartlett" - not arbitrary
    aliases. Anything below the threshold is reported as unmatched rather than guessed, because
    silently crediting one tech's phone calls to another is worse than admitting we do not know.
    """
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    if ta == tb:
        return 1.0
    sa, sb = set(ta), set(tb)
    if sa & sb:
        # First names agree and one side is only a first name (or an initialled surname).
        if ta[0] == tb[0]:
            if len(ta) == 1 or len(tb) == 1:
                return 0.9
            short, long_ = sorted([ta[-1], tb[-1]], key=len)
            if long_.startswith(short):        # "Dan B" vs "Dan Bartlett"
                return 0.85
            return 0.55                        # same first name, different surname: ambiguous
        # Surname agrees and the first names are nickname-shaped: "Fred Ortiz" vs "Freddie
        # Ortiz" is one person, and the PBX genuinely spells him both ways.
        if len(ta) > 1 and len(tb) > 1 and ta[-1] == tb[-1]:
            fa, fb = ta[0], tb[0]
            short, long_ = sorted([fa, fb], key=len)
            if len(short) >= 3 and long_.startswith(short):
                return 0.9
        return 0.5
    # No shared token, but a first-name-only PBX label against a full helpdesk name:
    # "Freddie" (ext 211) vs "Fred Ortiz".
    if len(ta) == 1 or len(tb) == 1:
        one = ta[0] if len(ta) == 1 else tb[0]
        other_first = tb[0] if len(ta) == 1 else ta[0]
        short, long_ = sorted([one, other_first], key=len)
        if len(short) >= 3 and long_.startswith(short):
            return 0.82
    return 0.0


def match_pbx(tech_names: List[str], extensions: Dict[str, str],
              overrides: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Map each helpdesk technician to a PBX extension and caller-ID name.

    `overrides` ({"Fred Ortiz": "211"}) always wins, so a name the matcher cannot resolve can be
    pinned by an operator without a code change.
    """
    overrides = {k.strip().lower(): str(v).strip() for k, v in (overrides or {}).items()}
    out, unmatched, ambiguous = {}, [], []
    for tech in tech_names:
        pin = overrides.get(tech.strip().lower())
        if pin and pin in extensions:
            out[tech] = {"ext": pin, "cid_name": extensions[pin], "how": "operator override",
                         "confidence": 1.0}
            continue
        scored = sorted(
            ((name_match_score(tech, disp), ext, disp) for ext, disp in extensions.items()),
            key=lambda x: (-x[0], x[1]),
        )
        best = scored[0] if scored else (0.0, None, None)
        if best[0] >= 0.8:
            runner = scored[1][0] if len(scored) > 1 else 0.0
            if runner >= 0.8 and abs(runner - best[0]) < 0.06:
                ambiguous.append(tech)
                continue
            out[tech] = {"ext": best[1], "cid_name": best[2],
                         "how": "exact name" if best[0] >= 1.0 else "name similarity",
                         "confidence": round(best[0], 2)}
        else:
            unmatched.append(tech)
    return {"map": out, "unmatched": unmatched, "ambiguous": ambiguous}


# --------------------------------------------------------------------------------------
# Complexity, 1-5
# --------------------------------------------------------------------------------------

# Owner's ruling: "figuring out hack attempts and creating new servers is high up".
COMPLEXITY_RULES: List[Tuple[int, str, str]] = [
    (5, "security incident", r"\b(hack|hacked|hacking|breach|compromis|intrusion|ransomware|"
                             r"crypto ?lock|malware|trojan|rootkit|exfiltrat|brute ?force|"
                             r"unauthorized access|unauthorised access|security incident|"
                             r"fraud|spoof|impersonat|bec\b|account takeover|data ?loss)"),
    (5, "server build / infrastructure", r"\b(new server|build (a )?server|provision|"
                                         r"domain controller|hyper-?v|esxi|vmware|proxmox|"
                                         r"virtual machine|vm build|migrat|cutover|"
                                         r"forest|new site|new tenant|failover|cluster|"
                                         r"raid|san\b|hypervisor|datacenter|data centre)"),
    (4, "network / firewall / VPN", r"\b(firewall|fortigate|sonicwall|meraki|pfsense|vlan|"
                                    r"subnet|routing|route|bgp|ospf|vpn|ipsec|site-?to-?site|"
                                    r"switch stack|dhcp scope|dns zone|wan|isp outage|"
                                    r"packet loss|latency|certificate|ssl|tls)"),
    (4, "identity / directory / tenant", r"\b(active directory|azure ad|entra|group policy|gpo|"
                                         r"sso|saml|oauth|mfa|conditional access|"
                                         r"tenant|licen[cs]e|exchange online|mailbox migration|"
                                         r"offboard|onboard)"),
    (4, "backup / restore / recovery", r"\b(restore|recover|corrupt|data loss|veeam|"
                                       r"backup fail|replication|bare ?metal|disaster)"),
    (3, "VoIP / telephony", r"\b(voip|pbx|sip|extension|ivr|voicemail|did\b|call quality|"
                            r"one-?way audio|dial ?plan|ring group|fax)"),
    (3, "application / device fix", r"\b(install|reinstall|upgrade|update|driver|printer|"
                                    r"scanner|mapped drive|share|permission|outlook|office|"
                                    r"quickbooks|sage|adobe|crash|slow|freez|blue ?screen|"
                                    r"bsod|profile|sync)"),
    (2, "account / access request", r"\b(password|reset|unlock|locked out|new user|"
                                    r"distribution list|signature|forward|alias|"
                                    r"add user|remove user|access to)"),
    (2, "how-to / question", r"\b(how do i|how to|question|request|please add|can you|"
                             r"training|walk ?through)"),
]


def complexity_1_5(ticket: Dict[str, Any]) -> Dict[str, Any]:
    """Rate one ticket 1-5 for difficulty, from evidence plus subject matter.

    Two independent readings, and the HIGHER wins: subject matter (a breach is hard even if it
    was solved in one message by someone who has seen it before) and effort signals (a printer
    that took nine messages, three people and two days was, in fact, hard). Taking the maximum
    is deliberate - taking an average would flatten both signals into a permanent 3.
    """
    subj = f'{ticket.get("subject") or ""} {(ticket.get("body") or "")[:400]}'.lower()
    events = ticket.get("events") or []
    reasons: List[str] = []

    topic, topic_label = 1, ""
    for level, label, pattern in COMPLEXITY_RULES:
        if re.search(pattern, subj):
            if level > topic:
                topic, topic_label = level, label
            break
    if topic_label:
        reasons.append(topic_label)

    cls = ticket.get("class") or ""
    if cls == "alert_clean":
        topic = min(topic, 1)
        reasons = ["automated alert, nothing wrong"]
    elif cls == "alert_actionable" and topic <= 2:
        topic = max(topic, 2)

    msgs = len(events)
    staff_msgs = sum(1 for e in events if e.get("kind") == "staff")
    participants = len({e.get("actor") for e in events})
    span_h = 0.0
    times = sorted([t for t in (_parse(e.get("at")) for e in events) if t])
    if len(times) >= 2:
        span_h = (times[-1] - times[0]).total_seconds() / 3600.0

    # Calibrated against this desk's real distribution. The first cut made 4 the most common
    # rating on the desk, which is useless: if most work is "hard", the word has stopped
    # meaning anything. Participant counts in particular are weak evidence - the customer, the
    # bot and two techs on a thread is four "participants" and often a trivial ticket - so they
    # no longer promote a ticket on their own.
    effort = 1
    if msgs >= 4 or staff_msgs >= 2:
        effort = 2
    if msgs >= 8 or (msgs >= 6 and participants >= 4):
        effort = 3
    if msgs >= 16 or (msgs >= 12 and participants >= 5) or span_h >= 120:
        effort = 4
    if msgs >= 28 or (msgs >= 20 and span_h >= 168):
        effort = 5
    if effort >= 3:
        reasons.append(f"{msgs} messages, {participants} people"
                       + (f", {round(span_h / 24, 1)}d elapsed" if span_h >= 24 else ""))

    score = max(topic, effort)
    if ticket.get("reopened"):
        score = min(5, score + 1)
        reasons.append("reopened")
    return {"score": int(max(1, min(5, score))),
            "why": ", ".join(reasons[:3]) or "routine, little activity recorded",
            "topic": topic, "effort": effort}


def _parse(v) -> Optional[datetime]:
    s = str(v or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S.%f",
                "%Y-%m-%dT%H:%M:%S.%f"):
        try:
            return datetime.strptime(s[:26], fmt)
        except Exception:
            continue
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=None)
    except Exception:
        return None


# --------------------------------------------------------------------------------------
# 1-5 scoring, absolute and relative
# --------------------------------------------------------------------------------------

def score_absolute(value: Optional[float], thresholds: List[float], higher_is_better=True) -> Optional[int]:
    """Fixed-threshold 1-5. `thresholds` are the four boundaries, ascending."""
    if value is None:
        return None
    lo_to_hi = sorted(thresholds)
    if higher_is_better:
        s = 1
        for t in lo_to_hi:
            if value >= t:
                s += 1
        return min(5, s)
    s = 5
    for t in lo_to_hi:
        if value > t:
            s -= 1
    return max(1, s)


def score_relative(value: Optional[float], peers: List[float], higher_is_better=True) -> Optional[int]:
    """1-5 against this desk's own median. 3 means "no material difference from the desk".

    Deliberately RATIO-based, not z-score based. A five-person desk clustered between 14 and 31
    minutes has a tiny standard deviation, so z-scores turned a 31-minute median response - which
    is objectively good - into a 1 out of 5, and a manager reading that would go and coach
    someone who is doing fine. Ratios say something a human can check: "about half the desk
    median" or "nearly twice it".

    Two further guards against manufacturing drama out of noise:
      * if the desk is tightly clustered on this dimension (coefficient of variation under 15%),
        everyone scores 3 - there is genuinely nothing to distinguish;
      * a deadband around the median (0.7x-1.15x) is all scored 3.
    """
    vals = [v for v in peers if v is not None]
    if value is None or len(vals) < 3:
        return None
    med = statistics.median(vals)
    mean = statistics.mean(vals)
    if mean and (statistics.pstdev(vals) / abs(mean)) < 0.15:
        return 3
    if higher_is_better:
        if med <= 0:
            return 3 if value <= 0 else 5
        ratio = value / med
    else:
        if value is None or value <= 0:
            return 5 if med > 0 else 3
        if med <= 0:
            return 3
        ratio = med / value            # lower is better, so invert
    if ratio >= 1.5:
        return 5
    if ratio >= 1.15:
        return 4
    if ratio >= 0.7:
        return 3
    if ratio >= 0.4:
        return 2
    return 1


SCALE_WORDS = {1: "needs attention", 2: "below desk norm", 3: "solid / on par",
               4: "strong", 5: "excellent"}
COMPLEXITY_WORDS = {1: "trivial", 2: "routine", 3: "moderate", 4: "hard", 5: "very hard"}


# --------------------------------------------------------------------------------------
# Assembling one technician's picture
# --------------------------------------------------------------------------------------

def ledger_by_actor(hours: int) -> Dict[str, Dict[str, Any]]:
    """MEASURED minutes per technician, split by where the work happened.

    The ledger is the single record of work (owner's ruling: it is refreshed before any summary
    is sent), so this report reads it rather than recomputing time from messages. The surface
    split is what makes "time spent working with AI" answerable: `device_chat` and `ticket_chat`
    ARE the AI collaboration surfaces, `helpdesk_direct` is the tech typing into the ticket, and
    `rmm_activity` is hands-on device and remote-session work.
    """
    from django.utils import timezone as djangotime

    from core.models import TicketWorkEntry

    since = djangotime.now() - timedelta(hours=max(1, int(hours or 24)))
    out: Dict[str, Dict[str, Any]] = {}
    for e in (TicketWorkEntry.objects
              .filter(started_at__gte=since, superseded_by=None)
              .only("actor_display", "actor_username", "actor_kind", "surface", "human_minutes",
                    "ai_minutes", "ticket_ref", "started_at", "confidence")):
        if e.actor_kind not in ("tech", "tech_via_ai"):
            continue
        who = e.actor_display or e.actor_username or "?"
        d = out.setdefault(who, {"minutes": 0.0, "ai_minutes": 0.0, "by_surface": {},
                                 "refs": set(), "days": set(), "entries": 0,
                                 "measured_entries": 0, "off_ticket_minutes": 0.0})
        m = float(e.human_minutes or 0)
        d["minutes"] += m
        d["ai_minutes"] += float(e.ai_minutes or 0)
        d["by_surface"][e.surface] = round(d["by_surface"].get(e.surface, 0.0) + m, 1)
        d["entries"] += 1
        if e.confidence == "measured":
            d["measured_entries"] += 1
        if e.ticket_ref:
            d["refs"].add(e.ticket_ref)
        else:
            d["off_ticket_minutes"] += m
        if e.started_at:
            d["days"].add(djangotime.localtime(e.started_at).date())
    return out


AI_SURFACES = ("device_chat", "ticket_chat", "decision_chat")


def ai_credits_by_actor(hours: int) -> Dict[str, int]:
    """How many helpdesk actions each tech drove THROUGH the AI in the window."""
    from django.utils import timezone as djangotime

    from core.models import AIActionCredit

    since = djangotime.now() - timedelta(hours=max(1, int(hours or 24)))
    out: Dict[str, int] = {}
    for c in AIActionCredit.objects.filter(at__gte=since).only("actor_display", "actor_username"):
        who = c.actor_display or c.actor_username or "?"
        out[who] = out.get(who, 0) + 1
    return out


def build(data: Dict[str, Any], tickets: List[Dict[str, Any]], actors: Dict[str, Any],
          quality: Dict[str, Any], hours: int, phone: Dict[str, Any],
          pbx_overrides: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Everything the report shows, computed. No HTML, no model calls - just the numbers.

    Kept separate from rendering so the figures can be inspected, tested and handed to the model
    as JSON without going near presentation.
    """
    from django.utils import timezone as djangotime

    # Only people who actually appear on tickets are reported (owner's ruling).
    # The actor rollup labels humans "staff" when it derives them from ticket messages and
    # "tech"/"tech_via_ai" once the work ledger has re-attributed them, so all three are people.
    # Matching only one of those labels silently produced an empty report.
    techs = sorted([a for a in actors.values() if a["kind"] in ("staff", "tech", "tech_via_ai")],
                   key=lambda a: -a["minutes"])
    names = [a["name"] for a in techs]
    led = ledger_by_actor(hours)
    credits = ai_credits_by_actor(hours)

    pbx = {"map": {}, "unmatched": [], "ambiguous": []}
    if phone.get("ok"):
        pbx = match_pbx(names, phone.get("extensions") or {}, pbx_overrides)

    # Rate every ticket 1-5 once, up front: several people can touch one ticket and the rating
    # must be identical wherever it appears.
    for t in tickets:
        cx = complexity_1_5(t)
        t["cx5"] = cx["score"]
        t["cx5_why"] = cx["why"]

    tech_names = set(names)
    by_ref = {t.get("ref"): t for t in tickets}
    today = djangotime.localtime(djangotime.now()).date()
    days_in_window = max(1, int(round(hours / 24.0)))
    window_days = [today - timedelta(days=i) for i in range(days_in_window)]

    # Phone facts folded per technician.
    phone_by_tech: Dict[str, Dict[str, Any]] = {}
    if phone.get("ok"):
        ext_of = {tech: info["ext"] for tech, info in pbx["map"].items()}
        for tech, ext in ext_of.items():
            ins = [c for c in phone["answered_in"] if c["ext"] == ext]
            outs = [c for c in phone["outbound"]
                    if name_match_score(tech, c["name"]) >= 0.8]
            talk = sum(c["billsec"] for c in ins) + sum(c["billsec"] for c in outs)
            answered_out = [c for c in outs if not c["unanswered"] and c["billsec"] > 0]
            longest = max([c["billsec"] for c in ins + outs] or [0])
            call_days = {(_parse(c["at"]) or datetime.min).date() for c in ins + outs}
            phone_by_tech[tech] = {
                "ext": ext,
                "calls_in": len(ins),
                "calls_out": len(outs),
                "calls_out_connected": len(answered_out),
                "calls_total": len(ins) + len(outs),
                "talk_minutes": round(talk / 60.0, 1),
                "talk_in_minutes": round(sum(c["billsec"] for c in ins) / 60.0, 1),
                "talk_out_minutes": round(sum(c["billsec"] for c in outs) / 60.0, 1),
                "avg_call_minutes": round((talk / 60.0) / max(1, len(ins) + len(outs)), 1),
                "longest_call_minutes": round(longest / 60.0, 1),
                "hold_minutes": round(sum(c.get("hold", 0) for c in ins) / 60.0, 1),
                "call_days": call_days,
            }

    rows = []
    for a in techs:
        name = a["name"]
        q = quality.get(name, {})
        L = led.get(name, {})
        ph = phone_by_tech.get(name, {})

        touched = [by_ref[r] for r in a["tickets"] if r in by_ref]
        closed = [t for t in touched if t.get("terminal")]
        # Full list, no cap (owner's ruling: even if it is 100 tickets, all 100 appear).
        closed_sorted = sorted(closed, key=lambda t: t.get("last_activity") or "", reverse=True)

        # AUTONOMY, measured honestly: closes where no other technician also put time in.
        # The previous proxy ("three messages or fewer") measured how chatty a ticket was and
        # scored the entire desk 1 out of 5, which is a broken instrument, not a finding.
        solo_closed = sum(
            1 for t in closed
            if len({a for a in (t.get("actor_minutes") or {}) if a in tech_names and a != name}) == 0)

        cx_all = [t["cx5"] for t in touched] or [0]
        cx_closed = [t["cx5"] for t in closed]
        dist = {n: sum(1 for t in touched if t["cx5"] == n) for n in range(1, 6)}
        hard = [t for t in touched if t["cx5"] >= 4]

        # Time. The ledger is authoritative where it has entries; the message-derived estimate
        # from the activity report is the fallback so a tech with no ledger rows is not erased.
        minutes = round(L.get("minutes") or a["minutes"], 1)
        ai_collab = round(sum(v for s, v in (L.get("by_surface") or {}).items()
                              if s in AI_SURFACES), 1)
        hands_on = round((L.get("by_surface") or {}).get("rmm_activity", 0.0), 1)
        in_ticket = round((L.get("by_surface") or {}).get("helpdesk_direct", 0.0), 1)
        total_incl_phone = round(minutes + (ph.get("talk_minutes") or 0.0), 1)

        active_days = set(L.get("days") or set()) | set(ph.get("call_days") or set())
        for t in touched:
            for e in (t.get("events") or []):
                if e.get("actor") == name:
                    d = _parse(e.get("at"))
                    if d:
                        active_days.add(d.date())
        active_days = {d for d in active_days if d in set(window_days)}

        # DAYS WITH OPEN WORK AND NO RECORDED ACTIVITY. Not "idle" - unaccounted. Weekends are
        # excluded because a quiet Saturday is not a finding.
        open_assigned = [t for t in touched
                         if not t.get("terminal") and (t.get("assignee") or "") == name]
        dormant = []
        for d in sorted(window_days):
            if d.weekday() >= 5 or d in active_days:
                continue
            waiting = sum(1 for t in open_assigned
                          if (_parse(t.get("created")) or datetime.max).date() <= d)
            if waiting:
                dormant.append({"date": d.isoformat(), "open_tickets_waiting": waiting})

        closed_per_active_day = round(len(closed) / max(1, len(active_days)), 2)
        cx_weighted_closed = sum(cx_closed)
        min_per_ticket = round(minutes / max(1, len(touched)), 1)
        min_per_closed = round(minutes / max(1, len(closed)), 1) if closed else None
        # Efficiency has to be complexity-adjusted or it just rewards whoever takes easy work.
        min_per_cx_point = round(minutes / max(1, sum(cx_all)), 1)
        ai_share = round(100.0 * ai_collab / max(1.0, minutes), 1)
        tickets_with_ai = sum(1 for t in touched if t.get("ai_touched"))
        ai_ticket_share = round(100.0 * tickets_with_ai / max(1, len(touched)), 1)
        notes_written = sum(t.get("notes") or 0 for t in touched)

        rows.append({
            "name": name,
            "pbx": pbx["map"].get(name),
            "tickets_touched": len(touched),
            "tickets_closed": len(closed),
            "still_open": len(open_assigned),
            "companies": len(a.get("companies") or []),
            "work_sessions": a.get("sessions") or L.get("entries") or 0,
            "minutes": minutes,
            "minutes_incl_phone": total_incl_phone,
            "in_ticket_minutes": in_ticket,
            "ai_collab_minutes": ai_collab,
            "hands_on_minutes": hands_on,
            "off_ticket_minutes": round(L.get("off_ticket_minutes") or 0.0, 1),
            "time_is_measured": bool(L.get("entries")),
            "measured_share": round(100.0 * (L.get("measured_entries") or 0)
                                    / max(1, L.get("entries") or 1)),
            "avg_minutes_per_ticket": min_per_ticket,
            "avg_minutes_per_closed": min_per_closed,
            "minutes_per_complexity_point": min_per_cx_point,
            "avg_complexity": round(sum(cx_all) / max(1, len(cx_all)), 2),
            "avg_complexity_closed": round(sum(cx_closed) / max(1, len(cx_closed)), 2) if cx_closed else None,
            "complexity_distribution": dist,
            "complexity_weighted_closed": cx_weighted_closed,
            "hard_tickets": len(hard),
            "hard_tickets_closed": sum(1 for t in hard if t.get("terminal")),
            "ai_time_share_pct": ai_share,
            "ai_tickets": tickets_with_ai,
            "ai_ticket_share_pct": ai_ticket_share,
            "ai_driven_actions": credits.get(name, 0),
            "phone": ph,
            "median_first_response_min": q.get("median_first_response_min"),
            "replies_written": q.get("replies", 0),
            "avg_reply_chars": q.get("avg_reply_chars", 0),
            "notes_written": notes_written,
            "notes_per_ticket": round(notes_written / max(1, len(touched)), 2),
            "closed_without_reply": q.get("closed_without_reply", 0),
            "closed_in_under_5_min": q.get("closed_in_under_5_min", 0),
            "closed_per_active_day": closed_per_active_day,
            "solo_closed": solo_closed,
            "solo_closed_pct": round(100.0 * solo_closed / max(1, len(closed)), 1) if closed else None,
            "working_days_in_window": sum(1 for d in window_days if d.weekday() < 5),
            "active_days": len(active_days),
            "active_day_list": sorted(d.isoformat() for d in active_days),
            "dormant_days": dormant,
            "closed_tickets": [
                {"ref": t.get("ref"), "url": t.get("url"), "subject": (t.get("subject") or "")[:90],
                 "company": t.get("company") or "", "stage": t.get("stage") or "",
                 "closed_at": t.get("last_activity") or "", "cx5": t["cx5"], "cx5_why": t["cx5_why"],
                 "minutes": (t.get("actor_minutes") or {}).get(name, 0),
                 "msgs": t.get("msgs") or 0,
                 "first_response_min": t.get("first_response_minutes"),
                 "ai": bool(t.get("ai_touched")),
                 "time_source": t.get("time_source") or "estimated"}
                for t in closed_sorted
            ],
            "open_ticket_list": [
                {"ref": t.get("ref"), "url": t.get("url"), "subject": (t.get("subject") or "")[:90],
                 "company": t.get("company") or "", "stage": t.get("stage") or "",
                 "cx5": t["cx5"], "last_activity": t.get("last_activity") or "",
                 "minutes": (t.get("actor_minutes") or {}).get(name, 0)}
                for t in sorted(open_assigned, key=lambda t: t.get("last_activity") or "")
            ],
        })

    _score(rows)
    _coach(rows)

    desk = {
        "techs": len(rows),
        "tickets_closed": sum(r["tickets_closed"] for r in rows),
        "tickets_touched": sum(r["tickets_touched"] for r in rows),
        "minutes": round(sum(r["minutes"] for r in rows), 1),
        "ai_collab_minutes": round(sum(r["ai_collab_minutes"] for r in rows), 1),
        "talk_minutes": round(sum((r["phone"] or {}).get("talk_minutes", 0) for r in rows), 1),
        "calls": sum((r["phone"] or {}).get("calls_total", 0) for r in rows),
        "avg_complexity": round(statistics.mean([r["avg_complexity"] for r in rows]), 2) if rows else 0,
        "team_unanswered_calls": phone.get("team_unanswered", 0) if phone.get("ok") else None,
        "dormant_day_count": sum(len(r["dormant_days"]) for r in rows),
    }
    return {"rows": rows, "desk": desk, "pbx": pbx, "phone_ok": bool(phone.get("ok")),
            "phone_error": phone.get("error", ""),
            "phone_dedup_dropped": phone.get("dedup_dropped", 0),
            "window_days": days_in_window}


# The six dimensions the owner approved, plus phone engagement. 5 is always best.
# Absolute thresholds are the four boundaries between bands 1|2|3|4|5.
DIMENSIONS: List[Tuple[str, str, str, List[float], bool, str]] = [
    ("throughput", "Throughput", "closed_per_active_day",
     [0.5, 1.5, 3.0, 6.0], True, "Tickets closed per day they were active."),
    ("complexity", "Complexity handled", "avg_complexity",
     [1.5, 2.2, 2.9, 3.6], True, "Average difficulty (1-5) of the work they took on."),
    ("efficiency", "Resolution efficiency", "minutes_per_complexity_point",
     [45, 30, 20, 12], False, "Minutes spent per point of complexity - lower is better."),
    # Scored on THEIR OWN measured time in the AI surfaces, not on whether an AI ever touched
    # the ticket. The first version used ticket share, which credited a technician with 4/5 for
    # AI work they had no part in - the AI closes tickets autonomously overnight.
    ("ai_leverage", "AI leverage", "ai_time_share_pct",
     [3, 10, 20, 35], True, "Share of their own working time spent solving problems with the AI."),
    ("documentation", "Documentation", "notes_per_ticket",
     [0.3, 0.8, 1.5, 2.5], True, "Internal notes per ticket - will the next person understand it?"),
    ("communication", "Customer communication", "median_first_response_min",
     [480, 240, 60, 20], False, "Median minutes to first reply - lower is better."),
    ("autonomy", "Autonomy", "solo_closed_pct",
     [35, 55, 75, 90], True, "Share of their closes they handled without another tech stepping in."),
    ("phone", "Phone engagement", "talk_minutes_total",
     [15, 60, 150, 300], True, "Talk time in the period - inbound answered plus outbound."),
]


# Below this, a person's week is too thinly recorded to score. Raised as a direct result of the
# report's own AI audit, which pointed out that presenting an overall 3.4/5 built from two tickets
# and twenty minutes next to a colleague's 39 tickets invites exactly the unfair comparison this
# report exists to prevent. The metrics are still shown - only the summary score is withheld.
MIN_TICKETS_TO_SCORE = 5
MIN_MINUTES_TO_SCORE = 60


def _score(rows: List[Dict[str, Any]]) -> None:
    """Attach absolute and relative 1-5 scores, plus an overall, to every technician."""
    for r in rows:
        r["talk_minutes_total"] = (r["phone"] or {}).get("talk_minutes", 0.0) if r["phone"] else None
        r["insufficient_data"] = (r["tickets_touched"] < MIN_TICKETS_TO_SCORE
                                  or r["minutes"] < MIN_MINUTES_TO_SCORE)

    flat: List[str] = []
    for key, label, field, thresholds, higher, _why in DIMENSIONS:
        peers = [r.get(field) for r in rows]
        vals = [v for v in peers if v is not None]
        mean = statistics.mean(vals) if vals else 0
        # Remember when the desk was too tightly clustered to differentiate, instead of quietly
        # emitting a 3 that reads like a real measurement.
        tight = bool(len(vals) >= 3 and mean and (statistics.pstdev(vals) / abs(mean)) < 0.15)
        if tight:
            flat.append(label)
        for r in rows:
            v = r.get(field)
            r.setdefault("scores", {})[key] = {
                "absolute": score_absolute(v, thresholds, higher),
                "relative": score_relative(v, peers, higher),
                "value": v,
                "no_variance": tight,
            }
    for r in rows:
        vals = [s["absolute"] for s in r["scores"].values() if s["absolute"] is not None]
        rel = [s["relative"] for s in r["scores"].values() if s["relative"] is not None]
        if r["insufficient_data"]:
            # Deliberately withheld, not zero.
            r["overall_absolute"] = None
            r["overall_relative"] = None
            r["coverage_note"] = (
                f'{r["tickets_touched"]} ticket(s) and {fmt_mins(r["minutes"])} of recorded time '
                f"is too little to score fairly - the figures below are shown, but no overall "
                f"rating is given and none should be inferred")
        else:
            r["overall_absolute"] = round(statistics.mean(vals), 1) if vals else None
            r["overall_relative"] = round(statistics.mean(rel), 1) if rel else None
            r["coverage_note"] = ""
    rows_flat = sorted(set(flat))
    for r in rows:
        r["_flat_dimensions"] = rows_flat


def integrity_checks(payload: Dict[str, Any], hours: int) -> List[Dict[str, str]]:
    """Audit the report's own figures BEFORE anyone reads them, in code.

    This exists because the failure mode of a productivity report is not a crash - it is a
    plausible-looking number that is quietly wrong, which then gets used in a conversation about
    somebody's job. Every check here is a known way these figures can lie. The AI audit that
    follows reads these findings too, but this list does not depend on a model being available or
    honest, so it is the floor of the report's self-knowledge.

    Severity: "blocker" means do not draw conclusions from the affected figure; "warn" means the
    figure is usable with a caveat; "note" is context.
    """
    out: List[Dict[str, str]] = []
    rows = payload["rows"]
    desk = payload["desk"]

    if hours < 72:
        out.append({"severity": "warn", "area": "window",
                    "finding": f"The window is only {hours}h. Per-person scores over a period this "
                               f"short are dominated by whatever happened to land that day.",
                    "effect": "Scores are indicative only."})
    if not payload.get("phone_ok"):
        out.append({"severity": "blocker", "area": "phone",
                    "finding": f'Phone data could not be read ({payload.get("phone_error")}).',
                    "effect": "Phone columns are absent, not zero. Anyone whose day is mostly "
                              "calls will look inactive."})
    for who in (payload.get("pbx") or {}).get("unmatched", []):
        out.append({"severity": "blocker", "area": "phone attribution",
                    "finding": f"{who} could not be matched to a PBX extension.",
                    "effect": "All of their call work is missing. Pin them with a pbx override."})
    for who in (payload.get("pbx") or {}).get("ambiguous", []):
        out.append({"severity": "blocker", "area": "phone attribution",
                    "finding": f"{who} matched more than one extension equally well.",
                    "effect": "Excluded rather than guessed - their call work is missing."})

    # Time provenance: an estimated figure and a measured one should not be read the same way.
    est = [r["name"] for r in rows if not r["time_is_measured"]]
    if est:
        out.append({"severity": "warn", "area": "time",
                    "finding": f'No work-ledger entries for {", ".join(est)}; their time is '
                               f"inferred from ticket messages.",
                    "effect": "Their time is a rough floor and their efficiency score is weak."})
    low_conf = [f'{r["name"]} ({r["measured_share"]}%)' for r in rows
                if r["time_is_measured"] and r["measured_share"] < 50]
    if low_conf:
        out.append({"severity": "note", "area": "time",
                    "finding": f'Under half the ledger entries are transcript-measured for '
                               f'{", ".join(low_conf)}.',
                    "effect": "Time is partly derived rather than observed."})

    # Implausible per-ticket time - either the ticket volume or the time is wrong.
    for r in rows:
        if r["tickets_closed"] >= 5 and r["avg_minutes_per_closed"] is not None:
            if r["avg_minutes_per_closed"] < 8:
                out.append({"severity": "warn", "area": "time",
                            "finding": f'{r["name"]} averages only '
                                       f'{r["avg_minutes_per_closed"]}m per closed ticket.',
                            "effect": "Either work is happening off-system, or these closes were "
                                      "bulk/automated. Do not read the efficiency score as skill."})
            elif r["avg_minutes_per_closed"] > 240:
                out.append({"severity": "note", "area": "time",
                            "finding": f'{r["name"]} averages '
                                       f'{r["avg_minutes_per_closed"]}m per closed ticket.',
                            "effect": "Unusually high - check for a long-running ticket dominating."})
        zero = sum(1 for t in r["closed_tickets"] if not t["minutes"])
        if zero and r["tickets_closed"]:
            pct = round(100.0 * zero / r["tickets_closed"])
            if pct >= 25:
                out.append({"severity": "warn", "area": "time",
                            "finding": f'{pct}% of {r["name"]}\'s closes ({zero} of '
                                       f'{r["tickets_closed"]}) carry no recorded time at all.',
                            "effect": "Their total time - and so every rate derived from it - is "
                                      "understated."})
        # Time in the AI surfaces but no credited AI action, or the reverse.
        if r["ai_collab_minutes"] >= 60 and r["ai_driven_actions"] == 0:
            out.append({"severity": "note", "area": "AI attribution",
                        "finding": f'{r["name"]} has {fmt_mins(r["ai_collab_minutes"])} of AI '
                                   f"session time but zero credited AI-driven helpdesk actions.",
                        "effect": "They may be using the AI to think rather than to act, or the "
                                  "action credit is not being recorded on their sessions."})
        if r["phone"] and r["minutes"] and r["phone"].get("talk_minutes", 0) > r["minutes"] * 2:
            out.append({"severity": "note", "area": "phone",
                        "finding": f'{r["name"]} spent {fmt_mins(r["phone"]["talk_minutes"])} on '
                                   f'calls against {fmt_mins(r["minutes"])} of ticket time.',
                        "effect": "Their work is mostly phone-based; ticket-derived scores "
                                  "understate them."})

    # A scale on which everybody lands identically is not measuring anything this period.
    for key, label, field, _t, _hi, _w in DIMENSIONS:
        vals = [r["scores"][key]["absolute"] for r in rows if r["scores"][key]["absolute"] is not None]
        if len(vals) >= 3 and len(set(vals)) == 1:
            out.append({"severity": "note", "area": "scoring",
                        "finding": f'Every technician scored {vals[0]}/5 on "{label}".',
                        "effect": "The absolute thresholds are not discriminating this period; use "
                                  "the relative column for this dimension."})

    # Complexity that piles into one band tells the manager nothing.
    dist: Dict[int, int] = {}
    for r in rows:
        for n, c in r["complexity_distribution"].items():
            dist[n] = dist.get(n, 0) + c
    total = sum(dist.values())
    if total:
        top = max(dist, key=lambda k: dist[k])
        share = round(100.0 * dist[top] / total)
        if share >= 60:
            out.append({"severity": "warn", "area": "complexity",
                        "finding": f"{share}% of all tickets are rated {top}/5.",
                        "effect": "The complexity rating is not separating hard work from routine "
                                  "work this period; treat complexity-adjusted scores with care."})

    if desk.get("dormant_day_count"):
        out.append({"severity": "note", "area": "unaccounted days",
                    "finding": f'{desk["dormant_day_count"]} working day(s) across the desk show '
                               f"open tickets and no recorded activity in any system.",
                    "effect": "These are questions, not findings. On-site visits, projects and "
                              "leave leave no trace in the helpdesk, RMM, AI or PBX."})
    if payload.get("phone_dedup_dropped"):
        out.append({"severity": "note", "area": "phone",
                    "finding": f'{payload["phone_dedup_dropped"]} duplicate call legs were removed '
                               f"before counting talk time.",
                    "effect": "Expected: the PBX writes queue-recorded calls twice."})
    return out


AUDIT_PROMPT = """You are auditing a management report before it is sent. You are NOT writing the
report and you must NOT restate its conclusions.

You will be given: (1) the computed figures for each technician, (2) a description of exactly how
each figure was derived and what it cannot see, and (3) a list of problems the report's own
automated integrity checks already found.

Your job is to answer one question: CAN THESE FIGURES BE TRUSTED FOR A COACHING CONVERSATION,
and what is misleading about them?

Look specifically for:
- figures that contradict each other (e.g. a lot of tickets closed but almost no time recorded;
  large talk time but no ticket activity; time in AI sessions but no AI actions credited)
- people whose measured coverage is so poor that scoring them is unfair
- metrics that are saturated (everyone scores the same) or that are measuring an artefact of how
  the data is collected rather than the person's work
- anything that could make a technician look bad for a reason that is not about their work
- data that is missing rather than zero, and where that distinction changes the picture

You must NOT change any number, and you must NOT propose a different value for any figure. You
flag and explain only. If the figures look sound, say so plainly and briefly - do not invent
concerns to appear useful.

Answer in EXACTLY this format and nothing else:

CONFIDENCE: high | medium | low
VERDICT: <2-4 sentences: can these be used for coaching conversations, and with what caveat>
FLAG: <one specific thing that is misleading or unsafe to conclude, naming the person or metric>
FLAG: <another, if any - up to six, most serious first, omit the line entirely if there are none>
CHANGE: <one concrete improvement to how a metric is computed, collected or thresholded>
CHANGE: <another, if any - up to five, highest value first>"""


def audit(payload: Dict[str, Any], checks: List[Dict[str, str]], hours: int,
          options=None) -> Dict[str, Any]:
    """Have the model review the figures for accuracy. Advisory only - it cannot alter them."""
    import requests as _requests

    from django.conf import settings as _settings

    from core.tasks import _resolve_ai_model

    model = _resolve_ai_model(None)
    if not model:
        return {}
    digest = {
        "period_hours": hours,
        "desk": payload["desk"],
        "how_each_figure_is_derived": {
            "complexity_1_5": "max(subject-matter rating, effort-evidence rating). Security "
                              "incidents and server builds rate 5; password resets rate 2; clean "
                              "automated alerts rate 1. Effort uses message count, participants "
                              "and elapsed time.",
            "time": "work ledger: attention measured from AI chat transcripts, ticket message "
                    "bursts and RMM audit activity. Falls back to estimating from ticket "
                    "messages where no ledger entry exists. Cannot see on-site work, meetings, "
                    "project work or mobile calls.",
            "ai_collab_minutes": "their own measured minutes in AI surfaces (device chat, ticket "
                                 "chat, decision chat).",
            "phone": "FusionPBX CDRs. Outbound attributed by caller-ID name, inbound by the "
                     "answering extension. Unanswered inbound is NOT attributed to individuals "
                     "because inbound rings every extension at once. Internal extension-to-"
                     "extension calls are excluded entirely.",
            "dormant_days": "working days with tickets open and no activity in helpdesk, AI, RMM "
                            "or phones. Explicitly NOT a claim of idleness.",
            "scores": "absolute = fixed thresholds; relative = ratio to this desk's median with a "
                      "deadband, and everyone scores 3 if the desk is tightly clustered.",
        },
        "automated_integrity_findings": checks,
        "technicians": [
            {k: v for k, v in r.items()
             if k not in ("closed_tickets", "open_ticket_list", "active_day_list", "phone",
                          "strengths", "gaps")}
            | {"phone": {k: v for k, v in (r.get("phone") or {}).items() if k != "call_days"}}
            for r in payload["rows"]
        ],
    }
    prompt = str((options or {}).get("audit_prompt") or "").strip() or AUDIT_PROMPT
    bridge_url = getattr(_settings, "PI_BRIDGE_URL", "http://127.0.0.1:8787")
    try:
        r = _requests.post(
            f"{bridge_url}/pi/analyze",
            json={"provider": model.provider.name, "api_key": model.provider.api_key,
                  "model_id": model.model_id, "thinking_level": model.thinking_level or "medium",
                  "system_prompt": prompt,
                  "content": "Figures and derivation notes:\n\n"
                             + json.dumps(digest, indent=1, default=str)},
            timeout=(10, 600),
        )
        out = r.json()
    except Exception as e:
        return {"error": str(e)[:200]}
    if out.get("error") or not (out.get("text") or "").strip():
        return {"error": str(out.get("error") or "empty response")[:200]}
    text = out.get("text") or ""
    res: Dict[str, Any] = {"confidence": "", "verdict": "", "flags": [], "changes": []}
    for line in text.splitlines():
        line = line.strip().lstrip("-* ").strip()
        m = re.match(r"^(CONFIDENCE|VERDICT|FLAG|CHANGE)\s*:\s*(.+)$", line, re.I)
        if not m:
            continue
        key, val = m.group(1).upper(), m.group(2).strip()
        if key == "CONFIDENCE":
            res["confidence"] = val.lower()[:12]
        elif key == "VERDICT":
            res["verdict"] = val
        elif key == "FLAG":
            res["flags"].append(val)
        else:
            res["changes"].append(val)
    return res


def _coach(rows: List[Dict[str, Any]]) -> None:
    """Deterministic strengths and gaps, so the conversation has specifics in it.

    These are computed, not written by a model: the model's narrative sits on top of them and can
    be wrong, whereas "closed 14 tickets rated 4-5" is a fact either way.
    """
    desk_ai = statistics.median([r["ai_time_share_pct"] for r in rows]) if rows else 0
    for r in rows:
        r["_desk_ai_share"] = f"{desk_ai:g}%"
        good, gap = [], []
        s = r["scores"]

        if r["hard_tickets_closed"] >= 2:
            good.append(f'closed {r["hard_tickets_closed"]} genuinely hard ticket(s) (complexity 4-5)')
        if (s["complexity"]["absolute"] or 0) >= 4:
            good.append(f'takes on difficult work (avg complexity {r["avg_complexity"]}/5)')
        if (s["throughput"]["absolute"] or 0) >= 4:
            good.append(f'high throughput ({r["closed_per_active_day"]} closed per active day)')
        if (s["efficiency"]["absolute"] or 0) >= 4:
            good.append(f'efficient ({r["minutes_per_complexity_point"]}m per complexity point)')
        if (s["ai_leverage"]["absolute"] or 0) >= 4:
            good.append(f'strong AI use ({r["ai_time_share_pct"]}% of their time, '
                        f'{r["ai_driven_actions"]} AI-driven actions)')
        if (s["autonomy"]["absolute"] or 0) >= 4 and r["tickets_closed"] >= 5:
            good.append(f'works independently ({r["solo_closed_pct"]}% of closes needed no other tech)')
        if (s["communication"]["absolute"] or 0) >= 4 and r["median_first_response_min"] is not None:
            good.append(f'fast first response (median {r["median_first_response_min"]}m)')
        if (s["documentation"]["absolute"] or 0) >= 4:
            good.append(f'documents well ({r["notes_per_ticket"]} notes per ticket)')
        if r["phone"] and (r["phone"].get("talk_minutes") or 0) >= 120:
            good.append(f'carries phone load ({r["phone"]["talk_minutes"]:.0f}m talk time, '
                        f'{r["phone"]["calls_total"]} calls)')

        if (s["ai_leverage"]["absolute"] or 5) <= 2:
            # Two different findings share one score, and conflating them would be unfair: real
            # non-adoption, versus a tech who plainly is in AI sessions but whose actions are not
            # being credited. Only the first is a coaching point.
            if r["ai_collab_minutes"] >= 30:
                gap.append(f'low recorded AI leverage ({r["ai_time_share_pct"]}% of their working '
                           f'time against a desk median of {r.get("_desk_ai_share")}), though they '
                           f'do have {fmt_mins(r["ai_collab_minutes"])} of AI session time - check '
                           f'whether they are using it to think but not to act')
            else:
                gap.append(f'barely uses the AI ({r["ai_time_share_pct"]}% of their working time, '
                           f'{r["ai_driven_actions"]} AI-driven actions, desk median '
                           f'{r.get("_desk_ai_share")}) - the biggest single lever available to them')
        if (s["autonomy"]["absolute"] or 5) <= 2 and r["tickets_closed"] >= 5:
            gap.append(f'only {r["solo_closed_pct"]}% of their closes were handled without another '
                       f'tech stepping in - worth finding out where they get stuck')
        if (s["documentation"]["absolute"] or 5) <= 2:
            gap.append(f'thin documentation ({r["notes_per_ticket"]} notes per ticket) - hard for '
                       f'anyone else to pick up their tickets')
        if (s["communication"]["absolute"] or 5) <= 2 and r["median_first_response_min"] is not None:
            gap.append(f'slow first response (median {r["median_first_response_min"]}m)')
        if r["closed_without_reply"]:
            gap.append(f'{r["closed_without_reply"]} ticket(s) closed without ever writing to the '
                       f'customer')
        if r["closed_in_under_5_min"] >= 3:
            gap.append(f'{r["closed_in_under_5_min"]} ticket(s) closed in under 5 minutes with '
                       f'almost no activity - worth confirming they were really resolved')
        if (s["efficiency"]["absolute"] or 5) <= 2:
            gap.append(f'slow relative to difficulty ({r["minutes_per_complexity_point"]}m per '
                       f'complexity point) - may be stuck without asking for help')
        if (s["complexity"]["absolute"] or 5) <= 2 and r["tickets_touched"] >= 5:
            gap.append(f'work is mostly low-complexity (avg {r["avg_complexity"]}/5) - ready to be '
                       f'stretched onto harder tickets')
        if r["still_open"] >= 10:
            gap.append(f'{r["still_open"]} ticket(s) still open on their plate')
        if r["dormant_days"]:
            days = ", ".join(d["date"] for d in r["dormant_days"][:5])
            gap.append(f'{len(r["dormant_days"])} working day(s) with open tickets and no recorded '
                       f'activity anywhere ({days}) - may be off-system work, worth asking')
        if r["phone"] is None or not r["phone"]:
            gap.append("no PBX identity matched, so their phone work is invisible here")

        r["strengths"] = good
        r["gaps"] = gap


# --------------------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------------------

def esc(v) -> str:
    s = "" if v is None else str(v)
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def fmt_mins(m) -> str:
    m = int(round(m or 0))
    if m < 60:
        return f"{m}m"
    return f"{m // 60}h {m % 60:02d}m"


def _pill(score: Optional[int], invert=False) -> str:
    """A 1-5 score as a coloured chip. Invert for complexity, where 5 is hard, not good."""
    if score is None:
        return '<span style="color:#999">n/a</span>'
    kind = "h" if invert else "g"
    return f'<span class="p{kind}{score}">{score}</span>'


def _bar(dist: Dict[int, int]) -> str:
    """Complexity mix as a stacked strip, so the shape of someone's week is visible at a glance."""
    total = sum(dist.values()) or 1
    cols = {1: "#cbd5e1", 2: "#7dd3fc", 3: "#fcd34d", 4: "#fb923c", 5: "#ef4444"}
    cells = []
    for n in range(1, 6):
        if not dist.get(n):
            continue
        pct = max(4, round(100.0 * dist[n] / total))
        cells.append(f'<td width="{pct}%" style="background:{cols[n]};color:#1f2937;font-size:10.5px;'
                     f'text-align:center;padding:2px 0" title="complexity {n}">{n}:{dist[n]}</td>')
    if not cells:
        return ""
    return ('<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:190px">'
            f'<tr>{"".join(cells)}</tr></table>')


def _cards(desk: Dict[str, Any], payload: Dict[str, Any]) -> str:
    def card(label, value, sub="", colour="#1a3c6e"):
        return (f'<td style="border:1px solid #d8dee7;padding:12px 14px;background:#f7f9fc;text-align:center">'
                f'<div style="font-size:22px;font-weight:700;color:{colour}">{value}</div>'
                f'<div style="font-size:11px;color:#666;text-transform:uppercase">{label}</div>'
                f'<div style="font-size:10.5px;color:#999">{sub}</div></td>')
    h = ['<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%"><tr>']
    h.append(card("technicians", desk["techs"]))
    h.append(card("tickets closed", desk["tickets_closed"], f'{desk["tickets_touched"]} touched'))
    h.append(card("avg complexity", f'{desk["avg_complexity"]}/5', "across the desk"))
    h.append(card("tech time", fmt_mins(desk["minutes"]), "measured, on tickets"))
    h.append(card("with the AI", fmt_mins(desk["ai_collab_minutes"]),
                  f'{round(100.0 * desk["ai_collab_minutes"] / max(1.0, desk["minutes"]))}% of tech time',
                  "#166534"))
    if payload.get("phone_ok"):
        h.append(card("talk time", fmt_mins(desk["talk_minutes"]), f'{desk["calls"]} calls'))
    if desk.get("dormant_day_count"):
        h.append(card("unaccounted days", desk["dormant_day_count"], "open work, no activity", "#92400e"))
    h.append("</tr></table>")
    return "".join(h)


def _provenance(payload: Dict[str, Any], hours: int) -> str:
    """Say plainly where every number came from and what it cannot see.

    A productivity report that hides its own blind spots is how someone gets judged on a metric
    that was never measuring them. This box is not optional.
    """
    pbx = payload.get("pbx") or {}
    bits = []
    if payload.get("phone_ok"):
        matched = ", ".join(f'{esc(k)} &rarr; ext {v["ext"]}' for k, v in (pbx.get("map") or {}).items())
        bits.append(f"<b>Phone:</b> read live from the FusionPBX CDR database (read-only). "
                    f"Matched: {matched or 'nobody'}.")
        if pbx.get("unmatched"):
            bits.append(f'<b style="color:#b91c1c">No PBX match for {esc(", ".join(pbx["unmatched"]))}</b> '
                        f"&mdash; their call time is missing from this report. Pin them with a "
                        f'"pbx" override on the schedule.')
        if pbx.get("ambiguous"):
            bits.append(f'<b style="color:#b91c1c">Ambiguous PBX match for '
                        f'{esc(", ".join(pbx["ambiguous"]))}</b> &mdash; excluded rather than guessed.')
        if payload.get("phone_dedup_dropped"):
            bits.append(f'{payload["phone_dedup_dropped"]} duplicate call legs were discarded '
                        f"(queue-recorded calls are written twice by the PBX).")
        bits.append("Inbound rings every extension at once, so a call another tech answered is "
                    "<b>never</b> counted as this tech's missed call; unanswered inbound is "
                    "reported once for the team. Internal extension-to-extension calls are excluded.")
    else:
        bits.append('<b style="color:#b91c1c">Phone data unavailable</b> &mdash; '
                    f'{esc(payload.get("phone_error") or "unknown reason")}. '
                    "All phone figures below are absent, not zero.")
    bits.append("<b>Time:</b> taken from the work ledger, which measures attention from chat "
                "transcripts, ticket message bursts and RMM activity. Where a ticket has no "
                "ledger entry, time is estimated from its activity log.")
    bits.append("<b>&ldquo;Unaccounted days&rdquo; are not idle days.</b> They are working days "
                "with tickets open and no record of activity in the helpdesk, the AI, RMM or the "
                "phones. On-site visits, projects and vendor calls leave no trace here. Treat "
                "them as questions to ask, never as conclusions.")
    return ('<div style="font-size:11.5px;color:#555;'
            'background:#f8fafc;border:1px solid #e3e8ef;border-left:4px solid #64748b;'
            'padding:10px 14px;margin:14px 0">'
            + "<br>".join(bits) + "</div>")


def _scorecard(rows: List[Dict[str, Any]]) -> str:
    h = ['<h3 style="font-size:15px;color:#1a3c6e;margin:26px 0 4px">'
         "Scorecard &mdash; every scale is 1 to 5, where 5 is best</h3>",
         '<div style="font-size:11.5px;color:#777;margin-bottom:6px">'
         "Each cell shows <b>absolute</b> (against fixed standards) then <b>relative</b> "
         "(against this desk, where 3 is the desk median). Both are shown because a small team "
         "can be uniformly strong or uniformly slipping, and only one of the two views notices.</div>",
         '<table cellspacing="0" cellpadding="6" style="border-collapse:collapse;'
         'font-size:12px;width:100%">']
    head = ["Technician"] + [d[1] for d in DIMENSIONS] + ["Overall"]
    h.append("<tr>" + "".join(
        f'<th class="hd">{c}</th>' for c in head) + "</tr>")
    for i, r in enumerate(sorted(rows, key=lambda x: -(x["overall_absolute"] or 0))):
        td = 'class="s"' if i % 2 == 0 else 'class="s z"'
        h.append(f'<tr><td {td}><b>{esc(r["name"])}</b>'
                 + (f'<div style="font-size:10px;color:#888">ext {r["pbx"]["ext"]}</div>' if r.get("pbx") else "")
                 + "</td>")
        for key, _l, _f, _t, _hi, _w in DIMENSIONS:
            s = r["scores"][key]
            val = s["value"]
            vs = "" if val is None else (f'{val:g}' if isinstance(val, (int, float)) else str(val))
            h.append(f'<td {td} align="center">{_pill(s["absolute"])} {_pill(s["relative"])}'
                     f'<div style="font-size:10px;color:#888">{esc(vs)}</div></td>')
        if r.get("insufficient_data"):
            h.append(f'<td {td} align="center"><b style="font-size:11px;color:#92400e">withheld</b>'
                     f'<div style="font-size:10px;color:#888">too little data</div></td></tr>')
        else:
            h.append(f'<td {td} align="center"><b style="font-size:14px;color:#1a3c6e">'
                     f'{r["overall_absolute"]}</b>'
                     f'<div style="font-size:10px;color:#888">rel {r["overall_relative"]}</div></td></tr>')
    h.append("</table>")
    flatd = (rows[0].get("_flat_dimensions") if rows else None) or []
    if flatd:
        h.append('<div style="font-size:11.5px;color:#92400e;'
                 'background:#fffbeb;border:1px solid #fcd34d;padding:6px 9px;margin:5px 0">'
                 f'<b>No material spread on {esc(", ".join(flatd))}</b> &mdash; the desk is tightly '
                 "clustered there, so every relative score on those dimensions is 3 by rule, not "
                 "by measurement. Read the absolute column for those.</div>")
    if any(r.get("insufficient_data") for r in rows):
        who = ", ".join(esc(r["name"]) for r in rows if r.get("insufficient_data"))
        h.append('<div style="font-size:11.5px;color:#92400e;'
                 'background:#fffbeb;border:1px solid #fcd34d;padding:6px 9px;margin:5px 0">'
                 f'<b>Overall score withheld for {who}</b> &mdash; fewer than '
                 f'{MIN_TICKETS_TO_SCORE} tickets or under {MIN_MINUTES_TO_SCORE} minutes of '
                 "recorded time in the period. Their individual figures are still shown, but they "
                 "cannot fairly be compared with a colleague who has a full week of recorded "
                 "work.</div>")
    h.append('<div style="font-size:11px;color:#888;margin:4px 0 0">'
             + " &middot; ".join(f'<b>{esc(d[1])}</b>: {esc(d[5])}' for d in DIMENSIONS) + "</div>")
    return "".join(h)


def _ticket_rows(items: List[Dict[str, Any]], closed=True) -> str:
    """The per-technician ticket lists - every ticket, never truncated.

    Styled with CSS classes rather than inline attributes purely for weight: with inline styles
    this table alone pushed a week's report to 295KB, and Gmail clips a message at about 102KB -
    which would have hidden most of the ticket detail behind "view entire message" and quietly
    defeated the requirement that all of it be in the email. A monthly run is several hundred
    rows, so this has to scale.
    """
    cols = (["86", "", "130", "26", "52", "34", "52", "26", "92"] if closed
            else ["86", "", "130", "26", "52", "90", "92"])
    h = ['<table cellspacing="0" cellpadding="4" class="tt">',
         "<colgroup>" + "".join(f'<col width="{w}">' if w else "<col>" for w in cols) + "</colgroup>"]
    head = (["Ticket", "Subject", "Company", "Cx", "Time", "Msgs", "1st resp", "AI", "Closed"]
            if closed else ["Ticket", "Subject", "Company", "Cx", "Time", "Stage", "Last activity"])
    h.append("<tr>" + "".join(f"<th>{c}</th>" for c in head) + "</tr>")
    for i, t in enumerate(items):
        tr = "<tr>" if i % 2 == 0 else '<tr class="z">'
        link = f'<a href="{esc(t.get("url"))}" class="lk">{esc(t.get("ref"))}</a>'
        if closed:
            fr = t.get("first_response_min")
            h.append(
                f"{tr}<td>{link}</td>"
                f'<td>{esc(t.get("subject"))}</td>'
                f'<td>{esc((t.get("company") or "")[:26])}</td>'
                f'<td class="m">{_pill(t.get("cx5"), invert=True)}</td>'
                f'<td class="r">{fmt_mins(t.get("minutes"))}</td>'
                f'<td class="m">{t.get("msgs")}</td>'
                f'<td class="r">{fmt_mins(fr) if fr is not None else "&ndash;"}</td>'
                f'<td class="m">{"&#10003;" if t.get("ai") else ""}</td>'
                f'<td>{esc((t.get("closed_at") or "")[:16])}</td></tr>')
        else:
            h.append(
                f"{tr}<td>{link}</td>"
                f'<td>{esc(t.get("subject"))}</td>'
                f'<td>{esc((t.get("company") or "")[:26])}</td>'
                f'<td class="m">{_pill(t.get("cx5"), invert=True)}</td>'
                f'<td class="r">{fmt_mins(t.get("minutes"))}</td>'
                f'<td>{esc(t.get("stage"))}</td>'
                f'<td>{esc((t.get("last_activity") or "")[:16])}</td></tr>')
    h.append("</table>")
    return "".join(h)


def _tech_block(r: Dict[str, Any], narrative: str = "") -> str:
    ph = r.get("phone") or {}
    def kv(label, value, note=""):
        return (f'<td class="k"><div class="kv">{value}</div><div class="kl">{label}</div>'
                + (f'<div class="kn">{note}</div>' if note else "") + "</td>")

    h = [f'<div style="border:1px solid #d8dee7;border-top:3px solid #1a3c6e;margin:22px 0 0;'
         f'padding:12px 14px">'
         f'<div style="font-size:17px;font-weight:700;'
         f'color:#1a3c6e">{esc(r["name"])}'
         + (f'<span style="font-size:12px;font-weight:400;color:#666"> &mdash; extension '
            f'{r["pbx"]["ext"]} ({esc(r["pbx"]["how"])})</span>' if r.get("pbx") else
            '<span style="font-size:12px;font-weight:400;color:#b91c1c"> &mdash; no PBX match</span>')
         + ('<span style="float:right;font-size:12px;color:#92400e">overall score withheld</span>'
            if r.get("insufficient_data") else
            f'<span style="float:right;font-size:13px;color:#1f2937">overall '
            f'<b>{r["overall_absolute"]}</b>/5 absolute &middot; '
            f'<b>{r["overall_relative"]}</b>/5 vs desk</span>')
         + "</div>"]
    if r.get("coverage_note"):
        h.append('<div style="font-size:11.5px;color:#92400e;'
                 'background:#fffbeb;border:1px solid #fcd34d;padding:6px 9px;margin:8px 0">'
                 f'{esc(r["coverage_note"])}.</div>')

    h.append('<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:10px 0"><tr>')
    h.append(kv("closed", r["tickets_closed"], f'{r["tickets_touched"]} touched, {r["still_open"]} still open'))
    h.append(kv("avg complexity", f'{r["avg_complexity"]}/5',
                f'{r["hard_tickets_closed"]} hard one(s) closed'))
    h.append(kv("time on tickets", fmt_mins(r["minutes"]),
                (f'{r["measured_share"]}% transcript-measured' if r["time_is_measured"]
                 else "estimated from messages, no ledger entries")))
    h.append(kv("avg per ticket", fmt_mins(r["avg_minutes_per_ticket"]),
                f'{fmt_mins(r["avg_minutes_per_closed"])} per close' if r["avg_minutes_per_closed"] else ""))
    h.append(kv("with the AI", fmt_mins(r["ai_collab_minutes"]),
                f'{r["ai_time_share_pct"]}% of their time &middot; {r["ai_driven_actions"]} actions'))
    h.append(kv("hands-on / RMM", fmt_mins(r["hands_on_minutes"]), "remote sessions, device work"))
    h.append("</tr><tr>")
    if ph:
        h.append(kv("talk time", fmt_mins(ph.get("talk_minutes")),
                    f'{ph.get("calls_in", 0)} in, {ph.get("calls_out", 0)} out'))
        h.append(kv("avg call", fmt_mins(ph.get("avg_call_minutes")),
                    f'longest {fmt_mins(ph.get("longest_call_minutes"))}'))
    else:
        h.append(kv("talk time", "n/a", "no PBX identity matched"))
        h.append(kv("avg call", "n/a", ""))
    h.append(kv("total accounted", fmt_mins(r["minutes_incl_phone"]), "tickets + phone"))
    fr = r["median_first_response_min"]
    h.append(kv("1st response", fmt_mins(fr) if fr is not None else "n/a", "median, to the customer"))
    h.append(kv("wrote", f'{r["replies_written"]} replies',
                f'{r["notes_written"]} notes &middot; avg {r["avg_reply_chars"]} chars'))
    h.append(kv("active days", f'{r["active_days"]} of {r["working_days_in_window"]}',
                f'{len(r["dormant_days"])} working day(s) unaccounted' if r["dormant_days"]
                else "nothing unaccounted"))
    h.append("</tr></table>")

    h.append('<table cellspacing="0" cellpadding="0" style="width:100%"><tr>'
             '<td style="font-size:11.5px;color:#555;'
             'padding-right:10px" width="210">Complexity mix of their tickets<br>'
             + _bar(r["complexity_distribution"]) + "</td>"
             '<td style="font-size:11.5px;color:#555">'
             + " &middot; ".join(
                 f'<b>{esc(l)}</b> {_pill(r["scores"][k]["absolute"])}/{_pill(r["scores"][k]["relative"])}'
                 for k, l, *_ in DIMENSIONS)
             + "</td></tr></table>")

    if narrative:
        if isinstance(narrative, dict):
            colours = {"strengths": ("#166534", "Doing well"), "concerns": ("#b45309", "Concerns"),
                       "actions": ("#1a3c6e", "For the one-to-one"), "watch": ("#6b21a8", "Watch next week")}
            inner = []
            for key in ("strengths", "concerns", "actions", "watch"):
                if not narrative.get(key):
                    continue
                col, lbl = colours[key]
                inner.append(
                    f'<div style="margin:0 0 7px"><span style="'
                    f'font-size:10.5px;font-weight:700;color:{col};text-transform:uppercase">{lbl}</span>'
                    f'<div style="font-size:12.5px;'
                    f'line-height:1.55;color:#1f2937">{narrative[key]}</div></div>')
            if inner:
                h.append('<div style="border-left:4px solid #1a3c6e;background:#f8fafc;'
                         'padding:10px 13px;margin:10px 0">' + "".join(inner) + "</div>")
        else:
            h.append('<div style="border-left:4px solid #1a3c6e;background:#f8fafc;padding:9px 12px;'
                     'margin:10px 0;font-size:12.5px;'
                     f'line-height:1.55;color:#1f2937">{narrative}</div>')

    if r["strengths"]:
        h.append('<div style="font-size:12px;color:#166534;'
                 'margin:8px 0 2px"><b>Doing well:</b></div><ul style="margin:0 0 6px 18px;'
                 'font-size:12px;color:#1f2937">'
                 + "".join(f"<li>{esc(x)}</li>" for x in r["strengths"]) + "</ul>")
    if r["gaps"]:
        h.append('<div style="font-size:12px;color:#b45309;'
                 'margin:6px 0 2px"><b>Worth a conversation:</b></div><ul style="margin:0 0 6px 18px;'
                 'font-size:12px;color:#1f2937">'
                 + "".join(f"<li>{esc(x)}</li>" for x in r["gaps"]) + "</ul>")

    if r["dormant_days"]:
        h.append('<div style="font-size:11.5px;color:#92400e;'
                 'background:#fffbeb;border:1px solid #fcd34d;padding:7px 10px;margin:6px 0">'
                 "<b>Working days with open tickets and no recorded activity:</b> "
                 + ", ".join(f'{esc(d["date"])} ({d["open_tickets_waiting"]} open)'
                             for d in r["dormant_days"])
                 + ". This is not proof of idleness &mdash; on-site work and projects leave no "
                   "trace in these systems. It is a question to ask.</div>")

    h.append(f'<div style="font-size:12.5px;color:#1a3c6e;'
             f'font-weight:700;margin:12px 0 2px">All {len(r["closed_tickets"])} ticket(s) '
             f'{esc(r["name"])} completed in this period</div>')
    if r["closed_tickets"]:
        h.append(_ticket_rows(r["closed_tickets"], closed=True))
    else:
        h.append('<div style="font-size:12px;color:#888;'
                 'margin-bottom:8px">Nothing closed in this period.</div>')

    if r["open_ticket_list"]:
        h.append(f'<div style="font-size:12.5px;color:#92400e;'
                 f'font-weight:700;margin:8px 0 2px">Still open and assigned to them '
                 f'({len(r["open_ticket_list"])}) &mdash; oldest activity first</div>')
        h.append(_ticket_rows(r["open_ticket_list"], closed=False))
    h.append("</div>")
    return "".join(h)


DEFAULT_TP_PROMPT = """You are an experienced service-desk manager writing the coaching notes
for a weekly one-to-one with each technician at an MSP. Your reader is the owner of the business.
He has asked for depth, not brevity: more detail is better than less.

You are given computed figures per technician: tickets touched and closed, ticket complexity rated
1-5, measured working time, time spent solving problems with the AI assistant, phone talk time from
the PBX, response times, documentation volume, autonomy, days with no recorded activity, examples
of the hardest tickets they closed, and 1-5 scores (absolute against fixed standards, and relative
to this desk's median).

For EACH technician write a full review, in four labelled parts:
  STRENGTHS - what the figures show they are genuinely good at. Quote the numbers. Name the actual
    hard tickets they closed where it supports the point.
  CONCERNS - what the figures suggest is holding them back or creating risk. Be direct and
    specific. If there is nothing material, say so rather than manufacturing a concern.
  ACTIONS - two to four concrete things to do or say in the one-to-one this week. Each must be
    something a manager can actually act on, not a platitude.
  WATCH - one thing to check next week to see whether it moved.

Rules you must follow:
- These figures measure RECORDED activity, not a person's worth. Never call anyone lazy, never
  speculate about attitude or motivation, and never suggest discipline or dismissal.
- Days with no recorded activity may be on-site visits, project work, meetings or leave. Always
  frame them as "worth asking about", never as "did nothing".
- Complexity 5 means hard, not good. Someone closing lots of simple tickets is not failing - they
  may be ready to be stretched. Someone slow on genuinely hard tickets may need help, not pressure.
- A technician whose work is mostly phone-based will look weak on ticket metrics. Say so if the
  phone figures support it.
- If AI usage is low, say it plainly and explain what they are missing - it is the single biggest
  lever this desk has. If it is high, say what it is buying them.
- Distinguish absolute from relative scores when they disagree - a 4 absolute and a 2 relative
  means "good, but the desk is stronger", which is a completely different conversation from
  "struggling".
- Do not invent any fact that is not in the figures.

Use this EXACT format, and nothing else:

NAME: <technician name exactly as given>
STRENGTHS: <text>
CONCERNS: <text>
ACTIONS: <text>
WATCH: <text>

After all technicians, one final block:

DESK: <four to eight sentences on the desk as a whole: where the load is really concentrated, who
is carrying what, the biggest single coaching theme across everyone, the most important structural
problem the figures reveal, and what the owner should do first this week.>"""


def narratives(payload: Dict[str, Any], hours: int, core, options=None) -> Dict[str, str]:
    """Ask the model for a coaching paragraph per technician. Never fatal."""
    import requests as _requests

    from core.tasks import _resolve_ai_model

    model = _resolve_ai_model(None)
    if not model:
        return {}
    digest = {
        "period_hours": hours,
        "desk": payload["desk"],
        "scale_note": "all scores 1-5, 5 best; complexity 1-5, 5 hardest",
        "technicians": [
            {k: v for k, v in r.items()
             if k not in ("closed_tickets", "open_ticket_list", "active_day_list", "phone")}
            | {"phone": {k: v for k, v in (r.get("phone") or {}).items() if k != "call_days"}}
            | {"example_hard_tickets": [
                {"ref": t["ref"], "subject": t["subject"], "complexity": t["cx5"],
                 "why": t["cx5_why"], "minutes": t["minutes"]}
                for t in sorted(r["closed_tickets"], key=lambda x: -x["cx5"])[:6]]}
            for r in payload["rows"]
        ],
    }
    opts = options or {}
    prompt = str(opts.get("prompt") or "").strip() or DEFAULT_TP_PROMPT
    extra = str(opts.get("prompt_extra") or "").strip()
    if extra:
        prompt += ("\n\nADDITIONAL INSTRUCTIONS FOR THIS REPORT (follow them in addition to "
                   "everything above):\n" + extra)
    bridge_url = getattr(__import__("django.conf", fromlist=["settings"]).settings,
                         "PI_BRIDGE_URL", "http://127.0.0.1:8787")
    try:
        r = _requests.post(
            f"{bridge_url}/pi/analyze",
            json={"provider": model.provider.name, "api_key": model.provider.api_key,
                  "model_id": model.model_id, "thinking_level": model.thinking_level or "medium",
                  "system_prompt": prompt,
                  "content": "Computed figures for the period:\n\n"
                             + json.dumps(digest, indent=1, default=str)},
            timeout=(10, 600),
        )
        out = r.json()
    except Exception as e:
        return {"__error__": str(e)[:200]}
    if out.get("error") or not (out.get("text") or "").strip():
        return {"__error__": str(out.get("error") or "empty response")[:200]}

    text = out.get("text") or ""
    found: Dict[str, Any] = {}
    # Split on NAME:/DESK: headers, then pull the labelled parts out of each block. Parsed
    # leniently on purpose: a model that adds a stray blank line or bolds a label should not
    # cost us the whole review section.
    blocks = re.split(r"^(?=(?:NAME|DESK)\s*:)", text.strip(), flags=re.M)
    for b in blocks:
        b = b.strip()
        m = re.match(r"^(NAME|DESK)\s*:\s*(.*?)(?:\n|$)(.*)$", b, re.S)
        if not m:
            continue
        kind, who, body = m.group(1), m.group(2).strip(), m.group(3).strip()
        if kind == "DESK":
            found["__desk__"] = _rich(who + " " + body if who else body)
            continue
        parts: Dict[str, str] = {}
        for label in ("STRENGTHS", "CONCERNS", "ACTIONS", "WATCH"):
            mm = re.search(rf"^\**{label}\**\s*:\s*(.*?)(?=^\**(?:STRENGTHS|CONCERNS|ACTIONS|WATCH)\**\s*:|\Z)",
                           body, re.S | re.M | re.I)
            if mm and mm.group(1).strip():
                parts[label.lower()] = _rich(mm.group(1).strip())
        if not parts and body:
            parts["strengths"] = _rich(body)
        if who:
            found[who] = parts
    return found


def _rich(t: str) -> str:
    """Escape, then allow the few inline forms a model reliably produces."""
    out = esc(re.sub(r"\n{2,}", "\x00", t.strip()).replace("\n", " ")).replace("\x00", "<br><br>")
    out = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", out)
    return re.sub(r"(?<![A-Za-z0-9])\*(.+?)\*(?![A-Za-z0-9])", r"<i>\1</i>", out)


# One stylesheet instead of an inline style on every cell. With ~140 ticket rows the inline form
# produced a 295KB email; Gmail clips at roughly 102KB, which would have hidden most of the ticket
# detail behind "view entire message" - defeating the requirement that every completed ticket be
# in the mail. Structural colour stays inline so that a client which strips <style> still renders
# readable content, just without the borders and stripes.
HEAD_CSS = """
body,td,th,div,span,li,p,b,i,a{font-family:Segoe UI,Arial,Helvetica,sans-serif}
body{margin:0;padding:0}
table{border-collapse:collapse}
.tt{width:100%;font-size:11.5px;margin:4px 0 10px}
.tt td{border:1px solid #e3e8ef;padding:4px 6px;vertical-align:top}
.tt th{background:#eef2f7;color:#1a3c6e;text-align:left;padding:4px 6px;font-size:10.5px;
    border:1px solid #e3e8ef}
.m{text-align:center}.r{text-align:right}
.hd{background:#1a3c6e;color:#fff;text-align:left;padding:6px;font-size:11px}
.c{border:1px solid #e3e8ef;padding:4px 6px}
.s{border:1px solid #d8dee7;padding:6px}
.z{background:#fbfcfe}
.lk{color:#0b5cad;font-weight:600;text-decoration:none}
.k{border:1px solid #e3e8ef;padding:7px 9px;background:#fbfcfe;vertical-align:top}
.kv{font-size:15px;font-weight:700;color:#1a3c6e}
.kl{font-size:10.5px;color:#666;text-transform:uppercase}
.kn{font-size:10px;color:#999}
.pg1,.pg2,.pg3,.pg4,.pg5,.ph1,.ph2,.ph3,.ph4,.ph5{display:inline-block;min-width:16px;
    padding:1px 6px;border-radius:9px;color:#fff;font-weight:700;font-size:11.5px;
    text-align:center}
.pg1{background:#b91c1c}.pg2{background:#c2410c}.pg3{background:#a16207}
.pg4{background:#15803d}.pg5{background:#166534}
.ph1{background:#64748b}.ph2{background:#0369a1}.ph3{background:#a16207}
.ph4{background:#c2410c}.ph5{background:#b91c1c}
"""


def _audit_html(checks: List[Dict[str, str]], ai: Dict[str, Any]) -> str:
    """The report auditing itself, in public.

    Put near the top on purpose: a reader should learn what these numbers cannot support BEFORE
    they read them, not in a footnote afterwards.
    """
    conf = (ai or {}).get("confidence") or ""
    band = {"high": ("#166534", "#f7fbf8"), "medium": ("#a16207", "#fffbeb"),
            "low": ("#b91c1c", "#fef2f7")}.get(conf, ("#64748b", "#f8fafc"))
    h = [f'<div style="border:1px solid #d8dee7;border-left:4px solid {band[0]};'
         f'background:{band[1]};padding:12px 16px;margin:0 0 16px">',
         '<div style="font-size:11px;'
         f'color:{band[0]};text-transform:uppercase;font-weight:700;margin-bottom:5px">'
         "Data confidence &amp; audit"
         + (f' &mdash; AI review says confidence is {esc(conf)}' if conf else "")
         + "</div>"]
    if (ai or {}).get("verdict"):
        h.append('<div style="font-size:13px;line-height:1.6;'
                 f'color:#1f2937;margin-bottom:8px">{_rich(ai["verdict"])}</div>')
    elif (ai or {}).get("error"):
        h.append('<div style="font-size:12px;color:#92400e;'
                 f'margin-bottom:8px">AI audit unavailable ({esc(ai["error"])}). The automated '
                 "integrity checks below still ran.</div>")

    if (ai or {}).get("flags"):
        h.append('<div style="font-size:11px;color:#b91c1c;'
                 'font-weight:700;text-transform:uppercase;margin:6px 0 2px">'
                 "Do not conclude the following from this report</div>"
                 '<ul style="margin:0 0 8px 18px;'
                 'font-size:12.5px;line-height:1.5;color:#1f2937">'
                 + "".join(f"<li>{_rich(x)}</li>" for x in ai["flags"]) + "</ul>")

    sev = {"blocker": ("#b91c1c", "BLOCKER"), "warn": ("#b45309", "CAUTION"), "note": ("#64748b", "NOTE")}
    if checks:
        h.append('<table cellspacing="0" cellpadding="5" class="tt">')
        for i, c in enumerate(sorted(checks, key=lambda x: ["blocker", "warn", "note"].index(x["severity"]))):
            col, lbl = sev.get(c["severity"], ("#64748b", "NOTE"))
            tr = "<tr>" if i % 2 == 0 else '<tr class="z">'
            h.append(f'{tr}<td width="66"><b style="color:{col}">{lbl}</b></td>'
                     f'<td width="120" style="color:#555">{esc(c["area"])}</td>'
                     f'<td>{esc(c["finding"])} '
                     f'<span style="color:#666"><i>{esc(c["effect"])}</i></span></td></tr>')
        h.append("</table>")
    else:
        h.append('<div style="font-size:12px;color:#166534">'
                 "Automated integrity checks found nothing to flag.</div>")

    if (ai or {}).get("changes"):
        h.append('<div style="font-size:11px;color:#1a3c6e;'
                 'font-weight:700;text-transform:uppercase;margin:10px 0 2px">'
                 "Suggested improvements to this report</div>"
                 '<ol style="margin:0 0 2px 18px;'
                 'font-size:12.5px;line-height:1.5;color:#1f2937">'
                 + "".join(f"<li>{_rich(x)}</li>" for x in ai["changes"]) + "</ol>"
                 '<div style="font-size:10.5px;color:#888;'
                 'margin-top:3px">Suggestions only. The AI cannot change any figure in this '
                 "report &mdash; every number above is computed in code, and the AI sees the same "
                 "output you do.</div>")
    h.append("</div>")
    return "".join(h)


def render(payload: Dict[str, Any], hours: int, core=None, options=None,
           ledger_note: str = "") -> str:
    """The whole email."""
    rows = payload["rows"]
    desk = payload["desk"]
    label = (f"last {hours} hours" if hours < 48 else
             f"last {round(hours / 24)} days" if hours < 24 * 60 else
             f"last {round(hours / 720)} months")

    opts = options or {}
    narr: Dict[str, Any] = {}
    if core is not None and opts.get("ai_summary", True):
        narr = narratives(payload, hours, core, opts)
    # The report checks itself every run: deterministic checks always, plus an AI review of the
    # figures unless it is explicitly switched off on the schedule.
    checks = integrity_checks(payload, hours)
    ai_audit: Dict[str, Any] = {}
    if core is not None and opts.get("ai_audit", True):
        ai_audit = audit(payload, checks, hours, opts)

    h = ['<!DOCTYPE html><html><head><meta charset="utf-8">'
         '<meta name="viewport" content="width=device-width,initial-scale=1">'
         f"<style>{HEAD_CSS}</style></head><body>",
         '<div style="max-width:1100px">',
         '<div style="font-size:20px;font-weight:700;'
         'color:#1a3c6e;border-bottom:3px solid #1a3c6e;padding-bottom:6px">'
         "Technician Productivity Analysis</div>",
         f'<div style="font-size:12.5px;color:#555;'
         f'margin:6px 0 12px">{esc(label.capitalize())} &middot; '
         f'{desk["techs"]} technician(s) with ticket activity &middot; '
         f'complexity, time, AI collaboration and phone work, per person. '
         f'Every scale runs 1&ndash;5.</div>']

    if narr.get("__desk__"):
        h.append('<div style="border:1px solid #d8dee7;border-left:4px solid #166534;'
                 'background:#f7fbf8;padding:13px 17px;margin:0 0 14px">'
                 '<div style="font-size:11px;color:#166534;'
                 'text-transform:uppercase;font-weight:700;margin-bottom:4px">The desk overall</div>'
                 '<div style="font-size:13.5px;line-height:1.6;'
                 f'color:#1f2937">{narr["__desk__"]}</div></div>')
    elif narr.get("__error__"):
        h.append('<div style="font-size:12.5px;color:#92400e;'
                 'background:#fffbeb;border:1px solid #fcd34d;padding:10px;margin-bottom:12px">'
                 f'AI narrative unavailable ({esc(narr["__error__"])}). All figures below are '
                 "computed locally and are unaffected.</div>")

    h.append('<div style="font-size:11px;color:#888;margin:0 0 10px">'
             "This report lists <b>every</b> ticket each technician completed, so it is long by "
             "design. If your mail client truncates it, the complete report is also attached to "
             "this email as an HTML file &mdash; open that and nothing is missing.</div>")
    h.append(_cards(desk, payload))
    h.append(_audit_html(checks, ai_audit))
    h.append(_provenance(payload, hours))
    h.append(_scorecard(rows))

    if desk.get("team_unanswered_calls"):
        h.append('<div style="font-size:12px;color:#555;'
                 'margin:10px 0 0">'
                 f'<b>Team-wide:</b> {desk["team_unanswered_calls"]} inbound call(s) rang the desk '
                 "and nobody answered. Inbound rings every extension at once, so this belongs to "
                 "the team, not to any individual.</div>")

    h.append('<h3 style="font-size:15px;color:#1a3c6e;'
             'margin:26px 0 0">Technician by technician</h3>')
    for r in sorted(rows, key=lambda x: -(x["overall_absolute"] or 0)):
        h.append(_tech_block(r, narr.get(r["name"], "")))

    h.append(
        '<div style="font-size:11px;color:#888;margin-top:26px;'
        'border-top:1px solid #e3e8ef;padding-top:8px">'
        "<b>How this is calculated.</b> <u>Complexity 1&ndash;5</u> is the higher of two readings: "
        "subject matter (security incidents and server builds rate 5; password resets and how-to "
        "questions rate 2; clean automated alerts rate 1) and effort evidence (message count, "
        "people involved, elapsed time). Taking the maximum is deliberate &mdash; a breach solved "
        "in one message was still hard, and a printer that took nine messages and three people "
        "was also hard. <u>Time</u> comes from the work ledger: attention measured from AI chat "
        "transcripts, ticket message bursts and RMM activity, refreshed immediately before this "
        "report ran"
        + (f" ({esc(ledger_note)})" if ledger_note else "") +
        ". <u>Phone</u> comes from the FusionPBX CDR database, read-only: outbound is attributed "
        "by caller-ID name, inbound by the answering extension, duplicate queue-recorded legs are "
        "removed, internal extension-to-extension calls are excluded, and unanswered inbound is "
        "counted for the team rather than blamed on individuals. <u>Absolute scores</u> compare "
        "against fixed standards; <u>relative scores</u> compare against this desk's own median, "
        "so 3 is average here by construction. <b>What none of it can see:</b> on-site visits, "
        "project work, meetings, vendor calls on a mobile, and anything done outside the helpdesk, "
        "the AI, RMM and the phone system. These figures are a floor and a conversation starter, "
        "not a performance verdict. Every ticket reference links straight to the ticket.</div></div>"
        "</body></html>")
    return "".join(h)
