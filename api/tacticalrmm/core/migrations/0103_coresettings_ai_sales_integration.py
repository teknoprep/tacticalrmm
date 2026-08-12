from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0102_coresettings_ai_mail_tech_from_domains"),
    ]

    operations = [
        migrations.AddField(
            model_name="coresettings",
            name="ai_sales_enabled",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="coresettings",
            name="ai_sales_prompt",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.AddField(
            model_name="coresettings",
            name="ai_sales_code",
            field=models.TextField(blank=True, default=""),
        ),
    ]
