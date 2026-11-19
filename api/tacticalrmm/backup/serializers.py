from django.utils import timezone
from rest_framework import serializers

from .models import BackupPolicy, BackupRun, StorageBackend


class StorageBackendSerializer(serializers.ModelSerializer):
    provider_display = serializers.CharField(source="get_provider_display", read_only=True)
    client_name = serializers.SerializerMethodField()

    class Meta:
        model = StorageBackend
        fields = [
            "id", "name", "provider", "provider_display", "location",
            "client", "client_name", "retention", "bandwidth_kbps", "enabled",
        ]

    def get_client_name(self, obj):
        return obj.client.name if obj.client else None


class BackupPolicySerializer(serializers.ModelSerializer):
    client_name = serializers.SerializerMethodField()
    site_name = serializers.SerializerMethodField()
    backend_name = serializers.SerializerMethodField()

    class Meta:
        model = BackupPolicy
        fields = [
            "id", "name", "client", "client_name", "site", "site_name",
            "backend", "backend_name", "paths", "excludes", "schedule",
            "jitter_seconds", "enabled",
        ]

    def get_client_name(self, obj):
        return obj.client.name if obj.client else "All clients"

    def get_site_name(self, obj):
        return obj.site.name if obj.site else None

    def get_backend_name(self, obj):
        return obj.backend.name if obj.backend else None


class BackupRunSerializer(serializers.ModelSerializer):
    client_name = serializers.SerializerMethodField()
    site_name = serializers.SerializerMethodField()
    backend_name = serializers.SerializerMethodField()
    policy_name = serializers.SerializerMethodField()
    age_hours = serializers.SerializerMethodField()

    class Meta:
        model = BackupRun
        fields = [
            "id", "host", "client", "client_name", "site", "site_name",
            "policy", "policy_name", "backend", "backend_name", "status",
            "trigger", "bytes_added", "snapshots", "message",
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
