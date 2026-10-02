# Hand-written (2026-09-30): only the relay-key purpose + usage history. makemigrations would
# also have swept in unrelated pending drift (an index rename), which is left alone on purpose.
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [("core", "0138_automation_stood_down")]

    operations = [
        migrations.AddField(
            model_name="airelaykey", name="purpose",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.CreateModel(
            name="AIRelayKeyUse",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("ip", models.CharField(max_length=64)),
                ("first_seen", models.DateTimeField()),
                ("last_seen", models.DateTimeField()),
                ("times", models.PositiveIntegerField(default=1)),
                ("client", models.CharField(blank=True, default="", max_length=64)),
                ("key", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="uses", to="core.airelaykey")),
            ],
            options={"ordering": ["-last_seen"], "unique_together": {("key", "ip")}},
        ),
    ]
