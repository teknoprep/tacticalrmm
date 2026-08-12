# Generated manually for AI mail tech-From allowlist

from django.db import migrations, models


def seed_blueuc(apps, schema_editor):
    CoreSettings = apps.get_model("core", "CoreSettings")
    for cs in CoreSettings.objects.all():
        domains = list(cs.ai_mail_tech_from_domains or [])
        if "blueuc.com" not in [str(d).strip().lower() for d in domains]:
            domains.append("blueuc.com")
            cs.ai_mail_tech_from_domains = domains
            cs.save(update_fields=["ai_mail_tech_from_domains"])


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0101_aitaskrun_scheduled_action_history"),
    ]

    operations = [
        migrations.AddField(
            model_name="coresettings",
            name="ai_mail_tech_from_domains",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.RunPython(seed_blueuc, migrations.RunPython.noop),
    ]
