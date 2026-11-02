"""Give every Fix subject that carries reviewed script(s) but NO rule the rule that authorises them.

Owner (2026-10-06): "actions should be allowed to be there but they should NOT RUN unless an IF is
setup in the rules". A `run_script` only executes when the rule reaches it through a true IF, so a
device_fix subject with attached `fix_actions` and empty `statements` can no longer run anything -
the bridge caps it at read-only and its actions are inert.

This command writes the missing rule for such subjects. The attached `fix_actions` stay exactly
where they are: they are reviewed LIBRARY data, not authority. The script is copied into the rule's
`run_script` step (the shape rules already use - see subjects #2 and #9), so the rule is the single
thing the interpreter reads.

Idempotent: a subject that already has a rule is left alone. Dry-run by default - pass --apply.

    python manage.py rules_for_fix_subjects            # report what it would do
    python manage.py rules_for_fix_subjects --apply    # write the rules
"""

from django.core.management.base import BaseCommand

from core.ai_subjects_report import rule_for_fix, touches_identity
from core.models import AITicketAutomationSubject


class Command(BaseCommand):
    help = ("Write the authorising rule onto Fix subjects that carry reviewed scripts but no rule "
            "(owner: actions do not run without an IF; dry-run unless --apply).")

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="write the rules (default: dry run)")
        parser.add_argument("--include-proposed", action="store_true", default=True,
                            help="also give proposed (not yet approved) subjects their rule")
        parser.add_argument("--id", type=int, action="append", default=None,
                            help="only this subject id (repeatable)")

    def handle(self, *args, **opts):
        qs = AITicketAutomationSubject.objects.filter(mode="device_fix").order_by("id")
        if opts.get("id"):
            qs = qs.filter(pk__in=opts["id"])
        changed = 0
        skipped = 0
        for subj in qs:
            blocks = (subj.statements or {}).get("blocks") if isinstance(subj.statements, dict) else None
            actions = [a for a in (subj.fix_actions or [])
                       if isinstance(a, dict) and a.get("name") and a.get("command")]
            if blocks:
                skipped += 1
                continue
            if not actions:
                self.stdout.write(f"  #{subj.pk} {subj.name!r} [{subj.status}] - no rule and no usable "
                                  f"fix_actions; nothing to authorise, skipped")
                skipped += 1
                continue
            rule = rule_for_fix(actions)
            gate = "approved_by_support_contact + details_sufficient" \
                if any(touches_identity(a.get("command")) for a in actions) else "details_sufficient"
            names = ", ".join(a["name"] for a in actions)
            if not opts["apply"]:
                self.stdout.write(f"  would set #{subj.pk} {subj.name!r} [{subj.status}] -> rule "
                                  f"(guard: {gate}) around: {names}")
                changed += 1
                continue
            subj.statements = rule
            subj.save(update_fields=["statements"])
            self.stdout.write(f"  #{subj.pk} {subj.name!r} [{subj.status}] -> rule written "
                              f"(guard: {gate}) around: {names}")
            changed += 1
        verb = "written" if opts["apply"] else "to write"
        self.stdout.write(self.style.SUCCESS(
            f"{changed} subject(s) {verb}; {skipped} already had a rule or nothing to authorise."))
