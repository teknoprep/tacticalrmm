from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0098_alter_aireportschedule_kind"),
    ]

    operations = [
        migrations.AddField(
            model_name="aitask",
            name="primary_role",
            field=models.CharField(blank=True, default="", max_length=400),
        ),
        migrations.AddField(
            model_name="aitask",
            name="machines",
            field=models.JSONField(blank=True, default=list),
        ),
    ]
