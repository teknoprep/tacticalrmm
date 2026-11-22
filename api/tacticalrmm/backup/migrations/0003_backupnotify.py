import django.db.models.deletion
from django.db import migrations, models

import backup.models


class Migration(migrations.Migration):
    dependencies = [
        ("clients", "0024_alter_deployment_goarch"),
        ("backup", "0002_jobs_hosts_agent_api"),
    ]

    operations = [
        migrations.CreateModel(
            name="BackupNotify",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=255)),
                ("recipients", models.JSONField(default=list)),
                ("digest", models.BooleanField(default=True)),
                ("digest_time", models.CharField(default="07:00", max_length=5)),
                ("digest_days", models.JSONField(default=backup.models._all_days)),
                ("timezone", models.CharField(default="UTC", max_length=64)),
                ("only_problems", models.BooleanField(default=False, help_text="skip the digest when everything is ok")),
                ("failures", models.BooleanField(default=True)),
                ("enabled", models.BooleanField(default=True)),
                ("last_digest_date", models.DateField(blank=True, null=True)),
                ("last_failure_check", models.DateTimeField(blank=True, null=True)),
                ("last_sent", models.DateTimeField(blank=True, null=True)),
                ("last_result", models.CharField(blank=True, default="", max_length=500)),
                ("modified_time", models.DateTimeField(auto_now=True)),
                ("client", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE,
                                             related_name="backup_notify", to="clients.client")),
            ],
        ),
    ]
