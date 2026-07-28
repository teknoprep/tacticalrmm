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

# WHAT MAKES A TICKET HARD - and what does not.
#
# The first version of this rated a ticket on the HIGHER of "subject matter" and "effort
# evidence", where effort evidence meant message count, number of participants and elapsed time.
# Reviewed against real tickets, that was plainly wrong in both directions:
#
#   * "Tony's Apple ID" scored 4/5 - thirteen messages and six people. It is a password-tier task
#     that generated a lot of email. Chatter is COORDINATION FRICTION, not technical difficulty.
#   * "Appointment Request" scored 4/5 for the same reason. It is a scheduling message.
#   * "[SQL Performance] SQL25-1 - High-impact missing indexes on Sage 100" scored 3/5, and
#     "[Hardware] FBAG pve245 - NVMe boot disk reporting recurring media/read errors" scored 3/5.
#     Index tuning on a live ERP and a failing hypervisor boot disk are specialist work.
#   * "Proxmox Backup Report - 2026-07-25" scored 5/5 off a single automated message, because the
#     word "Proxmox" appeared. A machine posting a clean report is not work at all.
#   * "Network Scan for Cyber Insurance Renewal" scored 1/5.
#
# So the model changed shape. Message volume is REMOVED from complexity entirely and reported on
# its own axis as coordination load. Complexity is now driven by the skill the work required,
# with evidence-based adjustments:
#
#   tier      what class of work is this, from a precise taxonomy (the dominant term)
#   + rarity  is this work only one person on this desk actually does? (computed, not assumed -
#             this is the "only Chris can do that" signal, and it also exposes key-person risk)
#   + depth   did someone actually get their hands on a machine, or was it all conversation?
#   + scope   does it hit a whole site, production, or many users?
#   + reopen  did it come back?
#
# Automated noise is caught FIRST and cannot be promoted by keywords: a clean report is tier 1
# however much infrastructure vocabulary it contains, while the same subject carrying a fault is
# rated on the fault.

# A machine-generated message: recurring report shapes this desk actually receives.
RE_MACHINE = re.compile(
    r"(vzdump|backup status|backup report|proxmox backup report|zfs|\bsmart\b report|"
    r"weekly .{0,20}(review|report|summary)|daily .{0,20}(report|summary)|"
    r"report - \d{4}-\d{2}-\d{2}|status:|health ?check)", re.I)
# Words that mean the machine is reporting a PROBLEM rather than a clean run.
RE_FAULT = re.compile(
    r"(fail(ed|ure|ing)?|error|critical|warning|\bdown\b|offline|detected|"
    r"issue|problem|degraded|exceeded|expired|stale|missing|corrupt|"
    r"not running|unreachable|denied|breach|full\b)", re.I)
RE_CLEAN = re.compile(
    r"(success(ful)?|completed|no (issues|findings|action)|healthy|\bok\b|"
    r"nothing to report|all good|passed)", re.I)

# (tier, category, human label, pattern). ALL rules are tested and the HIGHEST tier wins, so a
# ticket mentioning both a password and a domain controller is rated as domain-controller work.
WORK_TAXONOMY: List[Tuple[int, str, str, str]] = [
    # ---- 5: expert, high-risk, or business-stopping ----
    (5, "security_incident", "security incident",
     r"\b(hack(ed|ing)?|breach|compromis(e|ed|ing)|ransom ?ware|crypto ?lock(er)?|"
     r"exfiltrat|intrusion|brute ?force|account takeover|unauthori[sz]ed access|"
     r"unauthorised access|malware|trojan|rootkit|keylogger|impersonat|"
     r"user at risk|risky (user|sign-?in)|fraud(ulent)?|\bbec\b|"
     r"business email compromise|phishing (attack|campaign)|spoof(ed|ing))\b"),
    (5, "outage", "production outage",
     r"(\b(is |are |site |server |network |everything )?down\b|outage|"
     r"\boffline\b|entire (office|site|network|company)|all (users|staff|employees)|"
     r"everyone (is|can'?t|cannot)|nobody can|no one can|business stopped|"
     r"cannot work|can'?t work at all)"),
    (5, "infra_project", "server / infrastructure project",
     r"\b(domain controller|\bdc\b promotion|active directory (migration|forest|"
     r"domain) |forest|hyper-?v (host|cluster|setup)|esxi|vmware|vcenter|"
     r"proxmox (cluster|node|host|ve\b)|hypervisor|decomission|decommission|"
     r"new server (build|setup|install)|server (build|rebuild|migration)|"
     r"migrat(e|ion|ing) (server|domain|tenant|mailboxes|data)|cutover|"
     r"failover|\bcluster\b|\bsan\b|\braid\b|storage array|"
     r"bare ?metal|disaster recovery|\bdr\b test)\b"),
    (4, "server_admin", "server administration",
     r"(\bservers?\b[ -]{0,3}(upgrade|update|patch|maintenance|reboot|restart|migration|"
     r"build|rebuild|install|setup|config|provision|down|offline|issue|problem|error|"
     r"fail|crash|hang)|"
     r"(upgrade|patch|update|maintenance|reboot|restart|rebuild|provision|configure|"
     r"assess|audit)"
     r"[ -]{0,3}(the )?\bservers?\b|"
     r"\bhost\b (down|offline|reboot|maintenance)|windows server \d)"),
    (5, "data_recovery", "data loss / recovery",
     r"(data loss|lost (all )?data|database (corrupt|recovery)|corrupt(ed|ion) "
     r"(database|volume|array)|restore (the )?(server|database|domain))"),
    # ---- 4: advanced / specialist, bounded in scope ----
    (4, "server_hardware", "server hardware fault",
     r"(\bnvme\b|boot disk|\bssd\b (fail|error)|disk (fail|error|dying)|"
     r"\bhdd\b|hard (disk|drive) (fail|error)|drive fail(ure|ing|s)?|"
     r"smart (error|fail|warning)|media (error|read error)|read errors?|"
     r"degraded (array|raid|pool)|power supply|\bpsu\b|controller fail(ure)?|"
     r"memory (error|fault)|\becc\b error|overheat)"),
    (4, "database", "database / ERP performance",
     r"(\bsql\b|mssql|sql server|\bdatabase\b|missing index|index(es)? "
     r"(opportunit|recommend)|query (plan|performance)|deadlock|"
     r"mas ?90|mas_?fbi|sage ?100|\berp\b|quickbooks (server|database)|"
     r"table scan|tempdb)"),
    (4, "rds_vdi", "RDS / terminal services",
     r"(\brds\b|remote desktop (services|licensing|gateway)|terminal server|"
     r"session host|rd licensing|licensing grace|thin client|citrix|"
     r"published (app|desktop)|remote app)"),
    (4, "directory", "directory / identity infrastructure",
     r"(group polic|\bgpo\b|active directory|\bad\b (user|group|ou\b|sync)|"
     r"\bdns\b (zone|record|server|resolution)|dhcp (scope|server)|"
     r"kerberos|\bldap\b|sysvol|ad ?connect|replication|\bou\b structure|"
     r"trust relationship|secure channel)"),
    (4, "m365_tenant", "M365 / mail infrastructure",
     r"(tenant|exchange online|mail ?flow|\bspf\b|\bdkim\b|\bdmarc\b|"
     r"mx record|mailbox (migration|move)|conditional access|\bentra\b|"
     r"azure ad|smtp relay|mail (not )?(routing|delivery)|"
     r"quarantine|transport rule|journal)"),
    (4, "network_infra", "network infrastructure",
     r"(firewall|fortigate|forti ?os|sonicwall|meraki|pfsense|"
     r"\bvlan\b|subnet|\bbgp\b|\bospf\b|\bvpn\b|openvpn|ipsec|site-?to-?site|"
     r"\bwi-?fi\b|\bwireless\b|\bssid\b|"
     r"\bswitch\b|switch stack|\bstp\b|spanning tree|trunk port|"
     r"wireless (controller|infrastructure)|access point|\bap\b (issue|down|"
     r"offline)|\bptp\b|backhaul|\buisp\b|ubiquiti|unifi|"
     r"packet loss|latency|jitter|throughput|bandwidth|"
     r"certificate|\bssl\b|\btls\b|public ip|port forward|\bnat\b)"),
    (4, "backup_fault", "backup / replication fault",
     r"(backup (fail|error|issue|problem|missed|not running)|"
     r"vzdump.{0,40}(fail|error)|veeam.{0,30}(fail|error)|"
     r"replication (fail|error|behind)|no recent (backup|restore point)|"
     r"backup configuration)"),
    (4, "security_hardening", "security assessment / hardening",
     r"(security (audit|scan|assessment|finding|review)|vulnerabilit|"
     r"\bcve-|pen ?test|penetration test|hardening|cis benchmark|"
     r"antivirus exclusion|\bav\b exclusion|\bedr\b|defender (policy|exclusion)|"
     r"cyber (insurance|liability)|compliance (scan|review)|"
     r"windows update (service )?(disabled|stale|failing))"),
    (4, "automation", "monitoring / automation build",
     r"(monitoring (solution|system|setup)|build (a |an )?(monitor|dashboard|report|"
     r"alert)|alerting|\bscript(ing)?\b|\bapi\b integration|automat(e|ion)|"
     r"powershell|\bcron\b|scheduled task|webhook|\brmm\b (policy|script))"),
    (4, "fleet_project", "fleet-wide assessment / rollout",
     r"(all (machines|computers|workstations|devices|pcs)|fleet|"
     r"windows 11 (compatib|readiness|upgrade)|company-?wide|"
     r"roll ?out|deployment|inventory (audit|review)|refresh (project|cycle))"),
    # ---- 3: standard technical break/fix ----
    (3, "workstation", "workstation / application fix",
     r"(printer|print(ing|er) (queue|spooler)|scanner|scan to|driver|"
     r"blue ?screen|\bbsod\b|crash(es|ing)?|freez(e|es|ing)|hang(s|ing)?|"
     r"\bslow\b|performance|profile (corrupt|issue|roaming)|mapped drive|"
     r"network (drive|share)|share permission|folder permission|"
     r"outlook|\boffice\b|excel|\bword\b|onedrive|sharepoint (sync|library)|"
     r"\bteams\b|adobe|acrobat|\binstalls?\b|installing|installation|reinstall|"
     r"re-?image|imaging|portal (error|issue|access|down)|"
     r"new (laptop|pc|workstation|computer|machine)|"
     r"docking station|\bdock\b|\bmonitors?\b|\busb\b|keyboard|mouse|webcam|headset|"
     r"laptop|desktop|workstation|\bpc\b)"),
    (3, "disk_space", "disk space / cleanup",
     r"(disk space|drive .{0,12}full|\bc:\s*drive|low (disk|space)|"
     r"storage full|cleanup|clean ?up)"),
    (3, "voip_user", "VoIP / telephony (user level)",
     r"(\bvoip\b|\bpbx\b|\bsip\b|extension \d|\bext\b \d|voicemail|"
     r"\bphones?\b|phone (number|system|line|call)|not connecting|"
     r"\bivr\b|auto ?attendant|\bdid\b|call quality|one-?way audio|"
     r"dial ?plan|ring group|\bfax(es|ing)?\b|call forward|caller id|"
     r"after-?hours (routing|message)|holiday (message|greeting))"),
    (3, "email_user", "email / mailbox (user level)",
     r"(\bemails?\b|not receiving email|email (not )?(sending|receiving|delivered)|"
     r"bounce|undeliverable|junk (folder|mail)|spam filter|"
     r"mailbox full|archive|retention|shared mailbox (access|permission)|"
     r"calendar (share|permission|sync))"),
    # ---- 2: routine account and administrative tasks ----
    (2, "account_access", "account / access task",
     r"(password|\breset\b|unlock|locked out|\bmfa\b|\b2fa\b|"
     r"apple ?id|icloud|google account|"
     r"new (user|hire|employee|starter)|on-?board|off-?board|"
     r"disable (user|account)|terminate|distribution (list|group)|"
     r"email signature|out of office|auto ?reply|forward(ing)? (email|mail)|"
     r"\balias\b|licen[cs]e (assign|add|request)|add .{0,25}to .{0,25}group|"
     r"access to .{0,24}(folder|share|drive|mailbox|system|portal|site|app)|"
     r"\bpermissions?\b|permission to)"),
    (2, "request_admin", "request / scheduling / info",
     r"(how (do|can) i|how to|\bquestion\b|please (add|send|provide|update|change)|"
     r"appointment|schedul(e|ing)|availabilit|training|inquir|"
     r"\bquote\b|pricing|\border\b|purchase|\bpo\b \d|"
     r"equipment (return|pickup|disposal)|decommissioned .{0,20}equipment|"
     r"\brenewal\b|contract|invoice)"),
    # ---- 1: automated noise and non-technical ----
    (1, "junk", "junk / non-IT",
     r"(unsubscribe|newsletter|marketing|webinar|promotion|"
     r"sales (enquiry|inquiry|call)|cold call|partnership opportunity)"),
]

_COMPILED_TAXONOMY = [(tier, cat, label, re.compile(pat, re.I))
                      for tier, cat, label, pat in WORK_TAXONOMY]

TIER_WORDS = {1: "no real work / automated", 2: "routine task", 3: "standard technical",
              4: "advanced / specialist", 5: "expert or business-critical"}

RE_SCOPE = re.compile(
    r"(all (users|staff|machines|computers|devices|employees)|"
    r"entire (office|site|network|company|building)|everyone|multiple (users|people|sites)|"
    r"whole (office|site|company)|site-?wide|company-?wide|"
    r"\bproduction\b|business critical|mission critical)", re.I)


def classify_work(ticket: Dict[str, Any]) -> Dict[str, Any]:
    """What KIND of work is this, and what skill tier does it sit at? No effort signals here.

    Returns the highest-tier match across the whole taxonomy, so the hardest thing mentioned is
    what the ticket is about. Machine-generated messages are resolved first, because otherwise
    their vocabulary ("Proxmox", "backup", "SQL") drags routine noise up to expert tier.
    """
    subj = (ticket.get("subject") or "").strip()
    body = (ticket.get("body") or "")[:600]
    text = f"{subj} {body}"

    # Bracketed prefixes are this desk's own alert taxonomy and are strong, cheap signal.
    prefix = ""
    m = re.match(r"^\s*\[([^\]]{2,30})\]", subj)
    if m:
        prefix = m.group(1).strip().lower()

    machine = bool(RE_MACHINE.search(subj)) or prefix in (
        "success", "warning", "alert", "hardware", "disk space", "sql performance",
        "performance", "networking", "security audit", "rds", "backup")
    fault = bool(RE_FAULT.search(text))
    clean = bool(RE_CLEAN.search(subj)) and not fault

    # A machine reporting a clean run is not work, whatever words it contains.
    if machine and clean:
        return {"tier": 1, "category": "automated_ok", "label": "automated report, nothing wrong",
                "machine": True, "fault": False}

    # Categories judged on the SUBJECT ALONE. An outage is announced in the subject line; a
    # customer writing "the internet was down yesterday" in the body of a routine request is not
    # reporting one, and letting body text reach tier 5 made a monitoring-build ticket read as a
    # production outage.
    subject_only = {"outage"}
    best = (0, "", "")
    for tier, cat, label, rx in _COMPILED_TAXONOMY:
        haystack = subj if cat in subject_only else text
        if tier > best[0] and rx.search(haystack):
            best = (tier, cat, label)
    # PRECEDENCE: building something that watches for outages is a project, not an outage.
    # "Build monitoring solution to pinpoint intermittent internet drops and site down events"
    # matched both, and taking the maximum rated a planned piece of engineering as a live
    # emergency. The same applies to fleet rollouts that mention machines being down.
    if best[1] == "outage":
        for tier, cat, label, rx in _COMPILED_TAXONOMY:
            if cat in ("automation", "fleet_project") and rx.search(text):
                best = (4, cat, label)
                break

    if best[0]:
        tier, cat, label = best
    elif machine and fault:
        tier, cat, label = 3, "machine_fault", "automated alert with a fault"
    elif machine:
        tier, cat, label = 1, "automated_ok", "automated report"
    elif not subj:
        tier, cat, label = 1, "unknown", "no subject"
    else:
        tier, cat, label = 2, "unclassified", "unclassified request"

    # A machine alert that nobody could classify above tier 2 is still a real fault to chase.
    if machine and fault and tier < 3:
        tier, cat, label = 3, "machine_fault", "automated alert with a fault"
    return {"tier": tier, "category": cat, "label": label, "machine": machine, "fault": fault}


def coordination_1_5(ticket: Dict[str, Any]) -> Dict[str, Any]:
    """How much CHASING did this take? Message volume, people involved, elapsed time.

    Its own axis, deliberately. This is what used to contaminate the complexity rating: real work
    and endless email are both expensive, but they are different problems with different fixes,
    and averaging them into one number hid both.
    """
    events = ticket.get("events") or []
    msgs = len(events)
    participants = len({e.get("actor") for e in events})
    times = sorted([t for t in (_parse(e.get("at")) for e in events) if t])
    span_h = (times[-1] - times[0]).total_seconds() / 3600.0 if len(times) >= 2 else 0.0

    score = 1
    if msgs >= 4 or participants >= 3:
        score = 2
    if msgs >= 8 or participants >= 4 or span_h >= 48:
        score = 3
    if msgs >= 14 or participants >= 5 or span_h >= 120:
        score = 4
    if msgs >= 22 or participants >= 6 or span_h >= 240:
        score = 5
    bits = [f"{msgs} messages", f"{participants} people"]
    if span_h >= 24:
        bits.append(f"{round(span_h / 24, 1)} days")
    return {"score": score, "why": ", ".join(bits), "msgs": msgs,
            "participants": participants, "span_hours": round(span_h, 1)}


def rate_tickets(tickets: List[Dict[str, Any]], tech_names: set,
                 hands_on_refs: Optional[set] = None) -> Dict[str, Any]:
    """Rate every ticket 1-5 for complexity, in three passes over the whole set.

    Rarity cannot be judged one ticket at a time - "only one person on this desk does this" is a
    fact about the desk, so the categories have to be counted first. That is the owner's point
    about work only one technician can do, and it is also how key-person risk becomes visible.
    """
    hands_on_refs = hands_on_refs or set()

    # Pass 1: what kind of work is each ticket, and how much chasing did it take.
    for t in tickets:
        w = classify_work(t)
        t["work"] = w
        t["coordination"] = coordination_1_5(t)

    # Pass 2: who handles each category across the desk.
    cat_closers: Dict[str, set] = {}
    cat_counts: Dict[str, int] = {}
    for t in tickets:
        cat = t["work"]["category"]
        cat_counts[cat] = cat_counts.get(cat, 0) + 1
        for actor in (t.get("actor_minutes") or {}):
            if actor in tech_names:
                cat_closers.setdefault(cat, set()).add(actor)

    # Categories that are real specialist ground: enough volume to be a pattern, but only one
    # person on the desk ever touches them.
    specialist_cats = {c for c, who in cat_closers.items()
                       if len(who) == 1 and cat_counts.get(c, 0) >= 2
                       and c not in ("automated_ok", "junk", "unknown", "unclassified")}

    # Pass 3: final complexity.
    for t in tickets:
        w = t["work"]
        tier = w["tier"]
        reasons = [w["label"]]
        boosts = 0

        cat = w["category"]
        if cat in specialist_cats and tier >= 3:
            boosts += 1
            reasons.append(f"only one tech on this desk handles {w['label']}")
        if t.get("ref") in hands_on_refs and tier >= 2:
            boosts += 1
            reasons.append("hands-on device work, not just correspondence")
        if RE_SCOPE.search(f'{t.get("subject") or ""} {(t.get("body") or "")[:400]}') and tier >= 2:
            boosts += 1
            reasons.append("affects a whole site or production")
        if t.get("reopened"):
            boosts += 1
            reasons.append("reopened")

        # Noise stays noise however it is decorated.
        score = 1 if cat in ("automated_ok", "junk") else min(5, tier + min(2, boosts))
        t["cx5"] = int(max(1, score))
        t["cx5_why"] = ", ".join(reasons[:3])
        t["cx5_tier"] = tier
        t["cx5_category"] = cat
        t["cx5_specialist"] = cat in specialist_cats
        t["coord5"] = t["coordination"]["score"]
        t["coord_why"] = t["coordination"]["why"]

    return {"specialist_categories": sorted(specialist_cats),
            "category_closers": {c: sorted(w) for c, w in cat_closers.items()},
            "category_counts": cat_counts}


def ticket_hands_on_refs(hours: int) -> set:
    """Tickets where somebody actually worked on a machine, from the ledger.

    Distinguishes "solved it" from "talked about it", which no amount of subject-line parsing can.
    """
    from django.utils import timezone as djangotime

    from core.models import TicketWorkEntry

    since = djangotime.now() - timedelta(hours=max(1, int(hours or 24)))
    return set(TicketWorkEntry.objects
               .filter(started_at__gte=since, superseded_by=None,
                       surface__in=("rmm_activity", "device_chat"))
               .exclude(ticket_ref="")
               .values_list("ticket_ref", flat=True))


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


# Units for the measured values, so the figures table can be read without decoding field names.
UNITS = {
    "throughput": "closed per active day",
    "complexity": "avg difficulty, 1-5",
    "efficiency": "minutes per complexity point",
    "ai_leverage": "% of their time with the AI",
    "documentation": "internal notes per ticket",
    "communication": "median minutes to first reply",
    "autonomy": "% of closes handled alone",
    "phone": "talk minutes per active day",
}

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

    tech_names = set(names)
    # Rate every ticket 1-5 once, up front: several people can touch one ticket and the rating
    # must be identical wherever it appears. Needs the whole set at once, because "only one person
    # on this desk does this kind of work" is a fact about the desk, not about a ticket.
    rating = rate_tickets(tickets, tech_names, hands_on_refs=ticket_hands_on_refs(hours))
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
        # WORK ONLY THIS PERSON DOES. The owner's point: some of what a senior tech handles is not
        # merely hard, it is unshared - which is both a strength and a key-person risk, and neither
        # is visible if it is averaged into a complexity number.
        specialist = [t for t in touched if t.get("cx5_specialist")]
        spec_cats = sorted({t["work"]["label"] for t in specialist})
        coord_heavy = [t for t in touched if (t.get("coord5") or 0) >= 4]

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
            "specialist_tickets": len(specialist),
            "specialist_areas": spec_cats,
            "coordination_heavy": len(coord_heavy),
            "avg_coordination": round(sum(t.get("coord5") or 1 for t in touched)
                                      / max(1, len(touched)), 2),
            "work_mix": dict(sorted(
                ((t["work"]["label"], sum(1 for x in touched
                                          if x["work"]["label"] == t["work"]["label"]))
                 for t in touched), key=lambda kv: -kv[1])),
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
            # Two different denominators, because they answer two different questions. People do
            # work at weekends, so "days active" is out of ALL days in the window; an unaccounted
            # day is only meaningful on a working day, since a quiet Saturday is not a finding.
            # Using the weekday count for both produced the nonsense "active 27 of 21".
            "days_in_window": len(window_days),
            "working_days_in_window": sum(1 for d in window_days if d.weekday() < 5),
            "active_days": len(active_days),
            "active_day_list": sorted(d.isoformat() for d in active_days),
            "dormant_days": dormant,
            "closed_tickets": [
                {"ref": t.get("ref"), "url": t.get("url"), "subject": (t.get("subject") or "")[:90],
                 "company": t.get("company") or "", "stage": t.get("stage") or "",
                 "closed_at": t.get("last_activity") or "", "cx5": t["cx5"], "cx5_why": t["cx5_why"],
                 "work": t["work"]["label"], "coord5": t.get("coord5"),
                 "specialist": bool(t.get("cx5_specialist")),
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
                 "work": t["work"]["label"], "coord5": t.get("coord5"),
                 "specialist": bool(t.get("cx5_specialist")),
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
    desk["specialist_categories"] = rating["specialist_categories"]
    desk["specialist_owners"] = {c: rating["category_closers"].get(c, [])
                                 for c in rating["specialist_categories"]}
    return {"rows": rows, "desk": desk, "pbx": pbx, "rating": rating,
            "ai_worker": ai_worker(data, tickets, actors, tech_names, by_ref, rating, desk),
            "phone_ok": bool(phone.get("ok")),
            "phone_error": phone.get("error", ""),
            "phone_dedup_dropped": phone.get("dedup_dropped", 0),
            "window_days": days_in_window}


def ai_worker(data: Dict[str, Any], tickets: List[Dict[str, Any]], actors: Dict[str, Any],
              tech_names: set, by_ref: Dict[str, Any], rating: Dict[str, Any],
              desk: Dict[str, Any]) -> Dict[str, Any]:
    """The AI's own workload, reported in a HUMAN time frame.

    The owner's requirement: if the AI is credited with work, that has to be visible, and the
    time has to be expressed in the same units a person's time is - even though the machine
    finishes in seconds what takes a person half an hour.

    HOW THE TIME FIGURE IS BUILT. The AI's minutes come from the SAME estimator used for every
    technician in this report (`_dr_estimate`: message bursts grouped into sessions, priced at
    this desk's own minutes-per-message, then multiplied by the ticket's 1-5 complexity). So the
    headline number answers one question only: **what this desk's own time model would have
    charged a person for the work the AI actually did.** It is a HUMAN-EQUIVALENT figure, not a
    claim about how long the machine ran - and it is labelled that way everywhere it appears.

    Wall-clock elapsed is reported beside it, measured from the AI's own first-to-last action
    within each burst. The ratio of the two is the leverage multiple, which is the honest way to
    show "quicker than a human" without making the contribution look small.
    """
    ai_actors = [a for a in actors.values() if a.get("kind") == "ai"]
    if not ai_actors:
        return {"present": False}

    names = sorted(a["name"] for a in ai_actors)
    equiv_minutes = round(sum(a["minutes"] for a in ai_actors), 1)
    sessions = sum(a.get("sessions", 0) for a in ai_actors)
    refs = set()
    for a in ai_actors:
        refs |= set(a.get("tickets") or set())
    worked = [by_ref[r] for r in refs if r in by_ref]

    # Wall-clock the AI actually occupied: its own event bursts per ticket, 30-minute gap (the
    # same session boundary the human estimator uses), summed. Measured, not modelled.
    elapsed = 0.0
    for t in worked:
        times = sorted(_parse(e.get("at")) for e in (t.get("events") or [])
                       if e.get("kind") == "ai" and _parse(e.get("at")))
        if not times:
            continue
        start = prev = times[0]
        for cur in times[1:]:
            if (cur - prev).total_seconds() > 30 * 60:
                elapsed += (prev - start).total_seconds() / 60.0
                start = cur
            prev = cur
        elapsed += (prev - start).total_seconds() / 60.0

    # AUTONOMOUS vs DIRECTED. A ticket the AI worked with no technician's time on it at all is
    # work the desk did not have to touch; one with a person's time on it is collaboration, and
    # that person is already credited in their own scorecard.
    autonomous = [t for t in worked
                  if not {n for n in (t.get("actor_minutes") or {}) if n in tech_names}]
    collaborative = [t for t in worked if t not in autonomous]
    auto_minutes = round(sum((t.get("ai_minutes") or 0) for t in autonomous), 1)

    closed_auto = [t for t in autonomous if t.get("terminal")]
    closed_collab = [t for t in collaborative if t.get("terminal")]
    cx = [t["cx5"] for t in worked if t.get("cx5")]
    cx_auto = [t["cx5"] for t in autonomous if t.get("cx5")]

    # Human-directed AI messages: the person composed the intent, the machine typed it. Counted
    # here for transparency, but the CREDIT for those sits with the technician, not the AI.
    directed_msgs = sum(int(t.get("driven_messages") or 0) for t in worked)
    ai_msgs = sum(int(t.get("ai_messages") or 0) for t in worked)

    human_minutes = desk.get("minutes") or 0.0
    return {
        "present": True,
        "names": names,
        "equiv_minutes": equiv_minutes,
        "elapsed_minutes": round(elapsed, 1),
        "leverage_x": (round(equiv_minutes / elapsed, 1) if elapsed >= 1 else None),
        "sessions": sessions,
        "tickets_worked": len(worked),
        "tickets_autonomous": len(autonomous),
        "tickets_collaborative": len(collaborative),
        "closed_autonomous": len(closed_auto),
        "closed_collaborative": len(closed_collab),
        "autonomous_equiv_minutes": auto_minutes,
        "avg_complexity": round(statistics.mean(cx), 2) if cx else 0,
        "avg_complexity_autonomous": round(statistics.mean(cx_auto), 2) if cx_auto else 0,
        "ai_messages": ai_msgs,
        "directed_messages": directed_msgs,
        # How the AI's human-equivalent workload compares with the desk's measured human time.
        "pct_of_desk_human_time": (round(100.0 * equiv_minutes / human_minutes, 1)
                                   if human_minutes else None),
        "companies": sorted({t.get("company") for t in worked if t.get("company")}),
        "top_autonomous": [
            {"ref": t.get("ref"), "url": t.get("url") or "", "subject": t.get("subject") or "",
             "company": t.get("company") or "", "stage": t.get("stage") or "",
             "cx5": t.get("cx5"), "equiv_minutes": round(t.get("ai_minutes") or 0, 1)}
            for t in sorted(autonomous, key=lambda x: -(x.get("ai_minutes") or 0))[:25]
        ],
    }


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
     [40, 60, 80, 92], True, "Share of their closes they handled without another tech stepping in."),
    ("phone", "Phone engagement", "talk_minutes_per_active_day",
     [5, 20, 45, 90], True,
     "Talk time per active day - inbound answered plus outbound, so any window compares."),
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
        # Rate the daily habit, not the size of the window: total talk time scored every
        # technician 5/5 over a month while discriminating fine over a week.
        talk = (r["phone"] or {}).get("talk_minutes", 0.0) if r["phone"] else None
        r["talk_minutes_total"] = talk
        r["talk_minutes_per_active_day"] = (round(talk / max(1, r["active_days"]), 1)
                                            if talk is not None else None)
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

    # If a large share of tickets cannot be classified, every complexity-derived number is soft.
    unc = 0
    tot_t = 0
    for r in rows:
        for t in r["closed_tickets"] + r["open_ticket_list"]:
            tot_t += 1
            if t.get("work") in ("unclassified request", "no subject"):
                unc += 1
    if tot_t and round(100.0 * unc / tot_t) >= 25:
        out.append({"severity": "warn", "area": "complexity",
                    "finding": f"{round(100.0 * unc / tot_t)}% of tickets ({unc} of {tot_t}) have "
                               f"subjects too vague to classify (\"IT stuff\", \"Service Laptop\") "
                               f"and default to a routine rating of 2/5.",
                    "effect": "Complexity is understated for whoever writes terse subjects. Better "
                              "ticket titles would improve this directly."})

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
            "complexity_1_5": "skill tier from a work taxonomy (security incident / outage / "
                              "infrastructure project = 5, specialist infrastructure = 4, standard "
                              "break-fix = 3, account tasks = 2, automated reports = 1), plus at "
                              "most +2 for: work only one tech on the desk handles, hands-on device "
                              "evidence in the ledger, whole-site or production impact, reopened. "
                              "Message volume is deliberately EXCLUDED - it is reported separately "
                              "as coordination_1_5, because chatter is not difficulty.",
            "coordination_1_5": "messages, participants and elapsed days. Reported on its own axis "
                                "so heavy chasing is never mistaken for technical difficulty.",
            "specialist_areas": "categories of work exactly one technician handled in the period "
                                "(minimum two tickets in the category). Expertise and key-person "
                                "risk in the same number.",
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
        if r.get("specialist_tickets"):
            good.append(f'{r["specialist_tickets"]} ticket(s) in work nobody else on the desk does '
                        f'({", ".join(r["specialist_areas"][:3])}) - real expertise, and a '
                        f'single point of failure worth spreading')
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
            gap.append(f'work is mostly low-complexity (avg {r["avg_complexity"]}/5) and none of it '
                       f'is specialist - the clearest development step is to pair them onto the '
                       f'harder categories (infrastructure, database, network, security) that '
                       f'currently sit with one person')
        if (r.get("avg_coordination") or 0) - (r.get("avg_complexity") or 0) >= 0.6:
            gap.append(f'their tickets take more chasing than they take skill (coordination '
                       f'{r["avg_coordination"]}/5 against complexity {r["avg_complexity"]}/5) - '
                       f'worth checking whether they are waiting on customers, or on us')
        if r.get("coordination_heavy", 0) >= 5 and (r.get("avg_coordination") or 0) >= 2.8:
            good.append(f'carried {r["coordination_heavy"]} ticket(s) with heavy coordination '
                        f'(many people, many days) - chasing work to a close is real effort even '
                        f'when the technical content is routine')
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
    """Desk headline figures. Fixed to four per row so they stay legible whether there are five
    of them or seven - a single stretched row of seven tiles was unreadable on a phone."""
    def card(value, label, sub="", cls=""):
        return (f'<td class="cd"><div class="cv {cls}">{value}</div>'
                f'<div class="cl">{label}</div><div class="cs">{sub or "&nbsp;"}</div></td>')

    cards = [
        card(desk["techs"], "technicians", "with ticket activity"),
        card(desk["tickets_closed"], "tickets closed", f'{desk["tickets_touched"]} touched'),
        card(f'{desk["avg_complexity"]}/5', "avg complexity", "across the desk"),
        card(fmt_mins(desk["minutes"]), "tech time", "measured, on tickets"),
        card(fmt_mins(desk["ai_collab_minutes"]), "with the AI",
             f'{round(100.0 * desk["ai_collab_minutes"] / max(1.0, desk["minutes"]))}% of tech time',
             "cg"),
    ]
    if payload.get("phone_ok"):
        cards.append(card(fmt_mins(desk["talk_minutes"]), "talk time", f'{desk["calls"]} calls'))
    if desk.get("dormant_day_count"):
        cards.append(card(desk["dormant_day_count"], "unaccounted days",
                          "open work, no activity", "ca"))
    h = ['<table cellspacing="0" cellpadding="0" class="cdt">']
    for i in range(0, len(cards), 4):
        row = cards[i:i + 4]
        h.append("<tr>" + "".join(row)
                 + '<td class="cd pad"></td>' * (4 - len(row)) + "</tr>")
    h.append("</table>")
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


def _rel_mark(score: Optional[int]) -> str:
    """The relative score as a direction plus a digit.

    A bare second number next to the absolute one was the readability problem: two pills in a
    cell with nothing saying which was which. An arrow states the direction against the desk at a
    glance, and the digit is still there for anyone who wants the detail.
    """
    if score is None:
        return '<span class="nn">&ndash;</span>'
    glyph, cls = {5: ("&#9650;", "up"), 4: ("&#9652;", "up"), 3: ("&#8211;", "eq"),
                  2: ("&#9662;", "dn"), 1: ("&#9660;", "dn")}[score]
    return f'<span class="{cls}">{glyph}&#8202;{score}</span>'


def _scorecard(rows: List[Dict[str, Any]]) -> str:
    """Two tables, deliberately: the scores, then the measurements they came from.

    The first version put the absolute score, the relative score and the raw measured value in
    one cell, eight times across a row - three numbers per cell with nothing labelling them, which
    read as scattered noise. Scales are now rows (they have names and definitions, so they need
    the width), technicians are columns, and each technician gets two fixed sub-columns: "std"
    against fixed standards, "desk" against this desk. Raw values move to their own table so a
    measurement is never mistaken for a score.
    """
    if not rows:
        return ""
    order = sorted(rows, key=lambda x: -(x["overall_absolute"] or 0))
    n = len(order)

    def name_head(r):
        ext = f'<div class="sub">ext {r["pbx"]["ext"]}</div>' if r.get("pbx") else ""
        return f'{esc(r["name"])}{ext}'

    h = ['<h3 class="h3">Scorecard</h3>',
         '<div class="note">Every scale runs <b>1&ndash;5, where 5 is best</b> (complexity is the '
         'one exception: there 5 means hardest, not best). <b>std</b> scores against fixed '
         'standards &mdash; is this good work, full stop. <b>desk</b> scores against this desk\'s '
         'own median &mdash; &#9650; above it, &#8211; on par, &#9660; below it. Both are shown '
         'because a small team can be uniformly strong or uniformly slipping, and only one of '
         'those two views notices.</div>',
         '<table cellspacing="0" cellpadding="0" class="sc">',
         '<colgroup><col width="34%">' + ('<col><col>' * n) + "</colgroup>",
         '<tr><th class="hd" rowspan="2">Scale</th>'
         + "".join(f'<th class="hd ctr" colspan="2">{name_head(r)}</th>' for r in order)
         + "</tr>",
         "<tr>" + "".join('<th class="hd2 ctr">std</th><th class="hd2 ctr">desk</th>'
                          for _ in order) + "</tr>"]

    for i, (key, label, _f, _t, _hi, why) in enumerate(DIMENSIONS):
        cls = "sr" if i % 2 == 0 else "sr z"
        h.append(f'<tr class="{cls}"><td class="sn"><b>{esc(label)}</b>'
                 f'<div class="sub">{esc(why)}</div></td>')
        for r in order:
            sc = r["scores"][key]
            inv = (key == "complexity")
            h.append(f'<td class="ctr sv">{_pill(sc["absolute"], invert=inv)}</td>'
                     f'<td class="ctr sv">{_rel_mark(sc["relative"])}</td>')
        h.append("</tr>")

    h.append('<tr class="sr tot"><td class="sn"><b>Overall</b>'
             '<div class="sub">mean of the scales above</div></td>')
    for r in order:
        if r.get("insufficient_data"):
            h.append('<td class="ctr sv" colspan="2"><b class="wh">withheld</b></td>')
        else:
            h.append(f'<td class="ctr sv"><b class="ov">{r["overall_absolute"]}</b></td>'
                     f'<td class="ctr sv"><b class="ov2">{r["overall_relative"]}</b></td>')
    h.append("</tr></table>")

    # The measurements, on their own, with units.
    h.append('<div class="note" style="margin-top:14px"><b>The measurements those scores come '
             'from.</b> Same scales, actual figures.</div>')
    h.append('<table cellspacing="0" cellpadding="0" class="sc">'
             '<colgroup><col width="34%">' + ("<col>" * n) + "</colgroup>"
             '<tr><th class="hd">Measurement</th>'
             + "".join(f'<th class="hd ctr">{esc(r["name"].split()[0])}</th>' for r in order)
             + "</tr>")
    for i, (key, label, _f, _t, _hi, _why) in enumerate(DIMENSIONS):
        cls = "sr" if i % 2 == 0 else "sr z"
        h.append(f'<tr class="{cls}"><td class="sn">{esc(label)}'
                 f'<div class="sub">{esc(UNITS.get(key, ""))}</div></td>')
        for r in order:
            v = r["scores"][key]["value"]
            txt = "&ndash;" if v is None else f"{v:g}" if isinstance(v, (int, float)) else esc(str(v))
            h.append(f'<td class="ctr mv">{txt}</td>')
        h.append("</tr>")
    h.append("</table>")

    flatd = (rows[0].get("_flat_dimensions") if rows else None) or []
    if flatd:
        h.append('<div class="warn"><b>No material spread on '
                 f'{esc(", ".join(flatd))}</b> &mdash; the desk is tightly clustered there, so '
                 'every "desk" score on those scales is 3 by rule, not by measurement. Read the '
                 '"std" column for those.</div>')
    if any(r.get("insufficient_data") for r in rows):
        who = ", ".join(esc(r["name"]) for r in rows if r.get("insufficient_data"))
        h.append(f'<div class="warn"><b>Overall score withheld for {who}</b> &mdash; fewer than '
                 f'{MIN_TICKETS_TO_SCORE} tickets or under {MIN_MINUTES_TO_SCORE} minutes of '
                 "recorded time in the period. Their individual figures are still shown, but they "
                 "cannot fairly be compared with a colleague who has a full week of recorded "
                 "work.</div>")
    return "".join(h)


def _ticket_rows(items: List[Dict[str, Any]], closed=True) -> str:
    """The per-technician ticket lists - every ticket, never truncated.

    Styled with CSS classes rather than inline attributes purely for weight: with inline styles
    this table alone pushed a week's report to 295KB, and Gmail clips a message at about 102KB -
    which would have hidden most of the ticket detail behind "view entire message" and quietly
    defeated the requirement that all of it be in the email. A monthly run is several hundred
    rows, so this has to scale.
    """
    cols = (["84", "", "116", "128", "26", "26", "50", "48", "24", "86"] if closed
            else ["84", "", "116", "128", "26", "26", "50", "84", "86"])
    h = ['<table cellspacing="0" cellpadding="4" class="tt">',
         "<colgroup>" + "".join(f'<col width="{w}">' if w else "<col>" for w in cols) + "</colgroup>"]
    head = (["Ticket", "Subject", "Company", "Type of work", "Cx", "Co", "Time", "1st resp",
             "AI", "Closed"] if closed else
            ["Ticket", "Subject", "Company", "Type of work", "Cx", "Co", "Time", "Stage",
             "Last activity"])
    h.append("<tr>" + "".join(f"<th>{c}</th>" for c in head) + "</tr>")
    for i, t in enumerate(items):
        tr = "<tr>" if i % 2 == 0 else '<tr class="z">'
        link = f'<a href="{esc(t.get("url"))}" class="lk">{esc(t.get("ref"))}</a>'
        # A star marks work only this person on the desk does - the owner's "only Chris can do
        # that" made visible per ticket rather than buried in an average.
        work = esc(t.get("work") or "")
        if t.get("specialist"):
            work = f'<span class="spec" title="only one tech on this desk handles this">&#9733;</span> {work}'
        common = (f"{tr}<td>{link}</td>"
                  f'<td>{esc(t.get("subject"))}</td>'
                  f'<td>{esc((t.get("company") or "")[:24])}</td>'
                  f'<td class="wk">{work}</td>'
                  f'<td class="m">{_pill(t.get("cx5"), invert=True)}</td>'
                  f'<td class="m">{_pill(t.get("coord5"), invert=True)}</td>'
                  f'<td class="r">{fmt_mins(t.get("minutes"))}</td>')
        if closed:
            fr = t.get("first_response_min")
            h.append(common
                     + f'<td class="r">{fmt_mins(fr) if fr is not None else "&ndash;"}</td>'
                     + f'<td class="m">{"&#10003;" if t.get("ai") else ""}</td>'
                     + f'<td>{esc((t.get("closed_at") or "")[:16])}</td></tr>')
        else:
            h.append(common
                     + f'<td>{esc(t.get("stage"))}</td>'
                     + f'<td>{esc((t.get("last_activity") or "")[:16])}</td></tr>')
    h.append("</table>")
    return "".join(h)


def _tech_block(r: Dict[str, Any], narrative: str = "") -> str:
    """One technician's page: headline figures, their scores, their review, then their tickets.

    The figures are grouped into labelled sections - work, time, phone, communication - rather
    than one long row of twelve tiles. Twelve numbers in a strip with no grouping is the same
    readability failure as the old scorecard cells: everything present, nothing findable.
    """
    ph = r.get("phone") or {}

    def kv(label, value, note=""):
        return (f'<td class="k"><div class="kv">{value}</div><div class="kl">{label}</div>'
                + (f'<div class="kn">{note}</div>' if note else "") + "</td>")

    def group(title, cards):
        return (f'<tr><td class="gh" colspan="4">{title}</td></tr><tr>'
                + "".join(cards) + ("<td class='k pad'></td>" * (4 - len(cards))) + "</tr>")

    h = ['<div class="tb">',
         f'<div class="tn">{esc(r["name"])}'
         + (f'<span class="tx"> &mdash; extension {r["pbx"]["ext"]} '
            f'({esc(r["pbx"]["how"])})</span>' if r.get("pbx") else
            '<span class="tx" style="color:#b91c1c"> &mdash; no PBX match</span>')
         + ('<span class="to" style="color:#92400e">overall score withheld</span>'
            if r.get("insufficient_data") else
            f'<span class="to">overall <b>{r["overall_absolute"]}</b>/5 vs standards '
            f'&middot; <b>{r["overall_relative"]}</b>/5 vs desk</span>')
         + "</div>"]
    if r.get("coverage_note"):
        h.append(f'<div class="warn">{esc(r["coverage_note"])}.</div>')

    h.append('<table cellspacing="0" cellpadding="0" class="kt">')
    h.append(group("Work", [
        kv("closed", r["tickets_closed"],
           f'{r["tickets_touched"]} touched, {r["still_open"]} still open'),
        kv("avg complexity", f'{r["avg_complexity"]}/5',
           f'{r["hard_tickets_closed"]} hard one(s) closed'),
        kv("handled alone",
           f'{r["solo_closed_pct"]}%' if r["solo_closed_pct"] is not None else "n/a",
           f'{r["solo_closed"]} of {r["tickets_closed"]} closes'),
        kv("active days", f'{r["active_days"]} of {r["days_in_window"]}',
           f'{len(r["dormant_days"])} working day(s) unaccounted' if r["dormant_days"]
           else "nothing unaccounted"),
    ]))
    h.append(group("Time", [
        kv("on tickets", fmt_mins(r["minutes"]),
           (f'{r["measured_share"]}% transcript-measured' if r["time_is_measured"]
            else "estimated from messages")),
        kv("avg per ticket", fmt_mins(r["avg_minutes_per_ticket"]),
           f'{fmt_mins(r["avg_minutes_per_closed"])} per close'
           if r["avg_minutes_per_closed"] else ""),
        kv("with the AI", fmt_mins(r["ai_collab_minutes"]),
           f'{r["ai_time_share_pct"]}% of their time &middot; {r["ai_driven_actions"]} actions'),
        kv("hands-on / RMM", fmt_mins(r["hands_on_minutes"]), "remote sessions, device work"),
    ]))
    if ph:
        h.append(group("Phone", [
            kv("talk time", fmt_mins(ph.get("talk_minutes")),
               f'{ph.get("calls_in", 0)} answered in, {ph.get("calls_out", 0)} out'),
            kv("avg call", fmt_mins(ph.get("avg_call_minutes")),
               f'longest {fmt_mins(ph.get("longest_call_minutes"))}'),
            kv("total accounted", fmt_mins(r["minutes_incl_phone"]), "tickets + phone"),
        ]))
    else:
        h.append(group("Phone", [kv("talk time", "n/a", "no PBX identity matched")]))
    fr = r["median_first_response_min"]
    h.append(group("Communication", [
        kv("1st response", fmt_mins(fr) if fr is not None else "n/a",
           "median, to the customer"),
        kv("replies written", r["replies_written"], f'avg {r["avg_reply_chars"]} chars'),
        kv("internal notes", r["notes_written"], f'{r["notes_per_ticket"]} per ticket'),
        kv("closed w/o reply", r["closed_without_reply"],
           "never wrote to the customer" if r["closed_without_reply"] else "none"),
    ]))
    h.append("</table>")

    # Their scores as a proper table: one scale per row, numbers in fixed columns.
    h.append('<table cellspacing="0" cellpadding="0" class="ms"><tr>'
             '<th class="hd2">Scale</th><th class="hd2 ctr">std</th>'
             '<th class="hd2 ctr">desk</th><th class="hd2">measured</th>'
             '<th class="hd2" width="150">Complexity mix</th></tr>')
    for i, (key, label, _f, _t, _hi, _why) in enumerate(DIMENSIONS):
        sc = r["scores"][key]
        v = sc["value"]
        txt = "&ndash;" if v is None else f"{v:g}" if isinstance(v, (int, float)) else esc(str(v))
        cls = "" if i % 2 == 0 else ' class="z"'
        bar = (f'<td rowspan="{len(DIMENSIONS)}" class="bc">'
               + _bar(r["complexity_distribution"])
               + '<div class="sub">1 = trivial &rarr; 5 = very hard</div></td>') if i == 0 else ""
        h.append(f'<tr{cls}><td class="sn2">{esc(label)}</td>'
                 f'<td class="ctr">{_pill(sc["absolute"], invert=(key == "complexity"))}</td>'
                 f'<td class="ctr">{_rel_mark(sc["relative"])}</td>'
                 f'<td class="mv2">{txt} <span class="sub">{esc(UNITS.get(key, ""))}</span></td>'
                 f'{bar}</tr>')
    h.append("</table>")

    mix = list((r.get("work_mix") or {}).items())[:7]
    if mix:
        total_mix = sum(v for _k, v in (r.get("work_mix") or {}).items()) or 1
        h.append('<table cellspacing="0" cellpadding="0" class="wm"><tr>'
                 '<td valign="top" width="52%"><div class="lbl nb-b">What they worked on</div>'
                 '<table cellspacing="0" cellpadding="0" class="wmi">'
                 + "".join(
                     f'<tr><td class="wmn">{esc(k)}</td>'
                     f'<td class="wmc">{v}</td>'
                     f'<td class="wmb"><div class="bar" style="width:'
                     f'{max(4, round(100.0 * v / total_mix))}%">&nbsp;</div></td></tr>'
                     for k, v in mix)
                 + "</table></td>")
        if r.get("specialist_areas"):
            h.append('<td valign="top" width="48%" class="spcell">'
                     '<div class="lbl nb-p">Work nobody else on the desk does</div>'
                     '<ul class="ul">'
                     + "".join(f'<li><span class="spec">&#9733;</span> {esc(a)}</li>'
                               for a in r["specialist_areas"])
                     + f'</ul><div class="sub">{r["specialist_tickets"]} of their '
                       f'{r["tickets_touched"]} ticket(s). Real expertise &mdash; and '
                       f'key-person risk if they are away.</div></td>')
        else:
            h.append('<td valign="top" width="48%" class="spcell">'
                     '<div class="lbl nb-b">Specialist areas</div>'
                     '<div class="sub">Nothing in this period that another technician on the desk '
                     'does not also handle. That is good for cover, and it also means there is '
                     'room to grow into the harder categories.</div></td>')
        h.append("</tr></table>")

    if narrative:
        if isinstance(narrative, dict):
            labels = {"strengths": ("nb-g", "Doing well"), "concerns": ("nb-a", "Concerns"),
                      "actions": ("nb-b", "For the one-to-one"),
                      "watch": ("nb-p", "Watch next week")}
            inner = []
            for key in ("strengths", "concerns", "actions", "watch"):
                if not narrative.get(key):
                    continue
                cls, lbl = labels[key]
                inner.append(f'<div class="nb"><div class="lbl {cls}">{lbl}</div>'
                             f'<div class="nbt">{narrative[key]}</div></div>')
            if inner:
                h.append('<div class="rev"><div class="revh">AI review</div>'
                         + "".join(inner) + "</div>")
        else:
            h.append(f'<div class="rev"><div class="nbt">{narrative}</div></div>')

    if r["strengths"] or r["gaps"]:
        h.append('<table cellspacing="0" cellpadding="0" class="sg"><tr>')
        h.append('<td width="50%" valign="top">'
                 + ('<div class="lbl nb-g">Computed strengths</div><ul class="ul">'
                    + "".join(f"<li>{esc(x)}</li>" for x in r["strengths"]) + "</ul>"
                    if r["strengths"] else "")
                 + "</td>")
        h.append('<td width="50%" valign="top">'
                 + ('<div class="lbl nb-a">Worth a conversation</div><ul class="ul">'
                    + "".join(f"<li>{esc(x)}</li>" for x in r["gaps"]) + "</ul>"
                    if r["gaps"] else "")
                 + "</td></tr></table>")

    if r["dormant_days"]:
        h.append('<div class="warn"><b>Working days with open tickets and no recorded activity:</b> '
                 + ", ".join(f'{esc(d["date"])} ({d["open_tickets_waiting"]} open)'
                             for d in r["dormant_days"])
                 + ". This is not proof of idleness &mdash; on-site work and projects leave no "
                   "trace in these systems. It is a question to ask.</div>")

    h.append(f'<div class="tlh">All {len(r["closed_tickets"])} ticket(s) '
             f'{esc(r["name"])} completed in this period</div>'
             '<div class="note"><b>Cx</b> = complexity 1&ndash;5 (skill the work needed). '
             '<b>Co</b> = coordination 1&ndash;5 (messages, people and days it took to land). '
             'They are separate on purpose: an Apple ID reset with six people on the thread is '
             'heavy coordination, not hard technical work. '
             '<span class="spec">&#9733;</span> marks work nobody else on the desk does.</div>')
    if r["closed_tickets"]:
        h.append(_ticket_rows(r["closed_tickets"], closed=True))
    else:
        h.append('<div class="note">Nothing closed in this period.</div>')

    if r["open_ticket_list"]:
        h.append(f'<div class="tlh tlo">Still open and assigned to them '
                 f'({len(r["open_ticket_list"])}) &mdash; oldest activity first</div>')
        h.append(_ticket_rows(r["open_ticket_list"], closed=False))
    h.append("</div>")
    return "".join(h)


DEFAULT_TP_PROMPT = """You are an experienced service-desk manager writing the coaching notes
for a weekly one-to-one with each technician at an MSP. Your reader is the owner of the business.
He has asked for depth, not brevity: more detail is better than less.

You are given computed figures per technician. Two DIFFERENT 1-5 ratings appear, and confusing
them would make your review wrong:
  * COMPLEXITY (1-5) is the skill the work required - what class of work it was, whether only one
    person on the desk does that kind of work, whether they got hands on a machine, and whether it
    hit a whole site. 5 means expert or business-critical, 1 means an automated report.
  * COORDINATION (1-5) is how much chasing it took - messages, people involved, days elapsed. A
    password reset with six people on the thread scores high here and low on complexity. It is
    real effort, but it is a different problem with a different fix.
Also given: which categories of work only ONE technician on the desk handles ("specialist_areas"),
which is simultaneously that person's expertise and the desk's key-person risk.

Further figures: tickets touched and closed, measured working time, time spent solving problems with the AI assistant, phone talk time from
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
- Never treat a high coordination score as achievement OR as failure by itself - ask what caused
  it. Never describe a low-complexity, high-coordination ticket as difficult work.
- Where someone owns specialist work alone, say both things: it is a genuine strength, and it is a
  risk to the business if they are the only one who can do it. Suggest who could learn it.
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
h3.h3,.h3{font-size:15px;color:#1a3c6e;margin:26px 0 5px;font-weight:700}
.note{font-size:11.5px;color:#6b7280;line-height:1.5;margin:0 0 7px}
.sub{font-size:10px;color:#9099a8;font-weight:400;line-height:1.35}
.warn{font-size:11.5px;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;
    padding:7px 10px;margin:7px 0}
/* scorecard: scales as rows, technicians as column pairs */
.sc{width:100%;font-size:12px;margin:0 0 4px}
.sc .hd{background:#1a3c6e;color:#fff;text-align:left;padding:7px 8px;font-size:11.5px;
    border:1px solid #16325c;vertical-align:middle}
.sc .hd .sub{color:#b8c6de}
.hd2{background:#eef2f7;color:#42506b;padding:4px 6px;font-size:10px;font-weight:700;
    text-transform:uppercase;border:1px solid #dbe2ec;text-align:left}
.sc .sr td{border:1px solid #e3e8ef;padding:6px 8px;vertical-align:middle}
.sc .sn{line-height:1.35}
.sc .sv{white-space:nowrap}
.sc .mv{font-size:12.5px;color:#1f2937;font-weight:600;white-space:nowrap}
.sc .tot td{background:#eef2f7;border-top:2px solid #1a3c6e}
.ov{font-size:15px;color:#1a3c6e}.ov2{font-size:13px;color:#5b6b86}
.wh{font-size:11px;color:#92400e;font-weight:700}
.up{color:#15803d;font-weight:700;font-size:11.5px;white-space:nowrap}
.eq{color:#94a3b8;font-weight:700;font-size:11.5px}
.dn{color:#c2410c;font-weight:700;font-size:11.5px;white-space:nowrap}
.nn{color:#b9c0cc}
/* per-technician block */
.tb{border:1px solid #d8dee7;border-top:3px solid #1a3c6e;margin:22px 0 0;padding:12px 14px}
.tn{font-size:17px;font-weight:700;color:#1a3c6e;margin-bottom:2px}
.tx{font-size:12px;font-weight:400;color:#666}
.to{float:right;font-size:12.5px;color:#1f2937;font-weight:400}
.kt{width:100%;margin:8px 0 4px}
.kt .gh{font-size:10px;font-weight:700;color:#5b6b86;text-transform:uppercase;
    letter-spacing:.4px;padding:9px 0 3px;border:0}
.kt .k{width:25%}
.kt .pad{border:0;background:none}
.ms{width:100%;font-size:12px;margin:10px 0 2px}
.ms td{border:1px solid #e3e8ef;padding:5px 8px;vertical-align:middle}
.ms .sn2{color:#42506b;width:31%}
.ms .mv2{color:#1f2937;font-weight:600;white-space:nowrap}
.ms .bc{text-align:center;vertical-align:middle;background:#fbfcfe}
.lbl{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;
    margin-bottom:2px}
.nb-g{color:#166534}.nb-a{color:#b45309}.nb-b{color:#1a3c6e}.nb-p{color:#6b21a8}
.rev{border:1px solid #dde5f0;border-left:4px solid #1a3c6e;background:#f8fafc;
    padding:10px 13px;margin:12px 0}
.revh{font-size:10px;font-weight:700;color:#8798b5;text-transform:uppercase;
    letter-spacing:.4px;margin-bottom:6px}
.nb{margin:0 0 8px}
.nbt{font-size:12.5px;line-height:1.6;color:#1f2937}
.sg{width:100%;margin:8px 0 4px}
.sg td{padding-right:14px}
.ul{margin:2px 0 6px 16px;padding:0;font-size:12px;line-height:1.5;color:#1f2937}
.ul li{margin:0 0 3px}
.tlh{font-size:12.5px;color:#1a3c6e;font-weight:700;margin:14px 0 3px;
    border-top:1px solid #e3e8ef;padding-top:9px}
.tlo{color:#92400e}
.tt .wk{font-size:10.5px;color:#5b6b86;line-height:1.3}
.spec{color:#a16207;font-weight:700}
.wm{width:100%;margin:10px 0 2px}
.wm>tbody>tr>td{padding-right:16px}
.wmi{width:100%;font-size:11.5px}
.wmi td{padding:2px 6px 2px 0;vertical-align:middle}
.wmn{color:#42506b}
.wmc{color:#1f2937;font-weight:700;text-align:right;width:26px}
.wmb{width:46%}
.bar{background:#9db4d4;height:9px;border-radius:2px}
.spcell{border-left:1px solid #e3e8ef;padding-left:14px}
.kpr{border:1px solid #e2d6f0;border-left:4px solid #6b21a8;background:#fbf8ff;
    padding:11px 15px;margin:14px 0 0}
.cdt{width:100%;margin:6px 0 4px}
.cd{border:1px solid #d8dee7;background:#f7f9fc;text-align:center;padding:11px 8px;width:25%}
.cd.pad{border:0;background:none}
.cv{font-size:21px;font-weight:700;color:#1a3c6e;line-height:1.2}
.cv.cg{color:#166534}.cv.ca{color:#92400e}
.cl{font-size:10.5px;color:#5b6b86;text-transform:uppercase;letter-spacing:.3px}
.cs{font-size:10px;color:#9099a8}
.hdr{font-size:20px;font-weight:700;color:#1a3c6e;border-bottom:3px solid #1a3c6e;
    padding-bottom:6px}
.hsub{font-size:12.5px;color:#5b6b86;margin:7px 0 12px;line-height:1.5}
.deskb{border:1px solid #cfe3d5;border-left:4px solid #166534;background:#f7fbf8;
    padding:13px 17px;margin:0 0 16px}
.foot{font-size:11px;color:#8b93a1;margin-top:26px;border-top:1px solid #e3e8ef;
    padding-top:9px;line-height:1.6}
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


def _ai_block(ai: Dict[str, Any], desk: Dict[str, Any]) -> str:
    """The AI's workload as its own section - deliberately NOT a row in the technician table.

    Kept separate on the owner's instruction, and it is the right call: putting a tool in the same
    ranked list as people makes "top scorer" meaningless and invites comparing a person's 4.2/5
    against a machine. The AI is not scored 1-5 on any dimension here for the same reason - the
    six dimensions measure how a technician is doing their job, and none of them mean anything
    applied to software.
    """
    if not ai.get("present"):
        return ('<h3 class="h3">The AI as a worker</h3>'
                '<div class="note">No AI activity on tickets in this window.</div>')

    eq = fmt_mins(ai["equiv_minutes"])
    el = fmt_mins(ai["elapsed_minutes"])
    lev = ai.get("leverage_x")
    h = ['<h3 class="h3">The AI as a worker</h3>',
         '<div class="note" style="margin:0 0 8px">'
         'Reported separately from the technicians on purpose: the AI is a tool, so it is not '
         'ranked against people and is not scored 1&ndash;5 on any dimension &mdash; those scales '
         'measure how a person is doing their job. What follows is <b>what it did</b> and '
         '<b>what that work would have cost in human time</b>.</div>']

    # Headline cards.
    h.append('<table class="tt" style="margin:0 0 8px"><tr>')
    cards = [
        (eq, "human-equivalent time",
         "what this desk's own time model would charge a person for this work"),
        (el, "actual elapsed", "measured wall-clock the machine occupied"),
        (f"{lev}&times;" if lev else "&mdash;",
         "leverage multiple", "human-equivalent &divide; actual elapsed"),
        (str(ai["tickets_worked"]), "tickets worked",
         f'{ai["tickets_autonomous"]} with no technician time on them'),
        (str(ai["closed_autonomous"]), "closed with no human",
         "work the desk never had to pick up"),
        (f'{ai["pct_of_desk_human_time"]}%' if ai.get("pct_of_desk_human_time") is not None else "&mdash;",
         "vs desk human time", f'desk measured {fmt_mins(desk.get("minutes"))}'),
    ]
    for val, lbl, note in cards:
        h.append(f'<td class="k"><div class="kv">{val}</div>'
                 f'<div class="kl">{lbl}</div><div class="kn">{esc(note)}</div></td>')
    h.append("</tr></table>")

    # How the equivalent figure is built - stated inline, not buried in the footer, because a
    # number in "hours" that is not really hours is exactly the kind of thing that gets
    # misread in a review.
    h.append('<div class="warn" style="margin:0 0 8px">'
             f'<b>Read the {eq} as human-equivalent effort, not machine runtime.</b> It is '
             'produced by running the AI\'s own activity through the <i>same</i> estimator used '
             'for every technician above (message bursts &rarr; sessions &rarr; this desk\'s '
             'minutes-per-message &times; ticket complexity). The AI actually occupied '
             f'{el} of wall-clock'
             + (f', so it delivered that work about {lev}&times; faster than the desk\'s human '
                'time model would price it.' if lev else '.')
             + ' Neither figure is a timesheet.</div>')

    # Autonomous vs collaborative - who the credit belongs to.
    h.append('<table class="tt"><tr>'
             '<th>How the AI worked</th><th class="m">Tickets</th><th class="m">Closed</th>'
             '<th class="m">Avg complexity</th><th>Human-equivalent time</th>'
             '<th>Who is credited</th></tr>')
    h.append(f'<tr><td class="c"><b>Autonomously</b><div class="sub">no technician put '
             f'measured time on the ticket</div></td>'
             f'<td class="c m">{ai["tickets_autonomous"]}</td>'
             f'<td class="c m">{ai["closed_autonomous"]}</td>'
             f'<td class="c m">{ai["avg_complexity_autonomous"] or "&mdash;"}/5</td>'
             f'<td class="c">{fmt_mins(ai["autonomous_equiv_minutes"])}</td>'
             f'<td class="c">The AI. No person is credited for these.</td></tr>')
    collab_eq = round(ai["equiv_minutes"] - ai["autonomous_equiv_minutes"], 1)
    h.append(f'<tr class="z"><td class="c"><b>Alongside a technician</b><div class="sub">a person '
             f'also had measured time on the ticket</div></td>'
             f'<td class="c m">{ai["tickets_collaborative"]}</td>'
             f'<td class="c m">{ai["closed_collaborative"]}</td>'
             f'<td class="c m">{ai["avg_complexity"] or "&mdash;"}/5</td>'
             f'<td class="c">{fmt_mins(collab_eq)}</td>'
             f'<td class="c">The technician, in their own scorecard. '
             f'{ai["directed_messages"]} message(s) here were composed by a person and typed by '
             f'the AI.</td></tr>')
    h.append("</table>")

    if ai.get("top_autonomous"):
        h.append('<div class="note" style="margin:8px 0 4px">'
                 '<b>Largest tickets the AI handled with no technician time.</b> Worth a skim: if '
                 'any of these should have had a person in the loop, that is a routing decision, '
                 'not a productivity one.</div>')
        h.append('<table class="tt"><tr><th>Ticket</th><th>Customer</th><th>Stage</th>'
                 '<th class="m">Cx</th><th class="r">Human-equiv</th></tr>')
        for i, t in enumerate(ai["top_autonomous"]):
            ref = esc((t["ref"] or "").replace("TICKET/", "#"))
            link = (f'<a class="lk" href="{esc(t["url"])}">{ref}</a>' if t.get("url") else ref)
            zrow = ' class="z"' if i % 2 else ""
            h.append(f'<tr{zrow}>'
                     f'<td class="c">{link}<div class="sub">{esc((t["subject"] or "")[:70])}</div></td>'
                     f'<td class="c">{esc((t["company"] or "").split(",")[0])}</td>'
                     f'<td class="c">{esc(t["stage"])}</td>'
                     f'<td class="c m">{t["cx5"] or "&mdash;"}</td>'
                     f'<td class="c r">{fmt_mins(t["equiv_minutes"])}</td></tr>')
        h.append("</table>")

    h.append('<div class="note" style="margin:6px 0 0">'
             '<b>What this section cannot tell you.</b> Human-equivalent time is a <i>pricing</i> '
             'of the AI\'s output using a model built for people, so it inherits that model\'s '
             'assumptions &mdash; it is a defensible way to size the contribution, not a measured '
             'saving. It also cannot judge <i>quality</i>: a ticket the AI closed without a person '
             'is counted here whether the customer was well served or not.</div>')
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
         '<div class="hdr">Technician Productivity Analysis</div>',
         f'<div class="hsub">{esc(label.capitalize())} &middot; '
         f'{desk["techs"]} technician(s) with ticket activity &middot; '
         f'complexity, time, AI collaboration and phone work, per person. '
         f'Every scale runs 1&ndash;5.</div>']

    if narr.get("__desk__"):
        h.append('<div class="deskb"><div class="lbl nb-g">The desk overall</div>'
                 f'<div class="nbt" style="font-size:13.5px">{narr["__desk__"]}</div></div>')
    elif narr.get("__error__"):
        h.append('<div style="font-size:12.5px;color:#92400e;'
                 'background:#fffbeb;border:1px solid #fcd34d;padding:10px;margin-bottom:12px">'
                 f'AI narrative unavailable ({esc(narr["__error__"])}). All figures below are '
                 "computed locally and are unaffected.</div>")

    h.append('<div class="note" style="margin:0 0 10px">'
             "This report lists <b>every</b> ticket each technician completed, so it is long by "
             "design. If your mail client truncates it, the complete report is also attached to "
             "this email as an HTML file &mdash; open that and nothing is missing.</div>")
    h.append(_cards(desk, payload))
    h.append(_audit_html(checks, ai_audit))
    h.append(_provenance(payload, hours))
    h.append(_scorecard(rows))

    owners = desk.get("specialist_owners") or {}
    if owners:
        by_person: Dict[str, List[str]] = {}
        for cat, who in owners.items():
            for w in who:
                by_person.setdefault(w, []).append(cat.replace("_", " "))
        h.append('<div class="kpr"><div class="lbl nb-p">Key-person risk</div>'
                 '<div class="nbt" style="font-size:12.5px">Categories of work that exactly one '
                 "technician handled in this period. This is where the desk is strongest and most "
                 "exposed at the same time &mdash; if that person is away, this work has nobody.<br>"
                 + "<br>".join(f'<b>{esc(who)}</b> alone handled: {esc(", ".join(sorted(cats)))}'
                               for who, cats in sorted(by_person.items()))
                 + "</div></div>")

    if desk.get("team_unanswered_calls"):
        h.append('<div class="note" style="margin:10px 0 0;font-size:12px">'
                 f'<b>Team-wide:</b> {desk["team_unanswered_calls"]} inbound call(s) rang the desk '
                 "and nobody answered. Inbound rings every extension at once, so this belongs to "
                 "the team, not to any individual.</div>")

    h.append('<h3 class="h3">Technician by technician</h3>')
    for r in sorted(rows, key=lambda x: -(x["overall_absolute"] or 0)):
        h.append(_tech_block(r, narr.get(r["name"], "")))

    # LAST, below every technician (owner's instruction). The people come first; the machine's
    # workload is context for their numbers, not a peer to them.
    h.append(_ai_block(payload.get("ai_worker") or {}, desk))

    h.append(
        '<div class="foot">'
        "<b>How this is calculated.</b> <u>Complexity 1&ndash;5</u> rates <b>the skill the work "
        "required</b>, from a taxonomy of the work itself: security incidents, production outages "
        "and infrastructure projects rate 5; specialist infrastructure &mdash; database and ERP "
        "performance, server hardware, RDS, directory services, mail and network infrastructure, "
        "backup faults, security hardening &mdash; rates 4; standard workstation and application "
        "break/fix rates 3; account and access tasks rate 2; automated reports with nothing wrong "
        "rate 1. A ticket then gains up to two points for work <b>only one technician on this desk "
        "handles</b>, for hands-on device evidence in the ledger rather than correspondence alone, "
        "for whole-site or production impact, and for being reopened. "
        "<b>Message volume is deliberately excluded from complexity</b> and reported separately as "
        "<u>coordination 1&ndash;5</u>: an Apple ID reset with thirteen messages and six people is "
        "heavy coordination and routine technical work, and an earlier version of this report rated "
        "it 4/5 for difficulty while rating SQL index tuning on a live ERP 3/5. Both numbers are "
        "shown per ticket so the difference is visible. <u>Time</u> comes from the work ledger: attention measured from AI chat "
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
