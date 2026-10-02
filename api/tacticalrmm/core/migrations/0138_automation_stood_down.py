from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0137_ai_automation_approval"),
    ]

    operations = [
        migrations.AddField(
            model_name="aiticketstate",
            name="automation_stood_down",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="aiticketstate",
            name="stood_down_reason",
            field=models.CharField(blank=True, default="", max_length=200),
        ),
        migrations.AddField(
            model_name="aiticketstate",
            name="stood_down_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
