"""Collapse inline script bodies out of rules and into the subject's Reviewed actions.

Owner (2026-10-06): "we either should just remove Actions altogether or call the action's name in
the Rule so the rule isn't so long... i like the 2nd option here so we can collapse the scripts in
this and then choose that in the rules".

A `run_script` step should NAME an attached reviewed action:

    {"action": "run_script", "args": {"name": "m365-offboard-user"}}

not carry a 60-line PowerShell body. This command rewrites every rule:

  * an inline `script` body whose name is not yet attached is MOVED into the subject's fix_actions
    (nothing the author wrote is lost);
  * an action that already exists is used as-is;
  * the rule is left naming the action, so it is short and the command has one home.

Django's serializer does the same thing on every save, so this only has to run once per subject.
Idempotent. Dry-run by default - pass --apply.

    python manage.py bind_rule_scripts             # report what it would do
    python manage.py bind_rule_scripts --apply
"""

from django.core.management.base import BaseCommand

from core.ai_rules import bind_run_scripts, unbound_run_scripts, validate, with_defaults
from core.models import AITicketAutomationSubject


class Command(BaseCommand):
    help = ("Rewrite every rule's run_script steps to NAME an attached reviewed action instead of "
            "carrying the script body (dry-run unless --apply).")

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="write the rules (default: dry run)")
        parser.add_argument("--id", type=int, action="append", default=None,
                            help="only this subject id (repeatable)")

    def handle(self, *args, **opts):
        qs = AITicketAutomationSubject.objects.order_by("id")
        if opts.get("id"):
            qs = qs.filter(pk__in=opts["id"])
        touched = opted = 0
        for subj in qs:
            blocks = (subj.statements or {}).get("blocks") if isinstance(subj.statements, dict) else None
            if not blocks:
                continue
            bound, actions, added, changed = bind_run_scripts(subj.statements, subj.fix_actions)
            if not changed and not added:
                continue
            clean, errors = validate(bound)
            if errors:
                self.stderr.write(f"  #{subj.pk} {subj.name!r}: rule would not validate: {errors[:3]}")
                continue
            missing = unbound_run_scripts(clean, [a.get("name") for a in actions if isinstance(a, dict)])
            if missing:
                self.stderr.write(f"  #{subj.pk} {subj.name!r}: still unbound: {missing[:2]}")
                continue
            steps = [s for s in _run_script_names(clean)]
            note = f"run_script -> {'; '.join(steps) or '(none)'}"
            if added:
                note += f" | moved to actions: {', '.join(added)}"
            if not opts["apply"]:
                self.stdout.write(f"  would rewrite #{subj.pk} {subj.name!r}: {note}")
                touched += 1
                continue
            subj.statements = with_defaults(clean)
            subj.fix_actions = actions
            subj.save(update_fields=["statements", "fix_actions"])
            self.stdout.write(f"  #{subj.pk} {subj.name!r}: {note}")
            touched += 1
        verb = "rewritten" if opts["apply"] else "to rewrite"
        self.stdout.write(self.style.SUCCESS(f"{touched} rule(s) {verb}; {opted} skipped."))


def _run_script_names(statements):
    from core.ai_rules import iter_run_scripts

    for step, _where in iter_run_scripts(statements):
        yield (step.get("args") or {}).get("name") or "?"
