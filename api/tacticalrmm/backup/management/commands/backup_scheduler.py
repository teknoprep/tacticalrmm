"""Backup scheduler: one long-running process, its own container.

Not a celery beat entry on purpose — dev keeps celery off, and a single loop is easy to reason
about: every TICK seconds it
  1. expands due jobs into pending runs (one per covered host, spread over the job's jitter),
  2. dispatches pending runs whose time has come to agents that are online,
  3. gives up on runs that never started or never reported,
  4. sends failure alerts and the scheduled digest email (backup/notify.py).

    python manage.py backup_scheduler            # loop
    python manage.py backup_scheduler --once     # one pass (tests)
    python manage.py backup_scheduler --dry-run  # print what it would do, change nothing
"""

import random
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from django.core.management.base import BaseCommand
from django.db import close_old_connections, transaction
from django.utils import timezone

from agents.models import Agent
from backup import logic, notify
from backup.models import BackupPolicy, BackupRun

TICK = 60
NO_REPORT_GRACE = timedelta(minutes=30)
NOT_STARTED = timedelta(minutes=20)  # dispatched but the runner never said "start"


class Command(BaseCommand):
    help = "Dispatch scheduled backups and expire runs that never finish."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true")
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **opts):
        self.dry = opts["dry_run"]
        self.log(
            f"backup scheduler started (tick {TICK}s, dry-run={self.dry}, "
            f"allowlist={'on' if logic.agent_allowlist() else 'off'}, mail-dry-run={notify.dry_run()})"
        )
        while True:
            close_old_connections()
            try:
                self.tick()
            except Exception as e:  # keep the loop alive; the next tick retries
                self.stderr.write(f"tick failed: {e!r}")
            if opts["once"] or self.dry:
                return
            time.sleep(TICK)

    def log(self, msg):
        self.stdout.write(f"{timezone.now():%Y-%m-%d %H:%M:%S} {msg}")
        self.stdout.flush()

    def tick(self):
        now = timezone.now()
        self.expand_due_jobs(now)
        self.dispatch_pending(now)
        self.expire(now)
        try:
            notify.tick(now, log=self.log, dry=self.dry)
        except Exception as e:  # mail trouble must never stop backups
            self.stderr.write(f"notify failed: {e!r}")

    # 1 ------------------------------------------------------------------
    def expand_due_jobs(self, now):
        agents = None
        for job in BackupPolicy.objects.select_related("backend").filter(enabled=True, backend__isnull=False):
            tz = ZoneInfo(job.timezone or "UTC")
            local = now.astimezone(tz)
            if local.weekday() not in (job.schedule_days or []):
                continue
            hh, mm = (int(x) for x in job.schedule_time.split(":"))
            slot = datetime(local.year, local.month, local.day, hh, mm, tzinfo=tz)
            # due once per local day, and only within 6 h of the slot (a scheduler down all day
            # does not fire a 02:00 job at 23:00)
            if local < slot or local - slot > timedelta(hours=6) or job.last_dispatch_date == local.date():
                continue
            if agents is None:
                agents = list(Agent.objects.select_related("site", "site__client").defer("wmi_detail", "services"))
            covered = [a for a in agents if logic.job_covers(job, a)]
            allowed = [a for a in covered if logic.dispatch_allowed(a.agent_id)]
            if len(allowed) != len(covered):
                self.log(f"job {job.id}: {len(covered) - len(allowed)} host(s) skipped by RMM_BACKUP_AGENT_ALLOWLIST")
            covered = allowed
            self.log(f"job {job.id} '{job.name}': due, {len(covered)} host(s)")
            if self.dry:
                for a in covered:
                    self.log(f"  would queue {a.hostname}")
                continue
            with transaction.atomic():
                locked = BackupPolicy.objects.select_for_update().get(pk=job.pk)
                if locked.last_dispatch_date == local.date():
                    continue
                locked.last_dispatch_date = local.date()
                locked.save(update_fields=["last_dispatch_date"])
                for a in covered:
                    # one open run per host+job: if last night's is still pending/running, skip
                    if BackupRun.objects.filter(
                        policy=job, agent_id=a.agent_id, status__in=["pending", "dispatched", "running"]
                    ).exists():
                        continue
                    after = slot + timedelta(seconds=random.randint(0, max(0, job.jitter_seconds)))
                    logic.new_run(job, a, "schedule", dispatch_after=max(after, now))

    # 2 ------------------------------------------------------------------
    def dispatch_pending(self, now):
        pending = BackupRun.objects.select_related("policy", "backend").filter(
            status="pending", dispatch_after__lte=now
        )
        for run in pending:
            agent = Agent.objects.select_related("site", "site__client").filter(agent_id=run.agent_id).first()
            if agent is None:
                logic.finish(run, "error", "agent no longer exists")
                continue
            if self.dry:
                self.log(f"would dispatch run {run.id} {run.host} (agent {agent.status})")
                continue
            if logic.dispatch(run, agent):
                self.log(f"dispatched run {run.id} {run.host}")
            elif run.status == "pending" and now - (run.dispatch_after or run.created_time) > timedelta(
                hours=logic.PENDING_GIVE_UP_HOURS
            ):
                logic.finish(run, "error", f"agent offline for {logic.PENDING_GIVE_UP_HOURS} h after its slot")

    # 3 ------------------------------------------------------------------
    def expire(self, now):
        if self.dry:
            return
        for run in BackupRun.objects.select_related("policy").filter(status="dispatched", dispatched_at__lt=now - NOT_STARTED):
            logic.finish(run, "error", "runner never started (agent did not run the script, or cannot reach the API)")
        for run in BackupRun.objects.select_related("policy").filter(status="running"):
            minutes = (run.policy.timeout_minutes if run.policy else 360) + logic.LOCK_WAIT_MINUTES
            limit = timedelta(minutes=minutes) + NO_REPORT_GRACE
            if run.started_at and now - run.started_at > limit:
                logic.finish(run, "error", "no result reported before the job timeout")
