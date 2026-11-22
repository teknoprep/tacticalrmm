"""Health and reporting — the one place that decides what "protected" means.

Health is judged per host *and job* (a host in two jobs is only as healthy as the worse one),
from that pair's latest finished run. Used by the API (summary, jobs, hosts, report), the email
digest and the failure alerts, so the tab, the CSV and the email never disagree.

Deterministic on purpose: no AI decides whether a backup is good (docs/02).
"""

import csv
import io
from datetime import timedelta
from html import escape

from django.db.models import Q
from django.utils import timezone

from . import logic
from .models import BackupRun

STALE_HOURS = 50  # two missed nights is a ticket; one is noise (docs/04 §4.3)
OPEN = ("pending", "dispatched", "running")
# worst first wins when a host has several jobs
RANK = {"ok": 0, "running": 1, "warn": 2, "stale": 3, "never": 4, "failing": 5}
HEALTH_ORDER = ["failing", "never", "stale", "warn", "running", "ok"]


def latest_by_pair(agent_ids) -> dict:
    """{(agent_id, policy_id): latest non-pending run}."""
    out = {}
    if not agent_ids:
        return out
    for run in (
        BackupRun.objects.select_related("policy", "backend")
        .filter(agent_id__in=list(agent_ids), policy__isnull=False)
        .exclude(status="pending")
        .order_by("agent_id", "policy_id", "-created_time")
        .distinct("agent_id", "policy_id")
    ):
        out[(run.agent_id, run.policy_id)] = run
    return out


def last_good_by_pair(agent_ids) -> dict:
    """{(agent_id, policy_id): finished_at of the latest ok/warn run}."""
    out = {}
    if not agent_ids:
        return out
    for agent_id, policy_id, finished in (
        BackupRun.objects.filter(agent_id__in=list(agent_ids), policy__isnull=False, status__in=["ok", "warn"])
        .order_by("agent_id", "policy_id", "-finished_at")
        .distinct("agent_id", "policy_id")
        .values_list("agent_id", "policy_id", "finished_at")
    ):
        out[(agent_id, policy_id)] = finished
    return out


def health(run, now=None) -> str:
    if run is None:
        return "never"
    if run.status in ("dispatched", "running"):
        return "running"
    if run.status == "error":
        return "failing"
    ref = run.finished_at or run.started_at or run.created_time
    if ((now or timezone.now()) - ref) > timedelta(hours=STALE_HOURS):
        return "stale"
    return "warn" if run.status == "warn" else "ok"


def worst(states) -> str:
    states = list(states)
    return max(states, key=lambda s: RANK.get(s, 0)) if states else "unprotected"


def host_jobs(agent, jobs, latest, last_good=None, now=None) -> list[dict]:
    """One row per enabled job covering the host: its health and last result."""
    rows = []
    for j in logic.jobs_for_agent(agent, jobs):
        if not j.enabled:
            continue
        run = latest.get((agent.agent_id, j.id))
        rows.append(
            {
                "id": j.id,
                "name": j.name,
                "health": health(run, now),
                "run": run,
                "last_good": (last_good or {}).get((agent.agent_id, j.id)),
            }
        )
    return rows


def empty_counts() -> dict:
    return {k: 0 for k in HEALTH_ORDER}


# --------------------------------------------------------------------------- report

def build(agents, jobs, days: int = 7) -> dict:
    """Per-client rollup, a problem list and per host+job rows for `agents` (already scoped)."""
    now = timezone.now()
    since = now - timedelta(days=days)
    agents = list(agents)
    jobs = [j for j in jobs if j.enabled]
    ids = [a.agent_id for a in agents]
    latest = latest_by_pair(ids)
    good = last_good_by_pair(ids)

    finished = {}  # agent_id -> [ok, total] over the window
    for agent_id, status in BackupRun.objects.filter(
        agent_id__in=ids, finished_at__gte=since, status__in=["ok", "warn", "error"]
    ).values_list("agent_id", "status"):
        f = finished.setdefault(agent_id, [0, 0])
        f[1] += 1
        f[0] += status != "error"

    clients, rows, problems = {}, [], []
    for a in agents:
        c = clients.setdefault(
            a.site.client_id,
            {
                "client": a.site.client_id, "client_name": a.site.client.name, "hosts": 0,
                "servers_unprotected": 0, **empty_counts(), "runs": 0, "runs_ok": 0,
                "protected_bytes": 0, "last_failure": None,
            },
        )
        hj = host_jobs(a, jobs, latest, good, now)
        if not hj:
            if a.monitoring_type == "server":
                c["servers_unprotected"] += 1
                problems.append(_problem(a, None, "unprotected", None, None))
            continue
        c["hosts"] += 1
        c[worst(r["health"] for r in hj)] += 1
        ok, total = finished.get(a.agent_id, [0, 0])
        c["runs"] += total
        c["runs_ok"] += ok
        for r in hj:
            run = r["run"]
            if run and run.status in ("ok", "warn"):
                c["protected_bytes"] += run.total_bytes or 0
            if run and run.status == "error" and (
                c["last_failure"] is None or (run.finished_at or run.created_time) > c["last_failure"]["at"]
            ):
                c["last_failure"] = {"host": a.hostname, "job": r["name"], "message": run.message[:300],
                                     "at": run.finished_at or run.created_time}
            if r["health"] in ("failing", "stale", "never", "warn"):
                problems.append(_problem(a, r, r["health"], run, r["last_good"]))
            rows.append(
                {
                    "client_name": a.site.client.name, "site_name": a.site.name, "host": a.hostname,
                    "os": a.plat, "job": r["name"], "health": r["health"],
                    "last_status": run.status if run else "", "last_run": (run.finished_at or run.created_time) if run else None,
                    "last_good": r["last_good"], "total_bytes": run.total_bytes if run else 0,
                    "snapshots": run.snapshots if run else 0, "message": run.message[:300] if run else "",
                }
            )

    for c in clients.values():
        c["success_rate"] = round(100 * c["runs_ok"] / c["runs"], 1) if c["runs"] else None
    order = {s: i for i, s in enumerate(["unprotected", *HEALTH_ORDER])}
    problems.sort(key=lambda p: (order.get(p["health"], 9), p["client_name"].lower(), p["host"].lower()))
    rows.sort(key=lambda r: (r["client_name"].lower(), r["host"].lower(), r["job"].lower()))
    client_rows = sorted(
        (c for c in clients.values() if c["hosts"] or c["servers_unprotected"]),
        key=lambda c: c["client_name"].lower(),
    )
    totals = empty_counts()
    for c in client_rows:
        for k in totals:
            totals[k] += c[k]
    totals["hosts"] = sum(c["hosts"] for c in client_rows)
    totals["servers_unprotected"] = sum(c["servers_unprotected"] for c in client_rows)
    totals["protected_bytes"] = sum(c["protected_bytes"] for c in client_rows)
    runs = sum(c["runs"] for c in client_rows)
    totals["success_rate"] = round(100 * sum(c["runs_ok"] for c in client_rows) / runs, 1) if runs else None
    return {"generated": now, "days": days, "stale_after_hours": STALE_HOURS,
            "totals": totals, "clients": client_rows, "problems": problems, "rows": rows}


def _problem(agent, job_row, state, run, last_good) -> dict:
    return {
        "client_name": agent.site.client.name, "site_name": agent.site.name, "host": agent.hostname,
        "agent_id": agent.agent_id, "job": job_row["name"] if job_row else "", "health": state,
        "message": (run.message[:300] if run else
                    ("server is in no backup job" if state == "unprotected" else "no backup has run yet")),
        "last_good": last_good,
    }


def to_csv(report: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    cols = ["client_name", "site_name", "host", "os", "job", "health", "last_status", "last_run",
            "last_good", "total_bytes", "snapshots", "message"]
    w.writerow(cols)
    for r in report["rows"]:
        w.writerow([_fmt(r[c]) for c in cols])
    for p in report["problems"]:
        if p["health"] == "unprotected":
            w.writerow([p["client_name"], p["site_name"], p["host"], "", "", "unprotected", "", "", "", "", "",
                        p["message"]])
    return buf.getvalue()


def _fmt(v):
    if hasattr(v, "isoformat"):
        return v.isoformat(timespec="minutes")
    return v


# --------------------------------------------------------------------------- email

COLORS = {"ok": "#2e7d32", "warn": "#ef6c00", "running": "#1565c0", "stale": "#ef6c00",
          "never": "#757575", "failing": "#c62828", "unprotected": "#6a1b9a"}


def human_bytes(n) -> str:
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def _when(dt, tz) -> str:
    return dt.astimezone(tz).strftime("%Y-%m-%d %H:%M") if dt else "never"


def subject_for(report: dict, scope: str) -> str:
    t = report["totals"]
    bad = t["failing"] + t["stale"] + t["never"] + t["servers_unprotected"]
    head = "OK" if not bad else f"{bad} need attention"
    return f"Backup report — {scope}: {head} ({t['ok'] + t['warn']}/{t['hosts']} hosts protected)"


def render_email(report: dict, scope: str, tz) -> tuple[str, str]:
    """(plain text, html). Inline styles only — mail clients drop <style>."""
    t = report["totals"]
    td = 'style="padding:4px 8px;border-bottom:1px solid #ddd;text-align:left"'
    th = 'style="padding:4px 8px;border-bottom:2px solid #999;text-align:left;background:#f5f5f5"'
    rate = lambda v: "—" if v is None else f"{v}%"  # noqa: E731

    def badge(s):
        return (f'<span style="color:#fff;background:{COLORS.get(s, "#555")};border-radius:3px;'
                f'padding:1px 6px;font-size:12px">{escape(s)}</span>')

    lines = [subject_for(report, scope), "",
             f"Hosts in a job: {t['hosts']}  ok {t['ok']}  warn {t['warn']}  failing {t['failing']}  "
             f"stale {t['stale']}  never {t['never']}  running {t['running']}",
             f"Servers in no backup job: {t['servers_unprotected']}",
             f"Run success over {report['days']} days: {rate(t['success_rate'])}  "
             f"Protected data: {human_bytes(t['protected_bytes'])}", ""]
    h = [f'<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222">',
         f'<h2 style="margin:0 0 8px">{escape(subject_for(report, scope))}</h2>',
         f'<p>Hosts in a job: <b>{t["hosts"]}</b> &nbsp; {badge("ok")} {t["ok"]} &nbsp; {badge("warn")} {t["warn"]}'
         f' &nbsp; {badge("failing")} {t["failing"]} &nbsp; {badge("stale")} {t["stale"]} &nbsp; {badge("never")}'
         f' {t["never"]} &nbsp; {badge("unprotected")} {t["servers_unprotected"]} servers in no job<br>'
         f'Run success over {report["days"]} days: <b>{rate(t["success_rate"])}</b> &nbsp; '
         f'Protected data: <b>{human_bytes(t["protected_bytes"])}</b></p>']

    if report["problems"]:
        lines.append("NEEDS ATTENTION")
        h.append('<h3 style="margin:16px 0 4px">Needs attention</h3><table style="border-collapse:collapse">'
                 f'<tr><th {th}>Status</th><th {th}>Client</th><th {th}>Host</th><th {th}>Job</th>'
                 f'<th {th}>Last good backup</th><th {th}>Detail</th></tr>')
        for p in report["problems"][:200]:
            lines.append(f"- [{p['health']}] {p['client_name']} / {p['host']} {p['job']}: {p['message']} "
                         f"(last good: {_when(p['last_good'], tz)})")
            h.append(f'<tr><td {td}>{badge(p["health"])}</td><td {td}>{escape(p["client_name"])}</td>'
                     f'<td {td}>{escape(p["host"])}</td><td {td}>{escape(p["job"])}</td>'
                     f'<td {td}>{_when(p["last_good"], tz)}</td><td {td}>{escape(p["message"])}</td></tr>')
        h.append("</table>")
        if len(report["problems"]) > 200:
            h.append(f"<p>…and {len(report['problems']) - 200} more (see the CSV).</p>")
        lines.append("")
    else:
        lines.append("Every host in a backup job has a current, verified backup.")
        h.append("<p>Every host in a backup job has a current, verified backup.</p>")

    if len(report["clients"]) > 1:
        lines.append("BY CLIENT")
        h.append('<h3 style="margin:16px 0 4px">By client</h3><table style="border-collapse:collapse">'
                 f'<tr><th {th}>Client</th><th {th}>Hosts</th><th {th}>OK</th><th {th}>Problems</th>'
                 f'<th {th}>Servers in no job</th><th {th}>Success ({report["days"]}d)</th><th {th}>Protected</th></tr>')
        for c in report["clients"]:
            bad = c["failing"] + c["stale"] + c["never"]
            lines.append(f"- {c['client_name']}: {c['ok'] + c['warn']}/{c['hosts']} ok, {bad} problems, "
                         f"{c['servers_unprotected']} servers in no job, success {rate(c['success_rate'])}")
            h.append(f'<tr><td {td}>{escape(c["client_name"])}</td><td {td}>{c["hosts"]}</td>'
                     f'<td {td}>{c["ok"] + c["warn"]}</td><td {td}>{bad}</td><td {td}>{c["servers_unprotected"]}</td>'
                     f'<td {td}>{rate(c["success_rate"])}</td><td {td}>{human_bytes(c["protected_bytes"])}</td></tr>')
        h.append("</table>")

    foot = (f"Generated {_when(report['generated'], tz)} ({tz}). A host is stale after "
            f"{report['stale_after_hours']} h without a good backup. Full detail: attached CSV.")
    lines += ["", foot]
    h.append(f'<p style="color:#777;font-size:12px;margin-top:16px">{escape(foot)}</p></div>')
    return "\n".join(lines), "".join(h)


def render_failures(runs, tz) -> tuple[str, str, str]:
    """(subject, text, html) for runs that just failed."""
    runs = list(runs)
    hosts = sorted({r.host for r in runs})
    subject = (f"Backup FAILED: {hosts[0]} ({runs[0].policy.name if runs[0].policy else 'job deleted'})"
               if len(runs) == 1 else f"Backup FAILED on {len(hosts)} host(s): {', '.join(hosts[:5])}"
               + ("…" if len(hosts) > 5 else ""))
    lines, h = [subject, ""], [f'<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px">'
                               f'<h2 style="color:#c62828;margin:0 0 8px">{escape(subject)}</h2><ul>']
    for r in runs:
        job = r.policy.name if r.policy else "(deleted job)"
        client = r.client.name if r.client else ""
        lines.append(f"- {client} / {r.host} — {job} — {_when(r.finished_at, tz)}: {r.message}")
        h.append(f"<li><b>{escape(client)} / {escape(r.host)}</b> — {escape(job)} — "
                 f"{_when(r.finished_at, tz)}<br>{escape(r.message)}</li>")
    h.append("</ul><p style='color:#777;font-size:12px'>The run log is on the Backup tab → History.</p></div>")
    return subject, "\n".join(lines), "".join(h)


def scoped_runs_q(client_id):
    return Q() if client_id is None else Q(client_id=client_id)
