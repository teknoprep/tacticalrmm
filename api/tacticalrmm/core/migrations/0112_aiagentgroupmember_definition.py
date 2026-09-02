from django.db import migrations, models


def fill_definitions(apps, schema_editor):
    try:
        from core.agent_groups import ROLE_DEFINITIONS
    except Exception:
        return
    Member = apps.get_model("core", "AIAgentGroupMember")
    for m in Member.objects.all():
        if (m.definition or "").strip():
            continue
        text = ROLE_DEFINITIONS.get(m.role) or ""
        if text:
            m.definition = text
            m.save(update_fields=["definition"])


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0111_ai_agent_groups"),
    ]

    operations = [
        migrations.AddField(
            model_name="aiagentgroupmember",
            name="definition",
            field=models.TextField(
                blank=True,
                default="",
                help_text="What this role does. Sent to the specialist as its job description.",
            ),
        ),
        migrations.RunPython(fill_definitions, noop),
    ]
