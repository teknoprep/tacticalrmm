"""Coverage, dispatch and the job document an agent runner receives.

Coverage rule (one place, used by the Hosts tab, the scheduler and "run now"):

    a host is covered by a job when
        the job is in scope for the host (job.client empty or == host's client,
                                          job.site empty or == host's site)
    and the host's OS matches job.os_target
    and (job.target_mode == "servers" and the host is a server  OR  agent_id in job.target_agents)
    and agent_id not in job.exclude_agents

"Edit a host" in the UI therefore only ever touches target_agents / exclude_agents of the jobs in
scope — there is no per-host copy of a job that can drift from it.
"""

from __future__ import annotations

import os
import re
import secrets
from datetime import timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Iterable
from zoneinfo import ZoneInfo

from django.conf import settings
from django.utils import timezone

from .crypto import encrypt
from .models import BackupPolicy, BackupRepoKey, BackupRun, StorageBackend

if TYPE_CHECKING:
    from agents.models import Agent

RUNNER_DIR = Path(__file__).resolve().parent / "runners"
RUNNERS = {
    "linux": ("RMM Backup runner (Linux)", "shell", "linux.sh"),
    "windows": ("RMM Backup runner (Windows)", "powershell", "windows.ps1"),
}
TOKEN_TTL_HOURS = 30
PENDING_GIVE_UP_HOURS = 20  # an agent offline this long after its slot = the night is missed
# the runners wait up to this long for another backup on the same host (runners/*: 7200 s)
LOCK_WAIT_MINUTES = 120


# --------------------------------------------------------------------------- safety

def agent_allowlist() -> set[str] | None:
    """RMM_BACKUP_AGENT_ALLOWLIST=agent_id,agent_id limits dispatch to those agents.

    Set on dev, whose database is a copy of production: no job there may ever reach an agent that
    is not a lab machine, whatever the job's scope says. Unset in production.
    """
    raw = os.environ.get("RMM_BACKUP_AGENT_ALLOWLIST", "").strip()
    if not raw:
        return None
    return {a.strip() for a in raw.split(",") if a.strip()}


def dispatch_allowed(agent_id: str) -> bool:
    allow = agent_allowlist()
    return allow is None or agent_id in allow


# --------------------------------------------------------------------------- coverage

def agent_os(agent: "Agent") -> str:
    return agent.plat if agent.plat in ("linux", "windows") else ""


def job_in_scope_for(job: BackupPolicy, agent: "Agent") -> bool:
    site = agent.site
    if job.client_id and job.client_id != site.client_id:
        return False
    if job.site_id and job.site_id != site.id:
        return False
    return True


def job_covers(job: BackupPolicy, agent: "Agent") -> bool:
    if not job_in_scope_for(job, agent):
        return False
    os_ = agent_os(agent)
    if not os_ or (job.os_target != "any" and job.os_target != os_):
        return False
    if agent.agent_id in (job.exclude_agents or []):
        return False
    if agent.agent_id in (job.target_agents or []):
        return True
    return job.target_mode == "servers" and agent.monitoring_type == "server"


def jobs_for_agent(agent: "Agent", jobs: Iterable[BackupPolicy]) -> list[BackupPolicy]:
    return [j for j in jobs if job_covers(j, agent)]


def set_host_membership(job: BackupPolicy, agent_id: str, agent: "Agent", include: bool) -> bool:
    """Make `job_covers(job, agent) == include` with the smallest change. Returns True if changed."""
    tgt = list(job.target_agents or [])
    exc = list(job.exclude_agents or [])
    before = (list(tgt), list(exc))
    if include:
        if agent_id in exc:
            exc.remove(agent_id)
        job.target_agents, job.exclude_agents = tgt, exc
        if not job_covers(job, agent) and agent_id not in tgt:
            tgt.append(agent_id)
    else:
        if agent_id in tgt:
            tgt.remove(agent_id)
        job.target_agents, job.exclude_agents = tgt, exc
        if job_covers(job, agent) and agent_id not in exc:
            exc.append(agent_id)
    job.target_agents, job.exclude_agents = tgt, exc
    return (tgt, exc) != before


# --------------------------------------------------------------------------- repo + job doc

def slug(value: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return s or "unnamed"


def repo_key_for(backend: StorageBackend, agent: "Agent") -> BackupRepoKey:
    key = BackupRepoKey.objects.filter(backend=backend, agent_id=agent.agent_id).first()
    if key:
        return key
    client = agent.site.client.name if agent.site_id else "no-client"
    return BackupRepoKey.objects.create(
        backend=backend,
        agent_id=agent.agent_id,
        host=agent.hostname,
        repo_path=f"{slug(client)}/{slug(agent.hostname)}-{agent.agent_id[:6].lower()}",
        password_enc=encrypt(secrets.token_urlsafe(32)),
    )


def api_base_url() -> str:
    """The URL agents use to reach this API: settings, then env, then the docker API_HOST."""
    url = getattr(settings, "BACKUP_API_URL", "") or os.environ.get("RMM_BACKUP_API_URL", "")
    if url:
        return url.rstrip("/")
    host = os.environ.get("API_HOST") or settings.ALLOWED_HOSTS[0]
    return f"https://{host}"


def job_document(run: BackupRun, agent: "Agent") -> dict:
    """Everything the runner needs. Only ever served to the holder of this run's token."""
    job: BackupPolicy = run.policy
    dest: StorageBackend = run.backend
    key = repo_key_for(dest, agent)
    os_ = agent_os(agent)
    weekday = timezone.now().astimezone(ZoneInfo(job.timezone or "UTC")).weekday()
    return {
        "run_id": run.id,
        "host": agent.hostname,
        "os": os_,
        "job": job.name,
        "paths": job.windows_paths if os_ == "windows" else job.paths,
        "excludes": job.windows_excludes if os_ == "windows" else job.excludes,
        "keep_daily": job.keep_daily,
        "keep_weekly": job.keep_weekly,
        "keep_monthly": job.keep_monthly,
        # weekly heavy work on Sundays: prune + read a slice of the data back
        "prune": weekday == 6,
        "check_subset": "1/30" if weekday == 6 else "",
        "limit_upload_kib": dest.bandwidth_kbps,
        "dest": {
            "provider": dest.provider,
            "host": dest.host,
            "port": dest.port or 0,
            "share": dest.share,
            "path": dest.path,
            "region": dest.region,
            "endpoint": dest.endpoint,
            "username": dest.username,
            "secret": dest.secret,
            "tls": dest.tls,
        },
        "repo_path": key.repo_path,
        "repo_password": key.password,
        "tools": TOOLS,
    }


# Pinned engine versions. The runner refuses a download whose SHA-256 differs.
TOOLS = {
    "restic_version": "0.20.0",
    "rclone_version": "1.76.0",
    "restic": {
        "linux-amd64": "0ccd9fa7885074a24603b051e01bf9bd8b5e45d6a1791e9d9887e9e9372107f7",
        "linux-arm64": "1188daded239bccb5952a01d2ad33e77a0d3dc34f9d9fc1e7fdda618d44938ef",
        "windows-amd64": "bba9061c3dce081701ab353ec8cb73a78be73b71a538aad560f2d1067602b7fe",
    },
    "rclone": {
        "linux-amd64": "b00f00b3266c3764413afe599d3ec316f6f43b3e0ea8a0bc1d186d2133e46df7",
        "linux-arm64": "ee169016675e23a69d77240565133ff7dbc9b33d16fa8f7053d4af39f1eaeb78",
        "windows-amd64": "8b4fd2737ade4e70c057ef4a49deb7cffe94b0fb9d7587c189d149823f21a1dc",
    },
}


# --------------------------------------------------------------------------- dispatch

def runner_script(os_: str):
    """The hidden TRMM Script that carries the runner. Created/updated from the file on disk."""
    from scripts.models import Script

    name, shell, filename = RUNNERS[os_]
    body = (RUNNER_DIR / filename).read_text()
    script = Script.objects.filter(name=name, hidden=True).first()
    if script is None:
        script = Script.objects.create(
            name=name, shell=shell, script_body=body, hidden=True,
            category="Backup", description="Dispatched by the backup module. Do not edit here.",
            supported_platforms=[os_], default_timeout=21600,
        )
    elif script.script_body != body or script.shell != shell:
        script.script_body, script.shell = body, shell
        script.save(update_fields=["script_body", "shell"])
    return script


def new_run(job: BackupPolicy, agent: "Agent", trigger: str, dispatch_after=None) -> BackupRun:
    return BackupRun.objects.create(
        host=agent.hostname,
        agent_id=agent.agent_id,
        os=agent_os(agent),
        client=agent.site.client,
        site=agent.site,
        policy=job,
        backend=job.backend,
        trigger=trigger,
        status="pending",
        dispatch_after=dispatch_after or timezone.now(),
    )


def dispatch(run: BackupRun, agent: "Agent") -> bool:
    """Send the runner to the agent. Returns False (run stays pending) if the agent is offline."""
    from tacticalrmm.constants import AGENT_STATUS_ONLINE

    if not run.policy or not run.backend:
        finish(run, "error", "job or destination was deleted before dispatch")
        return False
    if not run.backend.enabled or not run.policy.enabled:
        finish(run, "error", "job or destination is disabled")
        return False
    if run.backend.provider == "nfs" and run.os == "windows":
        finish(run, "error", "NFS destinations are Linux-only; use SMB for Windows hosts")
        return False
    if not dispatch_allowed(agent.agent_id):
        finish(run, "error", "agent is not on this server's backup allowlist (RMM_BACKUP_AGENT_ALLOWLIST)")
        return False
    if agent.status != AGENT_STATUS_ONLINE:
        return False

    script = runner_script(run.os)
    run.token = secrets.token_hex(32)
    run.token_expires = timezone.now() + timedelta(hours=TOKEN_TTL_HOURS)
    run.status = "dispatched"
    run.dispatched_at = timezone.now()
    run.message = "sent to agent"
    run.save(update_fields=["token", "token_expires", "status", "dispatched_at", "message"])
    # no history row and no wait: the runner reports to /backup/agent/report/ on its own
    agent.run_script(
        scriptpk=script.pk,
        timeout=(run.policy.timeout_minutes + LOCK_WAIT_MINUTES) * 60,  # job time + host-lock wait
        wait=False,
        env_vars=[f"RMM_BACKUP_API={api_base_url()}", f"RMM_BACKUP_TOKEN={run.token}"],
    )
    return True


def finish(run: BackupRun, status: str, message: str) -> None:
    run.status = status
    run.message = message[:2000]
    run.finished_at = timezone.now()
    run.token = None
    run.save(update_fields=["status", "message", "finished_at", "token"])
