from django.db import migrations, models

# The relay URL this deployment already runs. Seeded ONLY into an install that is
# demonstrably not fresh (see `seed_existing_deployment`), because a relay is a network
# boundary that can see routed plaintext protocol content - nobody should inherit one
# they did not choose.
BLUECLOUD_RELAY = "https://pi.api.blueuc.com"


def seed_existing_deployment(apps, schema_editor):
    """Pre-fill the relay URL on THIS server, and only on servers like it.

    `install.sh` runs migrations before anything is configured, so a brand-new box
    reaches this point with an empty AIProvider table. An install that already has a
    provider configured is one where somebody has deliberately set the AI module up -
    that is the test for "existing deployment", and it is the only case that gets a
    URL written. Everyone else keeps the blank default and the feature stays dark.

    The switch itself (`ai_remote_enabled`) is NOT turned on here. Filling in the
    address of a relay is not the same as opening the door to it.
    """
    if not apps.get_model("core", "AIProvider").objects.exists():
        return

    core = apps.get_model("core", "CoreSettings")
    core.objects.filter(ai_remote_relay_url="").update(ai_remote_relay_url=BLUECLOUD_RELAY)


def unseed(apps, schema_editor):
    core = apps.get_model("core", "CoreSettings")
    core.objects.filter(ai_remote_relay_url=BLUECLOUD_RELAY).update(ai_remote_relay_url="")


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0109_aireportschedule_autowork_readiness"),
    ]

    operations = [
        migrations.AddField(
            model_name="coresettings",
            name="ai_remote_enabled",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="coresettings",
            name="ai_remote_relay_url",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
        migrations.RunPython(seed_existing_deployment, unseed),
    ]
