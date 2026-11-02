"""The Ticket Console "Complete this ticket" run (owner, 2026-10-15).

One row per human-initiated run: mode (read-only / fix), live progress, the durable transcript,
and - when the run succeeded - the automation rule and the procedures it used, held as PROPOSED
until a person approves them. Approving writes the real AIProcedure rows and the
AITicketAutomationSubject (see core/ai_completion.py).

Additive and inert: nothing reads this table until the console button calls the new endpoints.
"""

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0142_subject_allow_safe_bypass")]

    operations = [
        migrations.CreateModel(
            name="AITicketCompletion",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("ticket_ref", models.CharField(db_index=True, max_length=100)),
                ("mode", models.CharField(choices=[("readonly", "Read-only and report"), ("fix", "Fix and report")], default="readonly", max_length=10)),
                ("status", models.CharField(choices=[("running", "Running"), ("awaiting_review", "Awaiting review"), ("approved", "Approved"), ("declined", "Declined"), ("error", "Error")], default="running", max_length=20)),
                ("started_by", models.CharField(blank=True, default="", max_length=150)),
                ("run_id", models.CharField(max_length=64, unique=True)),
                ("prior_findings", models.TextField(blank=True, default="")),
                ("summary", models.TextField(blank=True, default="")),
                ("verdict", models.JSONField(blank=True, default=dict)),
                ("events", models.JSONField(blank=True, default=list)),
                ("fix_applied", models.JSONField(blank=True, default=list)),
                ("fix_broken", models.JSONField(blank=True, default=dict)),
                ("proposed_procedures", models.JSONField(blank=True, default=list)),
                ("proposed_rule", models.JSONField(blank=True, default=dict)),
                ("applied_procedure_ids", models.JSONField(blank=True, default=list)),
                ("applied_subject_id", models.IntegerField(blank=True, null=True)),
                ("error_detail", models.TextField(blank=True, default="")),
                ("created", models.DateTimeField(auto_now_add=True)),
                ("updated", models.DateTimeField(auto_now=True)),
                ("subject", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="completions", to="core.aiticketautomationsubject")),
            ],
            options={
                "ordering": ["-created"],
                "indexes": [models.Index(fields=["ticket_ref", "-created"], name="core_aitick_ticket__7c1a2b_idx")],
            },
        ),
    ]
