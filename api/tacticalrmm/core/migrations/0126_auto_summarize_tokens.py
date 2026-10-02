from django.db import migrations, models


def luna_groups_200k(apps, schema_editor):
    G = apps.get_model("core", "AIAgentGroup")
    G.objects.filter(slug__in=["it-luna", "coding-luna"]).update(auto_summarize_tokens=200000)


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0125_subject_extension_proposals"),
    ]

    operations = [
        migrations.AddField(
            model_name="aimodel",
            name="auto_summarize_tokens",
            field=models.PositiveIntegerField(default=100000),
        ),
        migrations.AddField(
            model_name="aiagentgroup",
            name="auto_summarize_tokens",
            field=models.PositiveIntegerField(default=100000),
        ),
        migrations.RunPython(luna_groups_200k, migrations.RunPython.noop),
    ]
