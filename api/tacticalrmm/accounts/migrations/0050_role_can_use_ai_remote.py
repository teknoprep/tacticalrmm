from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0049_ai_autocredential"),
    ]

    operations = [
        migrations.AddField(
            model_name="role",
            name="can_use_ai_remote",
            field=models.BooleanField(default=False),
        ),
    ]
