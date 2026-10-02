from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0124_ticket_held_duplicates"),
    ]

    operations = [
        migrations.AddField(
            model_name="aiticketautomationsubject",
            name="proposal_kind",
            field=models.CharField(
                choices=[("new", "New subject"), ("extend", "Extend an existing subject")],
                default="new",
                max_length=10,
            ),
        ),
        migrations.AddField(
            model_name="aiticketautomationsubject",
            name="extends_subject",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="extension_proposals",
                to="core.aiticketautomationsubject",
            ),
        ),
    ]
