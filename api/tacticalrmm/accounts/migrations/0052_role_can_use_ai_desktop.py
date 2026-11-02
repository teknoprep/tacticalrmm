from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0051_role_can_use_ai_sales"),
    ]

    operations = [
        migrations.AddField(
            model_name="role",
            name="can_use_ai_desktop",
            field=models.BooleanField(default=False),
        ),
    ]
