from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0100_coresettings_ai_operator_policy"),
    ]

    operations = [
        migrations.AddField(
            model_name="aitaskrun",
            name="action_label",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
        migrations.AddField(
            model_name="aitaskrun",
            name="ticket_ref",
            field=models.CharField(blank=True, default="", max_length=100),
        ),
        migrations.AlterField(
            model_name="aitaskrun",
            name="triggered_by",
            field=models.CharField(default="schedule", max_length=32),
        ),
    ]
