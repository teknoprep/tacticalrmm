import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.utils import timezone
from rest_framework import serializers

from tacticalrmm.permissions import _has_perm_on_client

from .models import BackupNotify, BackupPolicy, BackupRun, StorageBackend


def _is_superuser(user) -> bool:
    role = getattr(user, "role", None)
    return bool(user.is_superuser or (role and getattr(role, "is_superuser", False)))


def _check_client(serializer, client):
    request = serializer.context["request"]
    if client is None:
        if not _is_superuser(request.user):
            raise serializers.ValidationError({"client": "Only a superuser can create a global item."})
        return
    if not _has_perm_on_client(request.user, client.pk):
        raise serializers.ValidationError({"client": "You do not have access to this client."})


def _str_list(value, field):
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise serializers.ValidationError({field: "Must be a list of strings."})
    return [v.strip() for v in value if v.strip()]


class StorageBackendSerializer(serializers.ModelSerializer):
    provider_display = serializers.CharField(source="get_provider_display", read_only=True)
    client_name = serializers.SerializerMethodField()
    display = serializers.SerializerMethodField()
    has_secret = serializers.BooleanField(read_only=True)
    jobs = serializers.SerializerMethodField()
    # write-only: blank on update = keep what is stored
    secret = serializers.CharField(write_only=True, required=False, allow_blank=True, trim_whitespace=False)
    clear_secret = serializers.BooleanField(write_only=True, required=False, default=False)

    class Meta:
        model = StorageBackend
        fields = [
            "id", "name", "provider", "provider_display", "client", "client_name",
            "host", "port", "share", "path", "region", "endpoint", "username", "tls",
            "bandwidth_kbps", "enabled", "display", "has_secret", "jobs",
            "secret", "clear_secret", "modified_time",
        ]
        read_only_fields = ["modified_time"]

    def get_client_name(self, obj):
        return obj.client.name if obj.client else None

    def get_display(self, obj):
        return obj.display_location()

    def get_jobs(self, obj):
        return obj.policies.count()

    def validate(self, data):
        if self.instance is None or "client" in data:
            _check_client(self, data.get("client", getattr(self.instance, "client", None)))
        provider = data.get("provider", getattr(self.instance, "provider", "s3"))
        get = lambda k: data.get(k, getattr(self.instance, k, "") if self.instance else "")  # noqa: E731
        need = {
            "s3": ["share"],
            "smb": ["host", "share"],
            "nfs": ["host", "share"],
            "ftp": ["host"],
            "sftp": ["host"],
            "local": ["path"],
        }[provider]
        labels = {"share": "bucket / share / export", "host": "host", "path": "path"}
        missing = [labels[k] for k in need if not get(k)]
        if missing:
            raise serializers.ValidationError(f"{provider.upper()} needs: {', '.join(missing)}")
        if provider == "s3" and get("endpoint") and not re.match(r"^https?://", get("endpoint")):
            raise serializers.ValidationError({"endpoint": "Must start with https:// or http://"})
        return data

    def _apply_secret(self, instance, secret, clear):
        if clear:
            instance.secret_enc = ""
        elif secret:
            instance.secret = secret

    def create(self, validated):
        secret = validated.pop("secret", "")
        clear = validated.pop("clear_secret", False)
        instance = StorageBackend(**validated)
        self._apply_secret(instance, secret, clear)
        instance.save()
        return instance

    def update(self, instance, validated):
        secret = validated.pop("secret", "")
        clear = validated.pop("clear_secret", False)
        for k, v in validated.items():
            setattr(instance, k, v)
        self._apply_secret(instance, secret, clear)
        instance.save()
        return instance


class BackupPolicySerializer(serializers.ModelSerializer):
    client_name = serializers.SerializerMethodField()
    site_name = serializers.SerializerMethodField()
    backend_name = serializers.SerializerMethodField()
    backend_provider = serializers.SerializerMethodField()

    class Meta:
        model = BackupPolicy
        fields = [
            "id", "name", "client", "client_name", "site", "site_name",
            "backend", "backend_name", "backend_provider",
            "paths", "excludes", "windows_paths", "windows_excludes",
            "os_target", "target_mode", "target_agents", "exclude_agents",
            "schedule_time", "schedule_days", "timezone", "jitter_seconds", "timeout_minutes",
            "keep_daily", "keep_weekly", "keep_monthly", "enabled", "modified_time",
        ]
        read_only_fields = ["modified_time"]

    def get_client_name(self, obj):
        return obj.client.name if obj.client else "All clients"

    def get_site_name(self, obj):
        return obj.site.name if obj.site else None

    def get_backend_name(self, obj):
        return obj.backend.name if obj.backend else None

    def get_backend_provider(self, obj):
        return obj.backend.provider if obj.backend else None

    def validate(self, data):
        inst = self.instance
        client = data.get("client", getattr(inst, "client", None))
        site = data.get("site", getattr(inst, "site", None))
        backend = data.get("backend", getattr(inst, "backend", None))
        if inst is None or "client" in data:
            _check_client(self, client)
        if site and (client is None or site.client_id != client.pk):
            raise serializers.ValidationError({"site": "Site must belong to the job's client."})
        if backend is None:
            raise serializers.ValidationError({"backend": "Pick a backup location."})
        if backend.client_id and (client is None or backend.client_id != client.pk):
            raise serializers.ValidationError(
                {"backend": "That location belongs to another client. Use one of this client's or a global one."}
            )
        for f in ("paths", "excludes", "windows_paths", "windows_excludes", "target_agents", "exclude_agents"):
            if f in data:
                data[f] = _str_list(data[f], f)
        if "schedule_time" in data and not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", data["schedule_time"]):
            raise serializers.ValidationError({"schedule_time": "Use HH:MM (24h)."})
        if "schedule_days" in data:
            days = data["schedule_days"]
            if not isinstance(days, list) or not all(isinstance(d, int) and 0 <= d <= 6 for d in days):
                raise serializers.ValidationError({"schedule_days": "Days are 0 (Mon) .. 6 (Sun)."})
            data["schedule_days"] = sorted(set(days))
        if "timezone" in data:
            try:
                ZoneInfo(data["timezone"])
            except (ZoneInfoNotFoundError, ValueError):
                raise serializers.ValidationError({"timezone": "Unknown time zone."})
        os_target = data.get("os_target", getattr(inst, "os_target", "any"))
        lp = data.get("paths", getattr(inst, "paths", []))
        wp = data.get("windows_paths", getattr(inst, "windows_paths", []))
        if os_target in ("any", "linux") and not lp:
            raise serializers.ValidationError({"paths": "Add at least one Linux path (or set the job to Windows only)."})
        if os_target in ("any", "windows") and not wp:
            raise serializers.ValidationError({"windows_paths": "Add at least one Windows path (or set the job to Linux only)."})
        if backend.provider == "nfs" and os_target != "linux":
            raise serializers.ValidationError({"backend": "NFS locations are Linux-only. Set the job to Linux only, or use SMB."})
        return data


class BackupRunSerializer(serializers.ModelSerializer):
    client_name = serializers.SerializerMethodField()
    site_name = serializers.SerializerMethodField()
    backend_name = serializers.SerializerMethodField()
    policy_name = serializers.SerializerMethodField()
    age_hours = serializers.SerializerMethodField()

    class Meta:
        model = BackupRun
        fields = [
            "id", "host", "agent_id", "os", "client", "client_name", "site", "site_name",
            "policy", "policy_name", "backend", "backend_name", "status",
            "trigger", "bytes_added", "total_bytes", "files_new", "snapshots", "snapshot_id",
            "duration_seconds", "message", "dispatch_after", "dispatched_at",
            "started_at", "finished_at", "created_time", "age_hours",
        ]

    def get_client_name(self, obj):
        return obj.client.name if obj.client else None

    def get_site_name(self, obj):
        return obj.site.name if obj.site else None

    def get_backend_name(self, obj):
        return obj.backend.name if obj.backend else None

    def get_policy_name(self, obj):
        return obj.policy.name if obj.policy else None

    def get_age_hours(self, obj):
        ref = obj.finished_at or obj.started_at or obj.created_time
        if not ref:
            return None
        return round((timezone.now() - ref).total_seconds() / 3600, 1)


EMAIL_RE = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$")


class BackupNotifySerializer(serializers.ModelSerializer):
    client_name = serializers.SerializerMethodField()

    class Meta:
        model = BackupNotify
        fields = [
            "id", "name", "client", "client_name", "recipients", "digest", "digest_time", "digest_days",
            "timezone", "only_problems", "failures", "enabled", "last_digest_date", "last_sent",
            "last_result", "modified_time",
        ]
        read_only_fields = ["last_digest_date", "last_sent", "last_result", "modified_time"]

    def get_client_name(self, obj):
        return obj.client.name if obj.client else "All clients"

    def validate(self, data):
        inst = self.instance
        if inst is None or "client" in data:
            _check_client(self, data.get("client", getattr(inst, "client", None)))
        if "recipients" in data:
            rec = data["recipients"]
            if isinstance(rec, str):
                rec = re.split(r"[\s,;]+", rec)
            rec = _str_list(rec, "recipients")
            bad = [r for r in rec if not EMAIL_RE.match(r)]
            if bad:
                raise serializers.ValidationError({"recipients": f"Not an email address: {', '.join(bad[:3])}"})
            data["recipients"] = sorted(set(rec), key=rec.index)
        if not data.get("recipients", getattr(inst, "recipients", [])):
            raise serializers.ValidationError({"recipients": "Add at least one recipient."})
        if "digest_time" in data and not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", data["digest_time"]):
            raise serializers.ValidationError({"digest_time": "Use HH:MM (24h)."})
        if "digest_days" in data:
            days = data["digest_days"]
            if not isinstance(days, list) or not all(isinstance(d, int) and 0 <= d <= 6 for d in days):
                raise serializers.ValidationError({"digest_days": "Days are 0 (Mon) .. 6 (Sun)."})
            data["digest_days"] = sorted(set(days))
        if "timezone" in data:
            try:
                ZoneInfo(data["timezone"])
            except (ZoneInfoNotFoundError, ValueError):
                raise serializers.ValidationError({"timezone": "Unknown time zone."})
        return data
