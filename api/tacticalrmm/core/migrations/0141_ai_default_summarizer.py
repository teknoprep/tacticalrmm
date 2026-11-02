from django.db import migrations, models


def set_default_summarizer(apps, schema_editor):
    """Seed the live row: single-model chats are summarised by Claude Haiku 5.5."""
    CoreSettings = apps.get_model("core", "CoreSettings")
    CoreSettings.objects.update(
        ai_default_summarizer_provider="anthropic",
        ai_default_summarizer_model_id="claude-haiku-5-5",
    )


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0140_subject_may_close_ticket"),
    ]

    operations = [
        migrations.AddField(
            model_name="coresettings",
            name="ai_default_summarizer_model_id",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
        migrations.AddField(
            model_name="coresettings",
            name="ai_default_summarizer_provider",
            field=models.CharField(blank=True, default="", max_length=50),
        ),
        migrations.RunPython(set_default_summarizer, migrations.RunPython.noop),
    ]
