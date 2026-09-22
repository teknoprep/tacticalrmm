"""Recover AI spend that exists only inside bridge session transcripts.

WHY THIS EXISTS
---------------
`AISpendEntry` was created on 2026-08-04 so that AI spend would be attributable and
would OUTLIVE the chat (deleting a conversation in AI History unlinks its `.jsonl`,
taking every dollar with it). Only three surfaces were ever wired to it. Measured on
2026-09-14, across 2,634 transcripts holding $1,345:

    * 2,307 sessions worth $527 had NO ledger row at all
    * 75 more were partially recorded (the ledger started mid-session) - a $239 gap

This command reads the transcripts and writes the missing rows, so the ledger becomes
the complete record it was always meant to be.

WHICH turns are missing is decided by comparing the two records as MULTISETS of
(cost, input, output, cacheRead, cacheWrite) - never by position. Position does not work:
sampling ten partially-recorded sessions showed the recorded rows are sometimes the first
n turns and sometimes an arbitrary subset (a fire-and-forget POST that failed mid-chat),
so "take the leading n" would both double-charge and miss turns. The multiset diff is
exact - on that sample every recorded row matched a real transcript turn, with no
leftovers on either side.

Re-running is safe: a second run finds nothing missing, and the ledger's own
(session_id, turn_index) uniqueness is a second line of defence.

ACCOUNTING RULE (same as everywhere else): every dollar is the figure the runtime
reported in `usage.cost` for that call, stored verbatim. Nothing is recomputed from a
rate table - historical reports must not move when a provider changes its prices.

ATTRIBUTION
-----------
Taken from the bridge's own per-agent history index (`sessions/<key>/index.json`),
which maps session_id -> {file, user, name}:

    sessions/<agent_id>/index.json          -> surface "device_chat", that agent
    sessions/decision:TICKET/<n>/index.json -> surface "decision_chat", TICKET/<n>
    not in any index                        -> surface "other", no actor

Recovered rows are flagged `backfilled=True`, because "we know exactly who spent this"
and "we found this in a file" are different facts and a bill should not blur them.

Usage:
    manage.py backfill_ai_spend --dry-run
    manage.py backfill_ai_spend
    manage.py backfill_ai_spend --sessions-root /opt/pi-trmm-bridge/sessions \
                                --transcripts /home/tactical/.pi/agent/sessions/--opt-pi-trmm-bridge-sessions--
"""

import json
import os
from decimal import Decimal, InvalidOperation

from django.core.management.base import BaseCommand
from django.db.models import Count, Max, Sum
from django.utils.dateparse import parse_datetime

DEFAULT_SESSIONS_ROOT = "/opt/pi-trmm-bridge/sessions"
DEFAULT_TRANSCRIPTS = (
    "/home/tactical/.pi/agent/sessions/--opt-pi-trmm-bridge-sessions--"
)


def _dec(v):
    try:
        return Decimal(str(v if v is not None else 0))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal(0)


def _int(v):
    try:
        n = int(v or 0)
    except (TypeError, ValueError):
        return 0
    return n if n > 0 else 0


class Command(BaseCommand):
    help = "Recover AI spend from bridge session transcripts into the AISpendEntry ledger"

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true")
        parser.add_argument("--sessions-root", default=DEFAULT_SESSIONS_ROOT)
        parser.add_argument("--transcripts", default=DEFAULT_TRANSCRIPTS)
        parser.add_argument(
            "--limit", type=int, default=0, help="stop after N sessions (testing)"
        )
        parser.add_argument(
            "--min-age-minutes",
            type=int,
            default=30,
            help=(
                "ignore turns newer than this (default 30). A turn is written to the "
                "transcript BEFORE its ledger POST lands, so recovering a still-settling "
                "turn would race the live write and could bill it twice."
            ),
        )

    # ---- attribution ------------------------------------------------------------
    def _build_index(self, sessions_root):
        """session_id -> {surface, agent_id, ticket_ref, actor, name}"""
        out = {}
        for dirpath, _dirs, files in os.walk(sessions_root):
            if "index.json" not in files:
                continue
            key = os.path.relpath(dirpath, sessions_root)
            if key.startswith("decision:"):
                surface = "decision_chat"
                # "decision:TICKET/60427" -> "TICKET/60427"
                ticket_ref = key.split(":", 1)[1]
                agent_id = ""
            else:
                surface = "device_chat"
                ticket_ref = ""
                agent_id = key
            try:
                with open(os.path.join(dirpath, "index.json")) as fh:
                    idx = json.load(fh)
            except Exception:
                continue
            if not isinstance(idx, dict):
                continue
            for sid, info in idx.items():
                if not isinstance(info, dict):
                    continue
                out[sid] = {
                    "surface": surface,
                    "agent_id": agent_id,
                    "ticket_ref": ticket_ref,
                    "actor": str(info.get("user") or ""),
                    "name": str(info.get("name") or ""),
                }
        return out

    # ---- transcripts ------------------------------------------------------------
    def _billed_turns(self, path):
        """Every billed assistant message in one transcript, in order."""
        turns = []
        try:
            with open(path, errors="replace") as fh:
                for line in fh:
                    try:
                        entry = json.loads(line)
                    except Exception:
                        continue
                    msg = entry.get("message") or {}
                    usage = msg.get("usage")
                    if not isinstance(usage, dict):
                        continue
                    cost = usage.get("cost")
                    if not isinstance(cost, dict):
                        # A model with no pricing metadata: still a real turn, still
                        # tokens. Record it as unpriced rather than dropping it.
                        cost = {}
                    turns.append(
                        {
                            "at": entry.get("timestamp") or "",
                            "provider": str(msg.get("provider") or ""),
                            "model_id": str(msg.get("model") or ""),
                            "usage": usage,
                            "cost": cost,
                            "priced": bool(usage.get("cost")),
                        }
                    )
        except Exception as e:  # unreadable file is not a reason to abort the run
            self.stderr.write(f"  ! {os.path.basename(path)}: {e}")
        return turns

    @staticmethod
    def _turn_identity(provider, model_id, usage, cost):
        """What makes two records of the same billed call the same call.

        Deliberately NOT the turn's position: see the module docstring. Dollars are
        rounded to the ledger's own 10 decimal places so a Decimal and a float agree.
        """
        return (
            round(float(cost.get("total") or 0), 10),
            _int(usage.get("input")),
            _int(usage.get("output")),
            _int(usage.get("cacheRead")),
            _int(usage.get("cacheWrite")),
        )

    def _scope_filter(self, session_id, attr):
        """Every ledger row that could already hold these turns.

        NOT just this session_id. A resumed conversation is given a NEW session id by the
        harness, so the live rows sit under the id the chat was running as while the
        transcript on disk is named with a different one. Scoped per session, the diff
        then saw "no rows for this id", called every turn missing, and billed the whole
        conversation a second time - $44.51 across 11 conversations, 2.6% of the ledger,
        with TICKET/61043 counted twice at $32.36.

        So the comparison is per CONVERSATION: the ticket, or the device, that the turns
        are attributed to. Turn identity (cost + four token counts) still decides what is
        missing within that scope, and a collision there under-records rather than
        double-charges - the safe direction for money.
        """
        from django.db.models import Q

        from core.models import session_scope_q

        q = session_scope_q(session_id)
        ticket = (attr or {}).get("ticket_ref") or ""
        agent = (attr or {}).get("agent_id") or ""
        if ticket:
            return q | Q(ticket_ref=ticket)
        if agent:
            # NB: the ledger's `agent` is a FK, so `agent_id` here would mean its integer
            # pk - the transcript index carries TRMM's agent_id STRING. Join on the real
            # field rather than the one with the convenient name.
            return q | Q(agent__agent_id=agent)
        return q

    def _missing_turns(self, session_id, turns, attr=None):
        """Transcript turns with no matching ledger row, as a multiset difference."""
        import collections

        from core.models import AISpendEntry

        recorded = collections.Counter()
        for r in AISpendEntry.objects.filter(self._scope_filter(session_id, attr)).values(
            "cost_total",
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
        ):
            recorded[
                (
                    round(float(r["cost_total"]), 10),
                    r["input_tokens"],
                    r["output_tokens"],
                    r["cache_read_tokens"],
                    r["cache_write_tokens"],
                )
            ] += 1
        out = []
        for t in turns:
            k = self._turn_identity(t["provider"], t["model_id"], t["usage"], t["cost"])
            if recorded[k] > 0:
                recorded[k] -= 1   # this transcript turn is the one already recorded
                continue
            out.append(t)
        return out

    def handle(self, *args, **opts):
        from agents.models import Agent
        from accounts.models import User
        from core.models import AISpendEntry

        sessions_root = opts["sessions_root"]
        transcripts = opts["transcripts"]
        dry = opts["dry_run"]

        from datetime import timedelta

        from django.utils import timezone

        cutoff = timezone.now() - timedelta(minutes=opts["min_age_minutes"])

        index = self._build_index(sessions_root)
        self.stdout.write(f"attribution index: {len(index)} sessions")

        # What the ledger already holds, per session: how many rows and the highest
        # turn_index. Rows are idempotent on (session_id, turn_index), so new rows must
        # continue ABOVE the highest index that exists - not above the row count. They
        # differ for sessions written before per-session hydration.
        existing = {
            r["session_id"]: (r["n"], r["mx"] or 0)
            for r in AISpendEntry.objects.values("session_id").annotate(
                n=Count("id"), mx=Max("turn_index")
            )
        }
        # Second half of the race guard: a conversation that has billed something in the
        # last few minutes is live. Leave it entirely to the live path; tonight's run
        # will pick up anything it genuinely lost.
        live = set(
            AISpendEntry.objects.filter(at__gte=cutoff)
            .values_list("session_id", flat=True)
            .distinct()
        )

        agent_cache = {}

        def resolve_agent(agent_id):
            if not agent_id:
                return None
            if agent_id not in agent_cache:
                agent_cache[agent_id] = (
                    Agent.objects.select_related("site__client")
                    .filter(agent_id=agent_id)
                    .first()
                )
            return agent_cache[agent_id]

        user_cache = {}

        def resolve_user(username):
            if not username:
                return None
            if username not in user_cache:
                user_cache[username] = User.objects.filter(username=username).first()
            return user_cache[username]

        files = sorted(f for f in os.listdir(transcripts) if f.endswith(".jsonl"))
        if opts["limit"]:
            files = files[: opts["limit"]]

        made = 0
        money = Decimal(0)
        touched = 0
        skipped_complete = 0
        skipped_live = 0
        rows = []

        for name in files:
            # "<iso>_<session_id>.jsonl"
            session_id = name.rsplit("_", 1)[-1][: -len(".jsonl")]
            if session_id in live:
                skipped_live += 1
                continue
            turns = self._billed_turns(os.path.join(transcripts, name))
            if not turns:
                continue
            # RACE GUARD. A live turn is in the transcript before its POST lands, so
            # anything recent is left alone: the live path owns it, and writing it here
            # could bill the same call twice under a different turn_index.
            turns = [
                t for t in turns
                if not t["at"] or (parse_datetime(t["at"]) or cutoff) < cutoff
            ]
            if not turns:
                continue
            attr = index.get(session_id) or {
                "surface": "other",
                "agent_id": "",
                "ticket_ref": "",
                "actor": "",
                "name": "",
            }
            # WHAT IS ALREADY BILLED for this conversation - compared across the whole
            # ticket/device, not just this session id (see _scope_filter).
            have_n, have_max = existing.get(session_id, (0, 0))
            missing = self._missing_turns(session_id, turns, attr)
            if not missing:
                skipped_complete += 1
                continue

            agent = resolve_agent(attr["agent_id"])
            user = resolve_user(attr["actor"])
            touched += 1
            for i, t in enumerate(missing, start=have_max + 1):
                usage = t["usage"]
                cost = t["cost"]
                at = parse_datetime(t["at"]) if t["at"] else None
                rows.append(
                    AISpendEntry(
                        session_id=session_id[:64],
                        turn_index=i,
                        surface=attr["surface"],
                        provider=t["provider"][:50],
                        model_id=t["model_id"][:255],
                        actor_user=user,
                        actor_username=(attr["actor"] or "")[:150],
                        agent=agent,
                        agent_hostname=(agent.hostname if agent else "")[:255],
                        client=(agent.site.client.name if agent else "")[:255],
                        site=(agent.site.name if agent else "")[:255],
                        ticket_ref=(attr["ticket_ref"] or "")[:100],
                        input_tokens=_int(usage.get("input")),
                        output_tokens=_int(usage.get("output")),
                        cache_read_tokens=_int(usage.get("cacheRead")),
                        cache_write_tokens=_int(usage.get("cacheWrite")),
                        reasoning_tokens=_int(usage.get("reasoning")),
                        total_tokens=_int(usage.get("totalTokens")),
                        cost_input=_dec(cost.get("input")),
                        cost_output=_dec(cost.get("output")),
                        cost_cache_read=_dec(cost.get("cacheRead")),
                        cost_cache_write=_dec(cost.get("cacheWrite")),
                        cost_total=_dec(cost.get("total")),
                        priced=t["priced"],
                        context_tokens=_int(usage.get("totalTokens")),
                        was_model_switch=False,
                        at=at,
                        backfilled=True,
                    )
                )
                money += _dec(cost.get("total"))
                made += 1

        # A row with no timestamp cannot be placed in a billing period; use the file's
        # own first-seen time rather than "now", which would move old money into today.
        for r in rows:
            if r.at is None:
                r.at = None
        rows = [r for r in rows if r.at is not None] + [
            r for r in rows if r.at is None
        ]

        self.stdout.write(
            f"transcripts scanned: {len(files)} | sessions needing rows: {touched} | "
            f"already complete: {skipped_complete} | still live, left alone: {skipped_live}"
        )
        self.stdout.write(f"rows to write: {made}  worth ${money:.2f}")

        if dry:
            self.stdout.write(self.style.WARNING("dry run - nothing written"))
            return

        undated = [r for r in rows if r.at is None]
        if undated:
            self.stdout.write(
                self.style.WARNING(
                    f"{len(undated)} rows had no timestamp and were skipped "
                    "(they cannot be placed in a billing period)"
                )
            )
        rows = [r for r in rows if r.at is not None]

        # ignore_conflicts: another process (or a re-run) may have written the same
        # (session_id, turn_index) - the ledger's idempotency key exists for exactly this.
        AISpendEntry.objects.bulk_create(rows, batch_size=500, ignore_conflicts=True)

        total = AISpendEntry.objects.aggregate(s=Sum("cost_total"))["s"] or 0
        self.stdout.write(
            self.style.SUCCESS(
                f"wrote {len(rows)} rows; ledger now holds "
                f"{AISpendEntry.objects.count()} rows / ${total:.2f}"
            )
        )
