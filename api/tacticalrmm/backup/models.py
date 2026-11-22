from django.db import models

from .crypto import decrypt, encrypt


def _all_days():
    return [0, 1, 2, 3, 4, 5, 6]


class StorageBackend(models.Model):
    """A backup destination. Per company (client set) or global (client empty, superadmin).

    The provider decides how the agent reaches it:
      s3    restic's native S3 backend (AWS, Wasabi, B2-S3, MinIO, ...)
      smb   rclone's smb backend — no mount, works the same on Linux and Windows
      ftp   rclone ftp (plain or TLS)
      sftp  rclone sftp
      nfs   mounted by the runner on Linux, then a restic local repo (Windows: not supported)
      local a path on the host itself (a second disk, a USB shelf)

    Secrets (password / S3 secret key) are encrypted at rest and never returned by the API.
    """

    PROVIDERS = [
        ("s3", "S3 / object storage"),
        ("smb", "SMB / CIFS share"),
        ("nfs", "NFS export"),
        ("ftp", "FTP / FTPS"),
        ("sftp", "SFTP"),
        ("local", "Local path"),
    ]

    name = models.CharField(max_length=100)
    provider = models.CharField(max_length=10, choices=PROVIDERS, default="s3")
    location = models.CharField(max_length=255, blank=True, default="")  # legacy display field
    client = models.ForeignKey(
        "clients.Client", null=True, blank=True, on_delete=models.CASCADE,
        related_name="backup_backends",
        help_text="Empty means a global backend (superadmin).",
    )
    host = models.CharField(max_length=255, blank=True, default="")
    port = models.PositiveIntegerField(null=True, blank=True)
    share = models.CharField(
        max_length=255, blank=True, default="",
        help_text="SMB share, S3 bucket, NFS export, or FTP/SFTP base directory",
    )
    path = models.CharField(
        max_length=255, blank=True, default="",
        help_text="Sub-path / prefix inside the share or bucket",
    )
    region = models.CharField(max_length=50, blank=True, default="")
    endpoint = models.CharField(
        max_length=255, blank=True, default="",
        help_text="S3 endpoint URL for non-AWS stores, e.g. https://minio.example:9000",
    )
    username = models.CharField(
        max_length=255, blank=True, default="",
        help_text="SMB/FTP/SFTP user, or the S3 access key id",
    )
    secret_enc = models.TextField(blank=True, default="")
    tls = models.BooleanField(default=True, help_text="FTP: use explicit TLS")
    retention = models.CharField(max_length=100, blank=True, default="14d/8w/12m")
    bandwidth_kbps = models.PositiveIntegerField(
        default=0, help_text="Upload limit in KiB/s (1000 ≈ 8 Mbit). 0 = unlimited"
    )
    enabled = models.BooleanField(default=True)
    created_time = models.DateTimeField(auto_now_add=True)
    modified_time = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        verbose_name = "Backup destination"

    def __str__(self) -> str:
        return f"{self.name} ({self.get_provider_display()})"

    @property
    def secret(self) -> str:
        return decrypt(self.secret_enc)

    @secret.setter
    def secret(self, value: str) -> None:
        self.secret_enc = encrypt(value)

    @property
    def has_secret(self) -> bool:
        return bool(self.secret_enc)

    def display_location(self) -> str:
        if self.provider == "s3":
            ep = self.endpoint or f"s3.{self.region or 'us-east-1'}.amazonaws.com"
            return f"{ep}/{self.share}/{self.path}".rstrip("/")
        if self.provider == "local":
            return self.path or self.share
        host = f"{self.host}:{self.port}" if self.port else self.host
        return f"{host}/{self.share}/{self.path}".replace("//", "/").rstrip("/")


class BackupPolicy(models.Model):
    TARGET_MODES = [("servers", "All servers in scope"), ("selected", "Selected agents")]
    OS_TARGETS = [("any", "Linux and Windows"), ("linux", "Linux only"), ("windows", "Windows only")]

    name = models.CharField(max_length=100)
    client = models.ForeignKey(
        "clients.Client", null=True, blank=True, on_delete=models.CASCADE,
        related_name="backup_policies",
        help_text="Empty means a global policy (superadmin).",
    )
    site = models.ForeignKey(
        "clients.Site", null=True, blank=True, on_delete=models.CASCADE,
        related_name="backup_policies",
    )
    backend = models.ForeignKey(
        StorageBackend, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="policies",
    )
    # what to protect
    paths = models.JSONField(default=list, blank=True)            # Linux paths
    excludes = models.JSONField(default=list, blank=True)         # Linux excludes
    windows_paths = models.JSONField(default=list, blank=True)
    windows_excludes = models.JSONField(default=list, blank=True)
    os_target = models.CharField(max_length=10, choices=OS_TARGETS, default="any")
    target_mode = models.CharField(max_length=10, choices=TARGET_MODES, default="servers")
    target_agents = models.JSONField(default=list, blank=True)    # agent_id strings, always included
    exclude_agents = models.JSONField(default=list, blank=True)   # agent_id strings, never included
    timeout_minutes = models.PositiveIntegerField(default=360)
    # when
    schedule = models.CharField(max_length=100, blank=True, default="")  # legacy cron text
    schedule_time = models.CharField(max_length=5, default="02:00")      # HH:MM, policy tz
    schedule_days = models.JSONField(default=_all_days, blank=True)      # 0=Mon .. 6=Sun
    timezone = models.CharField(max_length=64, default="America/New_York")
    jitter_seconds = models.PositiveIntegerField(default=1800)
    last_dispatch_date = models.DateField(null=True, blank=True)
    # how long
    keep_daily = models.PositiveIntegerField(default=14)
    keep_weekly = models.PositiveIntegerField(default=8)
    keep_monthly = models.PositiveIntegerField(default=12)
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

    `host` is a hostname, not an Agent FK: a run can exist for a host with no agent yet, and
    removing an agent must not erase the evidence of its backups. `agent_id` is kept alongside.
    """

    STATUSES = [
        ("pending", "Pending"),        # agent offline at dispatch time; retried
        ("dispatched", "Dispatched"),  # launcher sent, runner not yet reporting
        ("running", "Running"),
        ("ok", "OK"),
        ("warn", "Warning"),
        ("error", "Error"),
    ]
    TRIGGERS = [
        ("schedule", "Schedule"),
        ("manual", "Manual"),
        ("bulk", "Bulk"),
        ("seed", "Initial seed"),
    ]

    host = models.CharField(max_length=255)
    agent_id = models.CharField(max_length=255, blank=True, default="")
    os = models.CharField(max_length=10, blank=True, default="")
    client = models.ForeignKey(
        "clients.Client", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="backup_runs",
    )
    site = models.ForeignKey(
        "clients.Site", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="backup_runs",
    )
    policy = models.ForeignKey(
        BackupPolicy, null=True, blank=True, on_delete=models.SET_NULL, related_name="runs",
    )
    backend = models.ForeignKey(
        StorageBackend, null=True, blank=True, on_delete=models.SET_NULL, related_name="runs",
    )
    status = models.CharField(max_length=10, choices=STATUSES, default="pending")
    trigger = models.CharField(max_length=10, choices=TRIGGERS, default="schedule")
    token = models.CharField(max_length=64, unique=True, null=True, blank=True)
    token_expires = models.DateTimeField(null=True, blank=True)
    dispatch_after = models.DateTimeField(null=True, blank=True)  # schedule time + jitter
    dispatched_at = models.DateTimeField(null=True, blank=True)
    bytes_added = models.BigIntegerField(default=0)
    total_bytes = models.BigIntegerField(default=0)
    files_new = models.PositiveIntegerField(default=0)
    snapshots = models.PositiveIntegerField(default=0)
    snapshot_id = models.CharField(max_length=64, blank=True, default="")
    duration_seconds = models.PositiveIntegerField(default=0)
    message = models.TextField(blank=True, default="")
    log = models.TextField(blank=True, default="")
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    created_time = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_time"]
        indexes = [models.Index(fields=["host", "-created_time"])]

    def __str__(self) -> str:
        return f"{self.host} {self.status} {self.created_time:%Y-%m-%d %H:%M}"


class BackupRepoKey(models.Model):
    """The restic repository password for one host on one destination.

    Minted on the first job for that pair and never changed casually: lose it and the repo is
    ciphertext. Encrypted at rest; escrow it (IT Notebook) — see docs/04 §4.8.
    """

    backend = models.ForeignKey(StorageBackend, on_delete=models.CASCADE, related_name="repo_keys")
    agent_id = models.CharField(max_length=255)
    host = models.CharField(max_length=255)
    # fixed at creation so a hostname or client rename does not orphan the repository
    repo_path = models.CharField(max_length=255, default="")
    password_enc = models.TextField()
    created_time = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [("backend", "agent_id")]

    @property
    def password(self) -> str:
        return decrypt(self.password_enc)


class BackupNotify(models.Model):
    """Who hears about backups, and when. Per company (client set) or global (client empty).

    - digest: a scheduled report (health + problems + CSV) for the client, or every client if global
    - failures: an email as soon as a run in scope ends in error (batched per scheduler tick)
    Recipients are plain addresses; mail goes through TRMM's own SMTP settings (Core settings).
    """

    name = models.CharField(max_length=255)
    client = models.ForeignKey(
        "clients.Client", null=True, blank=True, on_delete=models.CASCADE, related_name="backup_notify"
    )
    recipients = models.JSONField(default=list)
    digest = models.BooleanField(default=True)
    digest_time = models.CharField(max_length=5, default="07:00")  # HH:MM in `timezone`
    digest_days = models.JSONField(default=_all_days)  # 0 = Monday
    timezone = models.CharField(max_length=64, default="UTC")
    only_problems = models.BooleanField(default=False, help_text="skip the digest when everything is ok")
    failures = models.BooleanField(default=True)
    enabled = models.BooleanField(default=True)
    last_digest_date = models.DateField(null=True, blank=True)
    last_failure_check = models.DateTimeField(null=True, blank=True)
    last_sent = models.DateTimeField(null=True, blank=True)
    last_result = models.CharField(max_length=500, blank=True, default="")
    modified_time = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.name
