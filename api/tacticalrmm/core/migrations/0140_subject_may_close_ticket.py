"""A subject may only file a ticket to AI Closed when it is allowed to (owner, 2026-10-05).

TICKET/62168 and TICKET/62169 were new-hire onboarding requests. The "New-employee onboarding intake"
subject replied to the customer asking for details and then filed the ticket to AI Closed in the same
run - minutes after the ticket arrived, while the request still needed a technician to create the
account and do an on-site visit. On 62169 the technician had to apologise to the customer for the AI's
reply. The session's own note said "a human technician still owns the Lititz workstation prep and the
dispatch/scheduling decision"; the platform ignored that.

The switch is explicit now. Backfill: OFF for every subject that has no rule (nothing that says the job
is done) and is in an advise-only mode - those are the intake subjects. Subjects that carry a reviewed
fix script, or that have a rule, keep closing as before.
"""

from django.db import migrations, models


def backfill(apps, schema_editor):
    Subject = apps.get_model("core", "AITicketAutomationSubject")
    for s in Subject.objects.all():
        has_rule = bool(s.statements)
        s.may_close_ticket = True if (has_rule or s.mode == "device_fix") else False
        s.save(update_fields=["may_close_ticket"])


def unbackfill(apps, schema_editor):
    apps.get_model("core", "AITicketAutomationSubject").objects.update(may_close_ticket=True)


class Migration(migrations.Migration):
    dependencies = [("core", "0139_relay_key_purpose_uses")]

    operations = [
        migrations.AddField(
            model_name="aiticketautomationsubject",
            name="may_close_ticket",
            field=models.BooleanField(
                default=False,
                help_text="May the automation file this ticket to AI Closed once it has replied? Off for "
                          "intake/advice subjects that leave work for a human; on for subjects that "
                          "actually finish the job.",
            ),
        ),
        migrations.RunPython(backfill, unbackfill),
    ]
