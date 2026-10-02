from django.db import migrations, models


def copy_group_to_groups(apps, schema_editor):
    """One key used to carry exactly one group; carry it over to the new list."""
    AIRelayKey = apps.get_model("core", "AIRelayKey")
    for key in AIRelayKey.objects.all().iterator():
        if key.group_id:
            key.groups.add(key.group_id)


def copy_groups_back_to_group(apps, schema_editor):
    """Reverse: keep the first group (the old field only held one)."""
    AIRelayKey = apps.get_model("core", "AIRelayKey")
    for key in AIRelayKey.objects.all().iterator():
        first = key.groups.order_by("id").first()
        if first:
            key.group_id = first.id
            key.save(update_fields=["group"])


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0130_ai_relay_key_install_email"),
    ]

    operations = [
        migrations.AddField(
            model_name="airelaykey",
            name="groups",
            field=models.ManyToManyField(related_name="relay_keys", to="core.aiagentgroup"),
        ),
        migrations.RunPython(copy_group_to_groups, copy_groups_back_to_group),
        migrations.RemoveField(
            model_name="airelaykey",
            name="group",
        ),
    ]
