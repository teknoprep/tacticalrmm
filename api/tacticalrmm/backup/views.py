from django.db.models import Q
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from clients.models import Client, Site

from .models import BackupPolicy, BackupRun, StorageBackend
from .permissions import BackupPerms
from .serializers import (
    BackupPolicySerializer,
    BackupRunSerializer,
    StorageBackendSerializer,
)

STALE_HOURS = 50  # two missed nights is a ticket; one is noise (docs/04 §4.3)


def _scoped_runs(request):
    """Every query is filtered by what the user may see, never by permission alone."""
    allowed_clients = Client.objects.filter_by_role(request.user)
    runs = BackupRun.objects.select_related(
        "client", "site", "policy", "backend"
    ).filter(client__in=allowed_clients)

    site = request.query_params.get("site")
    client = request.query_params.get("client")
    if site:
        runs = runs.filter(site_id=site)
    elif client:
        runs = runs.filter(client_id=client)

    search = request.query_params.get("search")
    if search:
        runs = runs.filter(host__icontains=search)

    return runs


def _latest_per_host(runs):
    seen = {}
    for run in runs.order_by("host", "-created_time"):
        seen.setdefault(run.host, run)
    return list(seen.values())


class GetBackupSummary(APIView):
    permission_classes = [IsAuthenticated, BackupPerms]

    def get(self, request):
        runs = _latest_per_host(_scoped_runs(request))
        now = timezone.now()
        protected = stale = failing = 0
        last_run = None
        for run in runs:
            ref = run.finished_at or run.started_at or run.created_time
            age = (now - ref).total_seconds() / 3600 if ref else 10**6
            if run.status == "ok" and age <= STALE_HOURS:
                protected += 1
            elif run.status in ("error", "warn"):
                failing += 1
            else:
                stale += 1
            if ref and (last_run is None or ref > last_run):
                last_run = ref

        return Response(
            {
                "hosts": len(runs),
                "protected": protected,
                "stale": stale,
                "failing": failing,
                "stale_after_hours": STALE_HOURS,
                "last_run": last_run,
                "policies": BackupPolicy.objects.filter(enabled=True).count(),
                "backends": StorageBackend.objects.filter(enabled=True).count(),
            }
        )


class GetBackupRuns(APIView):
    permission_classes = [IsAuthenticated, BackupPerms]

    def get(self, request):
        runs = _scoped_runs(request)[:500]
        return Response(BackupRunSerializer(runs, many=True).data)


class GetBackupPolicies(APIView):
    permission_classes = [IsAuthenticated, BackupPerms]

    def get(self, request):
        allowed_clients = Client.objects.filter_by_role(request.user)
        policies = BackupPolicy.objects.select_related(
            "client", "site", "backend"
        )
        # global policies (no client) plus the user's clients
        policies = policies.filter(Q(client__in=allowed_clients) | Q(client__isnull=True))
        return Response(BackupPolicySerializer(policies, many=True).data)


class GetBackupStorage(APIView):
    permission_classes = [IsAuthenticated, BackupPerms]

    def get(self, request):
        allowed_clients = Client.objects.filter_by_role(request.user)
        backends = StorageBackend.objects.select_related("client").filter(
            Q(client__in=allowed_clients) | Q(client__isnull=True)
        )
        return Response(StorageBackendSerializer(backends, many=True).data)
