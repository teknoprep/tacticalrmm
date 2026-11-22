"""Email: the scheduled backup digest and immediate failure alerts (BackupNotify rows).

Called by the backup_scheduler every tick and by the "Send now" API. Mail goes out through
TRMM's own SMTP settings (CoreSettings.send_mail) — no new mail credentials.

Safety nets for non-production (both read from the environment, unset in prod):
  RMM_BACKUP_MAIL_DRYRUN=1          render the mail into the scheduler log, send nothing
  RMM_BACKUP_MAIL_ALLOWLIST=a,b     only these addresses or @domains receive mail; others are dropped
"""

import os
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from django.db.models import Q
from django.utils import timezone

from agents.models import Agent

from . import report
from .models import BackupNotify, BackupPolicy, BackupRun

# do not mail about failures older than this when a rule is new or the scheduler was down
FAILURE_LOOKBACK = timedelta(hours=6)
DIGEST_WINDOW = timedelta(hours=6)  # same rule as jobs: a scheduler down all day does not send at 23:00


def dry_run() -> bool:
    return os.environ.get("RMM_BACKUP_MAIL_DRYRUN", "").lower() in ("1", "true", "yes")


def allowed_recipients(recipients):
    raw = os.environ.get("RMM_BACKUP_MAIL_ALLOWLIST", "").strip()
    if not raw:
        return list(recipients), []
    allow = [a.strip().lower() for a in raw.split(",") if a.strip()]
    ok, dropped = [], []
    for r in recipients:
        low = r.lower()
        hit = any(low == a or (a.startswith("@") and low.endswith(a)) for a in allow)
        (ok if hit else dropped).append(r)
    return ok, dropped


def scope_name(n: BackupNotify) -> str:
    return n.client.name if n.client else "all clients"


def scope_agents(n: BackupNotify):
    qs = Agent.objects.select_related("site", "site__client").defer("wmi_detail", "services").filter(
        plat__in=["linux", "windows"]
    )
    return qs.filter(site__client_id=n.client_id) if n.client_id else qs


def scope_jobs(n: BackupNotify):
    qs = BackupPolicy.objects.select_related("client", "site", "backend")
    return qs.filter(Q(client_id=n.client_id) | Q(client__isnull=True)) if n.client_id else qs


def _send(n: BackupNotify, subject, text, html, csv_text=None, log=print) -> tuple[bool, str]:
    from core.utils import get_core_settings

    to, dropped = allowed_recipients(n.recipients)
    note = f" (dropped by RMM_BACKUP_MAIL_ALLOWLIST: {', '.join(dropped)})" if dropped else ""
    if not to:
        return False, "no recipient allowed" + note
    if dry_run():
        log(f"[mail dry-run] to={', '.join(to)} subject={subject!r}{note}\n{text}")
        return True, f"dry run: would send to {', '.join(to)}{note}"
    kw = {}
    if csv_text:
        kw = dict(attachment=csv_text.encode(), attachment_filename="backup-report.csv",
                  attachment_mimetype="text/csv")
    msg, ok = get_core_settings().send_mail(subject, text, override_recipients=to, html_body=html, **kw)
    return bool(ok), ("sent to " + ", ".join(to) + note) if ok else f"not sent: {msg}"


def send_digest(n: BackupNotify, log=print, days=7) -> tuple[bool, str]:
    rep = report.build(scope_agents(n), scope_jobs(n), days=days)
    t = rep["totals"]
    if n.only_problems and not rep["problems"]:
        return True, "skipped: no problems"
    if not t["hosts"] and not t["servers_unprotected"]:
        return True, "skipped: nothing in scope"
    tz = ZoneInfo(n.timezone or "UTC")
    text, html = report.render_email(rep, scope_name(n), tz)
    return _send(n, report.subject_for(rep, scope_name(n)), text, html, report.to_csv(rep), log)


def send_failures(n: BackupNotify, now, log=print) -> tuple[bool, str]:
    since = max(n.last_failure_check or (now - FAILURE_LOOKBACK), now - FAILURE_LOOKBACK)
    runs = BackupRun.objects.select_related("policy", "client").filter(
        status="error", finished_at__gt=since, finished_at__lte=now
    )
    if n.client_id:
        runs = runs.filter(client_id=n.client_id)
    runs = list(runs.order_by("finished_at")[:100])
    if not runs:
        return True, ""
    subject, text, html = report.render_failures(runs, ZoneInfo(n.timezone or "UTC"))
    return _send(n, subject, text, html, None, log)


def digest_due(n: BackupNotify, now) -> bool:
    if not (n.enabled and n.digest):
        return False
    tz = ZoneInfo(n.timezone or "UTC")
    local = now.astimezone(tz)
    if local.weekday() not in (n.digest_days or []) or n.last_digest_date == local.date():
        return False
    hh, mm = (int(x) for x in n.digest_time.split(":"))
    slot = datetime(local.year, local.month, local.day, hh, mm, tzinfo=tz)
    return slot <= local <= slot + DIGEST_WINDOW


def tick(now=None, log=print, dry=False):
    """One scheduler pass over every rule. Marks progress before sending, so a crash never double-mails."""
    now = now or timezone.now()
    for n in BackupNotify.objects.select_related("client").filter(enabled=True):
        if n.failures:
            if dry:
                log(f"notify {n.id}: would check failures since {n.last_failure_check}")
            else:
                BackupNotify.objects.filter(pk=n.pk).update(last_failure_check=now)
                ok, res = send_failures(n, now, log)
                if res:
                    _record(n, now, res, log)
        if digest_due(n, now):
            if dry:
                log(f"notify {n.id} '{n.name}': digest due")
                continue
            local_date = now.astimezone(ZoneInfo(n.timezone or "UTC")).date()
            if not BackupNotify.objects.filter(pk=n.pk).exclude(last_digest_date=local_date).update(
                last_digest_date=local_date
            ):
                continue  # another scheduler got it
            ok, res = send_digest(n, log)
            _record(n, now, res, log)


def _record(n, now, res, log):
    log(f"notify {n.id} '{n.name}': {res}")
    upd = {"last_result": res[:500]}
    if res.startswith(("sent", "dry run")):
        upd["last_sent"] = now
    BackupNotify.objects.filter(pk=n.pk).update(**upd)
