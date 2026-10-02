from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0135_ai_agent_routing"),
    ]

    operations = [
        migrations.AddField(
            model_name="aiticketautomationsubject",
            name="statements",
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
