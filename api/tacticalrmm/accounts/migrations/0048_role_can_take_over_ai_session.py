from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0047_role_can_view_ai_cost"),
    ]

    operations = [
        migrations.AddField(
            model_name="role",
            name="can_take_over_ai_session",
            field=models.BooleanField(default=False),
        ),
    ]
