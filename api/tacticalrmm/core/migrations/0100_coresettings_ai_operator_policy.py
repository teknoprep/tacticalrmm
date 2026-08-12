from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0099_aitask_machines_aitask_primary_role"),
    ]

    operations = [
        migrations.AddField(
            model_name="coresettings",
            name="ai_operator_allowed_agent_ids",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name="coresettings",
            name="ai_operator_default_model",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="operator_default_for",
                to="core.aimodel",
            ),
        ),
        migrations.AddField(
            model_name="coresettings",
            name="ai_operator_enabled",
            field=models.BooleanField(default=False),
        ),
    ]
