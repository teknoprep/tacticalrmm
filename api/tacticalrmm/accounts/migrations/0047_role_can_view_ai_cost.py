from django.db import migrations, models


class Migration(migrations.Migration):
    """Add the can_view_ai_cost role permission.

    Controls visibility of the live token/cost meter in Pi Chat and the AI Decision
    window. Default False so no existing role gains it implicitly; superusers get it
    unconditionally in the view layer. Visibility only - it grants no AI capability.
    """

    dependencies = [
        ("accounts", "0046_user_ai_autoapprove_default"),
    ]

    operations = [
        migrations.AddField(
            model_name="role",
            name="can_view_ai_cost",
            field=models.BooleanField(default=False),
        ),
    ]
