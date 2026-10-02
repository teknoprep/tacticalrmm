from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0136_ai_subject_statements"),
    ]

    operations = [
        migrations.CreateModel(
            name="AIAutomationApproval",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("ticket_ref", models.CharField(db_index=True, max_length=120)),
                ("rule_digest", models.CharField(max_length=64)),
                ("plan", models.JSONField(blank=True, default=dict)),
                ("plan_digest", models.CharField(max_length=64)),
                ("proposed_by", models.CharField(blank=True, default="", max_length=150)),
                ("approved_at", models.DateTimeField(blank=True, null=True)),
                ("approved_by", models.CharField(blank=True, default="", max_length=150)),
                ("approver_capacity", models.CharField(
                    blank=True,
                    choices=[("technician", "One of our technicians"),
                             ("support_contact", "A support contact for the customer")],
                    default="", max_length=20)),
                ("expires_at", models.DateTimeField(blank=True, null=True)),
                ("declined_at", models.DateTimeField(blank=True, null=True)),
                ("declined_by", models.CharField(blank=True, default="", max_length=150)),
                ("decline_reason", models.CharField(blank=True, default="", max_length=200)),
                ("revoked_at", models.DateTimeField(blank=True, null=True)),
                ("created", models.DateTimeField(auto_now_add=True)),
                ("subject", models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name="approvals", to="core.aiticketautomationsubject")),
            ],
        ),
        migrations.AddIndex(
            model_name="aiautomationapproval",
            index=models.Index(fields=["ticket_ref", "subject"], name="core_aiauto_ticket__7f1a3c_idx"),
        ),
    ]
