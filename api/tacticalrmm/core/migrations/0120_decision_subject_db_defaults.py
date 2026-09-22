from django.db import migrations


class Migration(migrations.Migration):
    """Give subject_kind/subject_ref real DATABASE defaults.

    Django adds a new column with its default, backfills, then DROPS the database default -
    correct in theory (the ORM always supplies the value) and a live hazard in practice: any
    process still running the OLD model code omits the column from its INSERT, and the
    insert dies on NOT NULL.

    That is exactly what happened on 2026-09-16. Migration 0119 added these fields and uwsgi
    was restarted, but CELERY was not - so every triage_ai_ticket run from 13:08 onward
    crashed with "null value in column subject_kind violates not-null constraint", and 8
    tickets sat untriaged with no decision thread. The deploy discipline (restart the
    workers too) is the real fix; this is the belt to its braces, so a stale worker degrades
    to "writes a helpdesk-kind row" instead of failing outright.
    """

    dependencies = [("core", "0119_ai_crm_discovery")]

    operations = [
        migrations.RunSQL(
            sql=[
                "ALTER TABLE core_aidecisionrequest ALTER COLUMN subject_kind SET DEFAULT 'helpdesk'",
                "ALTER TABLE core_aidecisionrequest ALTER COLUMN subject_ref SET DEFAULT ''",
            ],
            reverse_sql=[
                "ALTER TABLE core_aidecisionrequest ALTER COLUMN subject_kind DROP DEFAULT",
                "ALTER TABLE core_aidecisionrequest ALTER COLUMN subject_ref DROP DEFAULT",
            ],
        ),
    ]
