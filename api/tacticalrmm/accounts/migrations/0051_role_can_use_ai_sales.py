from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0050_role_can_use_ai_remote"),
    ]

    operations = [
        migrations.AddField(
            model_name="role",
            name="can_use_ai_sales",
            field=models.BooleanField(default=False),
        ),
    ]
