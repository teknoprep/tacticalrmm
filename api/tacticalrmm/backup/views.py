import base64

from django.db import transaction
from django.db.models import Q
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from agents.models import Agent
from clients.models import Client
from tacticalrmm.permissions import _has_perm_on_agent

from . import logic, notify, report
from .models import BackupNotify, BackupPolicy, BackupRun, StorageBackend
from .permissions import BackupPerms
from .serializers import (
    BackupNotifySerializer,
    BackupPolicySerializer,
    BackupRunSerializer,
    StorageBackendSerializer,
    _is_superuser,
)

STALE_HOURS = report.STALE_HOURS


# --------------------------------------------------------------------------- scoping helpers

def _allowed_clients(request):
    return Client.objects.filter_by_role(request.user)


def _qint(request, name, default=None):
    """A numeric query parameter, or ValidationError (400) — never a 500 on ?site=abc."""
    v = request.query_params.get(name)
    if v in (None, ""):
        return default
    try:
        return int(v)
    except (TypeError, ValueError):
        raise ValidationError({name: "must be a number"})


def _scope_filter(qs, request, client_field="client", site_field="site"):
    site = _qint(request, "site")
    client = _qint(request, "client")
    if site:
        return qs.filter(**{f"{site_field}_id": site})
    if client:
        return qs.filter(**{f"{client_field}_id": client})
    return qs


def _scoped_runs(request):
    """Every query is filtered by what the user may see, never by permission alone."""
    runs = BackupRun.objects.select_related("client", "site", "policy", "backend").filter(
        client__in=_allowed_clients(request)
    )
    runs = _scope_filter(runs, request)
    if request.query_params.get("agent_id"):
        runs = runs.filter(agent_id=request.query_params["agent_id"])
    policy = _qint(request, "policy")
    if policy:
        runs = runs.filter(policy_id=policy)
    status = request.query_params.get("status")
    if status == "running":
        runs = runs.filter(status__in=["dispatched", "running"])
    elif status:
        runs = runs.filter(status=status)
    return runs


def _scoped_jobs(request):
    jobs = BackupPolicy.objects.select_related("client", "site", "backend").filter(
        Q(client__in=_allowed_clients(request)) | Q(client__isnull=True)
    )
    client = _qint(request, "client")
    site = _qint(request, "site")
    if site:
        jobs = jobs.filter(Q(site_id=site) | Q(site__isnull=True)).filter(
            Q(client__sites__id=site) | Q(client__isnull=True)
        )
    elif client:
        jobs = jobs.filter(Q(client_id=client) | Q(client__isnull=True))
    return jobs.distinct()


def _scoped_agents(request):
    agents = (
        Agent.objects.filter_by_role(request.user)
        .select_related("site", "site__client")
        .defer("wmi_detail", "services")
        .filter(plat__in=["linux", "windows"])
    )
    agents = _scope_filter(agents, request, client_field="site__client", site_field="site")
    return agents


def _latest_runs(agent_ids):
    latest = {}
    for run in (
        BackupRun.objects.select_related("policy", "backend")
        .filter(agent_id__in=agent_ids)
        .exclude(status__in=["pending"])
        .order_by("agent_id", "-created_time")
        .distinct("agent_id")
    ):
        latest[run.agent_id] = run
    return latest


# --------------------------------------------------------------------------- summary + runs

class GetBackupSummary(APIView):
    permission_classes = [IsAuthenticated, BackupPerms]

    def get(self, request):
        jobs = [j for j in _scoped_jobs(request) if j.enabled]
        agents = [a for a in _scoped_agents(request) if logic.jobs_for_agent(a, jobs)]
        latest = report.latest_by_pair([a.agent_id for a in agents])
        counts = report.empty_counts()
        last_run = None
        for a in agents:
            counts[report.worst(r["health"] for r in report.host_jobs(a, jobs, latest))] += 1
        for run in latest.values():
            if run.finished_at and (last_run is None or run.finished_at > last_run):
                last_run = run.finished_at
        return Response(
            {
                "hosts": len(agents),
                "protected": counts["ok"] + counts["warn"],
                "stale": counts["stale"] + counts["never"],
                "never": counts["never"],
                "failing": counts["failing"],
                "running": counts["running"],
                "stale_after_hours": STALE_HOURS,
                "last_run": last_run,
                "jobs": len(jobs),
                "locations": StorageBackend.objects.filter(
                    Q(client__in=_allowed_clients(request)) | Q(client__isnull=True), enabled=True
                ).count(),
            }
        )


class GetRunBackupRuns(APIView):
    permission_classes = [IsAuthenticated, BackupPerms]

    def get(self, request):
        limit = max(1, min(_qint(request, "limit", 500), 2000))
        runs = _scoped_runs(request)[:limit]
        return Response(BackupRunSerializer(runs, many=True).data)

    def post(self, request):
        """Run now: {"policy": id, "agent_ids": [...]} — each host must be covered by the job."""
        try:
            job_id = int(request.data.get("policy"))
        except (TypeError, ValueError):
            raise ValidationError({"policy": "must be a job id"})
        job = get_object_or_404(_scoped_jobs(request), pk=job_id)
        if not job.backend:
            return Response({"detail": "This job has no location."}, status=400)
        ids = request.data.get("agent_ids") or []
        if not isinstance(ids, list) or not ids:
            return Response({"detail": "agent_ids is required."}, status=400)
        results = []
        for agent in _scoped_agents(request).filter(agent_id__in=ids):
            if not _has_perm_on_agent(request.user, agent.agent_id):
                continue
            if not logic.job_covers(job, agent):
                results.append({"host": agent.hostname, "result": "not covered by this job"})
                continue
            if BackupRun.objects.filter(
                policy=job, agent_id=agent.agent_id, status__in=["pending", "dispatched", "running"]
            ).exists():
                results.append({"host": agent.hostname, "result": "already queued or running"})
                continue
            run = logic.new_run(job, agent, "manual")
            sent = logic.dispatch(run, agent)
            run.refresh_from_db()
            results.append(
                {
                    "host": agent.hostname,
                    "run": run.id,
                    "result": "sent" if sent else (
                        run.message if run.status == "error" else "agent offline — queued until it is back"
                    ),
                }
            )
        return Response(results)


# --------------------------------------------------------------------------- locations

class GetAddStorage(APIView):
    permission_classes = [IsAuthenticated, BackupPerms]

    def _qs(self, request):
        qs = StorageBackend.objects.select_related("client").filter(
            Q(client__in=_allowed_clients(request)) | Q(client__isnull=True)
        )
        client = _qint(request, "client")
        if client:
            qs = qs.filter(Q(client_id=client) | Q(client__isnull=True))
        return qs

    def get(self, request):
        return Response(StorageBackendSerializer(self._qs(request), many=True).data)

    def post(self, request):
        s = StorageBackendSerializer(data=request.data, context={"request": request})
        s.is_valid(raise_exception=True)
        obj = s.save()
        return Response(StorageBackendSerializer(obj).data)


class GetUpdateDeleteStorage(GetAddStorage):
    def get(self, request, pk):
        return Response(StorageBackendSerializer(get_object_or_404(self._qs(request), pk=pk)).data)

    def put(self, request, pk):
        obj = get_object_or_404(self._qs(request), pk=pk)
        s = StorageBackendSerializer(obj, data=request.data, partial=True, context={"request": request})
        s.is_valid(raise_exception=True)
        return Response(StorageBackendSerializer(s.save()).data)

    def delete(self, request, pk):
        obj = get_object_or_404(self._qs(request), pk=pk)
        used = list(obj.policies.values_list("name", flat=True))
        if used:
            return Response(
                {"detail": f"Still used by job(s): {', '.join(used)}. Move them to another location first."},
                status=400,
            )
        if obj.repo_keys.exists():
            return Response(
                {"detail": "Hosts have repositories on this location. Disable it instead — deleting it "
                           "would delete the only copy of their repository passwords."},
                status=400,
            )
        obj.delete()
        return Response("ok")


# --------------------------------------------------------------------------- jobs

class GetAddJobs(APIView):
    permission_classes = [IsAuthenticated, BackupPerms]

    def get(self, request):
        jobs = list(_scoped_jobs(request))
        agents = list(_scoped_agents(request))
        latest = report.latest_by_pair([a.agent_id for a in agents])
        data = BackupPolicySerializer(jobs, many=True).data
        for row, job in zip(data, jobs):
            covered = [a for a in agents if logic.job_covers(job, a)]
            health = report.empty_counts()
            for a in covered:
                health[report.health(latest.get((a.agent_id, job.id)))] += 1
            row["covered"] = len(covered)
            row["health"] = health
        return Response(data)

    def post(self, request):
        s = BackupPolicySerializer(data=request.data, context={"request": request})
        s.is_valid(raise_exception=True)
        return Response(BackupPolicySerializer(s.save()).data)


class GetUpdateDeleteJob(APIView):
    permission_classes = [IsAuthenticated, BackupPerms]

    def get(self, request, pk):
        return Response(BackupPolicySerializer(get_object_or_404(_scoped_jobs(request), pk=pk)).data)

    def put(self, request, pk):
        job = get_object_or_404(_scoped_jobs(request), pk=pk)
        s = BackupPolicySerializer(job, data=request.data, partial=True, context={"request": request})
        s.is_valid(raise_exception=True)
        return Response(BackupPolicySerializer(s.save()).data)

    def delete(self, request, pk):
        job = get_object_or_404(_scoped_jobs(request), pk=pk)
        # runs keep their history (policy FK is SET_NULL); repositories are untouched
        job.delete()
        return Response("ok")


# --------------------------------------------------------------------------- hosts

class GetBackupHosts(APIView):
    """Every Linux/Windows agent in scope, with the jobs that cover it and its last result."""

    permission_classes = [IsAuthenticated, BackupPerms]

    def get(self, request):
        show_all = request.query_params.get("all") == "1"
        jobs = list(_scoped_jobs(request))
        agents = list(_scoped_agents(request))
        latest = _latest_runs([a.agent_id for a in agents])
        pairs = report.latest_by_pair([a.agent_id for a in agents])
        rows = []
        for a in agents:
            covering = logic.jobs_for_agent(a, jobs)
            per_job = {r["id"]: r["health"] for r in report.host_jobs(a, covering, pairs)}
            if not covering and not show_all and a.monitoring_type != "server":
                continue
            run = latest.get(a.agent_id)
            rows.append(
                {
                    "agent_id": a.agent_id,
                    "host": a.hostname,
                    "os": a.plat,
                    "monitoring_type": a.monitoring_type,
                    "client": a.site.client_id,
                    "client_name": a.site.client.name,
                    "site": a.site_id,
                    "site_name": a.site.name,
                    "agent_status": a.status,
                    "jobs": [
                        {"id": j.id, "name": j.name, "enabled": j.enabled, "health": per_job.get(j.id, "disabled")}
                        for j in covering
                    ],
                    "health": report.worst(per_job.values()) if per_job else (
                        "disabled" if covering else "unprotected"
                    ),
                    "last_run": BackupRunSerializer(run).data if run else None,
                }
            )
        rows.sort(key=lambda r: (r["client_name"].lower(), r["host"].lower()))
        return Response(rows)


class UpdateBackupHost(APIView):
    """PUT {"jobs": [ids]} — the full set of jobs this host should be in (of the ones in scope)."""

    permission_classes = [IsAuthenticated, BackupPerms]

    def put(self, request, agent_id):
        agent = get_object_or_404(_scoped_agents(request), agent_id=agent_id)
        try:
            wanted = {int(i) for i in request.data.get("jobs", [])}
        except (TypeError, ValueError):
            raise ValidationError({"jobs": "must be a list of job ids"})
        todo = []
        for job in _scoped_jobs(request):
            if not logic.job_in_scope_for(job, agent):
                continue
            include = job.id in wanted
            if logic.job_covers(job, agent) == include:
                continue
            if include and job.os_target not in ("any", logic.agent_os(agent)):
                return Response(
                    {"detail": f"'{job.name}' is {job.os_target}-only; {agent.hostname} is {agent.plat}."},
                    status=400,
                )
            todo.append((job, include))
        changed = []
        with transaction.atomic():
            for job, include in todo:
                if logic.set_host_membership(job, agent.agent_id, agent, include):
                    job.save(update_fields=["target_agents", "exclude_agents", "modified_time"])
                    changed.append(job.name)
        return Response({"changed": changed})


# --------------------------------------------------------------------------- reporting

class GetBackupReport(APIView):
    """GET ?client=&site=&days=7[&as=csv] — per-client rollup, problem list, host+job rows."""

    permission_classes = [IsAuthenticated, BackupPerms]

    def get(self, request):
        days = max(1, min(_qint(request, "days", 7), 90))
        rep = report.build(_scoped_agents(request), _scoped_jobs(request), days=days)
        if request.query_params.get("as") == "csv":
            resp = HttpResponse(report.to_csv(rep), content_type="text/csv")
            resp["Content-Disposition"] = f'attachment; filename="backup-report-{timezone.now():%Y%m%d}.csv"'
            return resp
        return Response(rep)


class GetAddNotify(APIView):
    permission_classes = [IsAuthenticated, BackupPerms]

    def _qs(self, request):
        qs = BackupNotify.objects.select_related("client").filter(
            Q(client__in=_allowed_clients(request)) | Q(client__isnull=True)
        )
        client = _qint(request, "client")
        if client:
            qs = qs.filter(Q(client_id=client) | Q(client__isnull=True))
        return qs.order_by("client__name", "name")

    def get(self, request):
        return Response(BackupNotifySerializer(self._qs(request), many=True).data)

    def post(self, request):
        s = BackupNotifySerializer(data=request.data, context={"request": request})
        s.is_valid(raise_exception=True)
        return Response(BackupNotifySerializer(s.save()).data)


class GetUpdateDeleteNotify(GetAddNotify):
    def get(self, request, pk):
        return Response(BackupNotifySerializer(get_object_or_404(self._qs(request), pk=pk)).data)

    def put(self, request, pk):
        obj = get_object_or_404(self._qs(request), pk=pk)
        s = BackupNotifySerializer(obj, data=request.data, partial=True, context={"request": request})
        s.is_valid(raise_exception=True)
        return Response(BackupNotifySerializer(s.save()).data)

    def delete(self, request, pk):
        get_object_or_404(self._qs(request), pk=pk).delete()
        return Response("ok")


class SendNotify(GetAddNotify):
    """POST — send this rule's digest now (ignores only_problems), to its recipients."""

    def post(self, request, pk):
        n = get_object_or_404(self._qs(request), pk=pk)
        if n.client_id is None and not _is_superuser(request.user):
            return Response({"detail": "Only a superuser can send the all-clients report."}, status=403)
        only = n.only_problems
        n.only_problems = False
        out = []
        ok, res = notify.send_digest(n, log=out.append)
        n.only_problems = only
        BackupNotify.objects.filter(pk=n.pk).update(
            last_result=res[:500], **({"last_sent": timezone.now()} if res.startswith(("sent", "dry run")) else {})
        )
        return Response({"ok": ok, "result": res, "preview": "\n".join(out)[:20000]}, status=200 if ok else 400)


# --------------------------------------------------------------------------- agent side

def _run_for_token(request):
    token = request.headers.get("X-Backup-Token", "")
    if len(token) != 64:
        return None
    return (
        BackupRun.objects.select_related("policy", "backend")
        .filter(token=token, token_expires__gt=timezone.now())
        .first()
    )


def _env_doc(doc: dict) -> str:
    """KEY=base64(value) lines, so a POSIX shell runner needs no JSON parser."""
    flat = {}
    for k, v in doc.items():
        if k == "dest":
            for dk, dv in v.items():
                flat[f"D_{dk}"] = dv
        elif k == "tools":
            flat["RESTIC_VERSION"] = v["restic_version"]
            flat["RCLONE_VERSION"] = v["rclone_version"]
            for tool in ("restic", "rclone"):
                for arch, sha in v[tool].items():
                    flat[f"SHA_{tool}_{arch}".replace("-", "_")] = sha
        else:
            flat[k] = v
    lines = []
    for k, v in flat.items():
        if isinstance(v, bool):
            v = "1" if v else "0"
        elif isinstance(v, list):
            v = "\n".join(v)
        elif v is None:
            v = ""
        lines.append(f"{k.upper()}={base64.b64encode(str(v).encode()).decode()}")
    return "\n".join(lines) + "\n"


class AgentJob(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        run = _run_for_token(request)
        if run is None or run.status not in ("dispatched", "running"):
            return Response({"detail": "invalid or expired token"}, status=403)
        agent = Agent.objects.select_related("site", "site__client").filter(agent_id=run.agent_id).first()
        if agent is None or not run.policy or not run.backend:
            logic.finish(run, "error", "agent, job or location no longer exists")
            return Response({"detail": "gone"}, status=410)
        doc = logic.job_document(run, agent)
        # not "?format=": DRF reserves that for renderer negotiation and answers 404
        if request.query_params.get("as") == "env":
            return HttpResponse(_env_doc(doc), content_type="text/plain")
        return Response(doc)


class AgentReport(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    INT_FIELDS = ("bytes_added", "total_bytes", "files_new", "snapshots", "duration_seconds")

    def post(self, request):
        run = _run_for_token(request)
        if run is None:
            return Response({"detail": "invalid or expired token"}, status=403)
        d = request.data
        phase = d.get("phase")
        if phase == "start":
            run.status = "running"
            run.started_at = timezone.now()
            run.message = str(d.get("message", "running"))[:2000]
            run.save(update_fields=["status", "started_at", "message"])
            return Response("ok")
        if phase != "done":
            return Response({"detail": "phase must be start or done"}, status=400)
        status = d.get("status")
        if status not in ("ok", "warn", "error"):
            status = "error"
        for f in self.INT_FIELDS:
            try:
                setattr(run, f, max(0, int(d.get(f) or 0)))
            except (TypeError, ValueError):
                pass
        run.snapshot_id = str(d.get("snapshot_id", ""))[:64]
        run.log = str(d.get("log", ""))[-65536:]
        run.save(update_fields=[*self.INT_FIELDS, "snapshot_id", "log"])
        logic.finish(run, status, str(d.get("message", "")))
        return Response("ok")


class GetRunLog(APIView):
    permission_classes = [IsAuthenticated, BackupPerms]

    def get(self, request, pk):
        run = get_object_or_404(_scoped_runs(request), pk=pk)
        return Response({"id": run.id, "log": run.log, "message": run.message})
