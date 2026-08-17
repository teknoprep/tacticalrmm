from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0048_role_can_take_over_ai_session"),
    ]

    operations = [
        migrations.AddField(
            model_name="role",
            name="can_use_ai_autocredential",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="user",
            name="ai_autocredential_default",
            field=models.BooleanField(default=False),
        ),
    ]
