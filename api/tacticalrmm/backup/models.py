from django.db import models


class StorageBackend(models.Model):
    """A destination: the provider decides the engine (restic, rclone, PBS, ZFS).

    Credentials are deliberately *not* modelled here in the first slice — the credential plane
    (control-plane/creds.mjs) holds them, and the API must never return them. `location` is a
    non-secret pointer (a path, a bucket/prefix, a server name) that is safe to show.
    """

    PROVIDERS = [
        ("local", "Local disk"),
        ("smb", "SMB / CIFS share"),
        ("nfs", "NFS export"),
        ("ftp", "FTP / SFTP"),
        ("s3", "S3 / object storage"),
        ("pbs", "Proxmox Backup Server"),
    ]

    name = models.CharField(max_length=100)
    provider = models.CharField(max_length=10, choices=PROVIDERS, default="local")
    location = models.CharField(max_length=255, blank=True, default="")
    client = models.ForeignKey(
        "clients.Client", null=True, blank=True, on_delete=models.CASCADE,
        related_name="backup_backends",
        help_text="Empty means a global backend, usable by any client it is allowed for.",
    )
    retention = models.CharField(max_length=100, blank=True, default="14d/8w/12m")
    bandwidth_kbps = models.PositiveIntegerField(default=1000)
    enabled = models.BooleanField(default=True)
    created_time = models.DateTimeField(auto_now_add=True)
    modified_time = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        verbose_name = "Backup storage backend"

    def __str__(self) -> str:
        return f"{self.name} ({self.get_provider_display()})"


class BackupPolicy(models.Model):
    name = models.CharField(max_length=100)
    client = models.ForeignKey(
        "clients.Client", null=True, blank=True, on_delete=models.CASCADE,
        related_name="backup_policies",
        help_text="Empty means a global default policy inherited by every client.",
    )
    site = models.ForeignKey(
        "clients.Site", null=True, blank=True, on_delete=models.CASCADE,
        related_name="backup_policies",
    )
    backend = models.ForeignKey(
        StorageBackend, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="policies",
    )
    paths = models.JSONField(default=list, blank=True)
    excludes = models.JSONField(default=list, blank=True)
    schedule = models.CharField(max_length=100, blank=True, default="0 2 * * *")
    jitter_seconds = models.PositiveIntegerField(default=1800)
    enabled = models.BooleanField(default=True)
    created_time = models.DateTimeField(auto_now_add=True)
    modified_time = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        verbose_name_plural = "Backup policies"

    def __str__(self) -> str:
        return self.name


class BackupRun(models.Model):
    """One attempt to back up one host.

    `host` is a hostname, not an Agent FK: a run can exist for a host that has no RMM agent yet
    (the phase-0 case), and losing an agent must not erase the evidence of its backups.
    """

    STATUSES = [
        ("ok", "OK"),
        ("warn", "Warning"),
        ("error", "Error"),
        ("running", "Running"),
        ("pending", "Pending"),
    ]
    TRIGGERS = [
        ("schedule", "Schedule"),
        ("manual", "Manual"),
        ("bulk", "Bulk"),
        ("seed", "Initial seed"),
    ]

    host = models.CharField(max_length=255)
    client = models.ForeignKey(
        "clients.Client", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="backup_runs",
    )
    site = models.ForeignKey(
        "clients.Site", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="backup_runs",
    )
    policy = models.ForeignKey(
        BackupPolicy, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="runs",
    )
    backend = models.ForeignKey(
        StorageBackend, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="runs",
    )
    status = models.CharField(max_length=10, choices=STATUSES, default="pending")
    trigger = models.CharField(max_length=10, choices=TRIGGERS, default="schedule")
    bytes_added = models.BigIntegerField(default=0)
    snapshots = models.PositiveIntegerField(default=0)
    message = models.TextField(blank=True, default="")
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    created_time = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_time"]
        indexes = [models.Index(fields=["host", "-created_time"])]

    def __str__(self) -> str:
        return f"{self.host} {self.status} {self.created_time:%Y-%m-%d %H:%M}"
