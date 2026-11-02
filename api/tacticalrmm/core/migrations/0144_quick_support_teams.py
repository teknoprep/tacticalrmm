"""Quick Support queue: Teams notification settings (2026-11-02).

Hand-written on purpose: it carries ONLY these two additive CoreSettings fields. The tree has
unrelated pending model drift (index renames, aiticketcompletion.id, logs choices) that belongs
in its own migration, not hidden inside this one.
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0143_ai_ticket_completion")]

    operations = [
        migrations.AddField(
            model_name="coresettings",
            name="quick_support_teams_enabled",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="coresettings",
            name="quick_support_teams_webhook",
            field=models.TextField(blank=True, default=""),
        ),
    ]
