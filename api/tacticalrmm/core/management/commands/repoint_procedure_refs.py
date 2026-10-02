"""Repoint every reference to an absorbed procedure at the row it was merged into.

Why this exists: `consolidate_ai_procedures` merges duplicates by RETIRING the absorbed row and
setting `merged_into` to the canonical one - nothing is deleted, which is right. But the references
were never moved with it, so:

  * `AITicketAutomationSubject.procedures` (M2M) could keep pointing at a retired duplicate, and
  * a subject's RULE could keep naming an absorbed procedure id in `procedure_cause`,
    `fix_procedure` or `verify_fix` - which is worse, because a rule is what the interpreter walks.
    A rule citing a row that has been absorbed is not obviously broken: it just quietly stops
    matching what it used to.

Chains are followed to the end (`a -> b -> c` resolves to `c`), because a procedure can be absorbed
into one that is itself later absorbed.

Dry run by default; nothing is written without --apply.

    manage.py repoint_procedure_refs              # report only
    manage.py repoint_procedure_refs --apply
"""

from __future__ import annotations

import json

from django.core.management.base import BaseCommand
from django.db import transaction


class Command(BaseCommand):
    help = "Move subject and rule references off absorbed procedures and onto their canonical row."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="write the changes (default: report only)")

    def handle(self, *args, **o):
        from core.models import AIProcedure, AITicketAutomationSubject

        apply = o["apply"]
        rows = {p.pk: p for p in AIProcedure.objects.all()}

        def canonical(pid):
            """Follow merged_into to the end. A cycle (impossible by construction, but this is data)
            stops the walk rather than looping forever."""
            seen = set()
            cur = rows.get(pid)
            while cur is not None and cur.merged_into_id and cur.pk not in seen:
                seen.add(cur.pk)
                cur = rows.get(cur.merged_into_id)
            return cur.pk if cur is not None else pid

        def fix_args(args: dict) -> tuple[dict, list]:
            """Rewrite any `procedure` id in one action/condition's args. Returns the new args and
            the (from, to) pairs that changed."""
            changes = []
            new = dict(args or {})
            pid = new.get("procedure")
            if isinstance(pid, int) or (isinstance(pid, str) and pid.isdigit()):
                pid = int(pid)
                canon = canonical(pid)
                if canon != pid:
                    new["procedure"] = canon
                    changes.append((pid, canon))
            return new, changes

        def walk_steps(steps, changes):
            for step in steps or []:
                if not isinstance(step, dict):
                    continue
                if "if" in step:
                    cond = step.get("if") or {}
                    cond["args"], ch = fix_args(cond.get("args") or {})
                    changes += ch
                    walk_steps(step.get("then"), changes)
                    for e in step.get("elif") or []:
                        walk_steps([e], changes)
                    walk_steps(step.get("else"), changes)
                    continue
                if "action" in step:
                    step["args"], ch = fix_args(step.get("args") or {})
                    changes += ch

        n_m2m = n_rule = 0
        with transaction.atomic():
            for s in AITicketAutomationSubject.objects.all():
                # ---- the procedures attached to the subject ------------------------------------
                cur = list(s.procedures.all())
                want = {canonical(p.pk) for p in cur}
                if want != {p.pk for p in cur}:
                    n_m2m += 1
                    self.stdout.write(f"  subject #{s.pk} {s.name[:48]!r}: "
                                      f"{sorted(p.pk for p in cur)} -> {sorted(want)}")
                    if apply:
                        s.procedures.set(AIProcedure.objects.filter(pk__in=sorted(want)))
                # ---- the rule ------------------------------------------------------------------
                st = json.loads(json.dumps(s.statements or {}))
                changes = []
                for b in st.get("blocks") or []:
                    walk_steps([b], changes)
                if changes:
                    n_rule += 1
                    self.stdout.write(f"  rule of subject #{s.pk} {s.name[:48]!r}: "
                                      + ", ".join(f"#{a}->#{b}" for a, b in changes))
                    if apply:
                        s.statements = st
                        s.save(update_fields=["statements"])
            if not apply:
                transaction.set_rollback(True)

        absorbed = sum(1 for p in rows.values() if p.merged_into_id)
        self.stdout.write(
            f"absorbed procedures: {absorbed} | subjects repointed: {n_m2m} | rules repointed: {n_rule}"
        )
        if not apply:
            self.stdout.write("DRY RUN - nothing written. Re-run with --apply to make it so.")
