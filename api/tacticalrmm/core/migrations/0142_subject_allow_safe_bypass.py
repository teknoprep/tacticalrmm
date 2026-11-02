"""Let the approval gate be skipped for DECLARED-SAFE reviewed actions (owner, 2026-10-15).

Owner: "this should be something that can be bypassed, but if it is bypassed the only actions that
can be done are IMMUTABLE actions which have 0 affect on data... restarts of services when needed /
computer updates / things like this... no deletion of files or change of licenses".

The gate itself is unchanged and still non-editable: a rule may not run a MUTATING action until a
person approves the plan. What this adds is a per-subject opt-in - default OFF - that lets a
`run_script` whose attached action is DECLARED safety read / restart / update run without that
per-ticket approval. The safety lives on the reviewed action (core.ai_rules.ACTION_SAFETY) and
anything unlabelled defaults to `mutating`, so the bypass cannot widen by accident: the switch
does not change WHAT may run, only whether the safe subset needs a click.

Backfill: OFF for every subject, so no existing subject changes behaviour until a person turns it
on. That is deliberate - this is a safety boundary, and it should move only on an explicit act.
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0141_ai_default_summarizer")]

    operations = [
        migrations.AddField(
            model_name="aiticketautomationsubject",
            name="allow_safe_bypass",
            field=models.BooleanField(
                default=False,
                help_text="Allow actions declared read-only / restart / update to run without a "
                          "per-ticket approval. Actions declared 'change data, files or accounts' "
                          "always still require approval. Off by default.",
            ),
        ),
    ]
