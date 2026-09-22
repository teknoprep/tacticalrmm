"""Work claims: "is anyone already on this?" - answered in code, before any agent acts.

Owner's rule (2026-09-15): when several tickets arrive for the same exact thing, the AI must
not work it more than once, and any agent must check first. Checking in a prompt is not
checking - two pollers a second apart would both read "nothing active" and both start. So
the claim is a database row whose uniqueness constraint IS the lock: the second taker gets
an IntegrityError, not a copy of the work.

What counts as "the same thing" is the FINGERPRINT. Two are computed for a ticket:
  * condition fingerprint - the procedure/subject's condition key + the customer (+ host).
    "SendPlot is down at Omega Design" is one thing however many people report it.
  * subject-line fingerprint - the normalised subject line + the requester's domain, for
    tickets with no condition key. Strips Re:/Fwd:, reference ids, long digit runs and case,
    so "FW: Document Status Ref-63b8..." and "Fwd: document status ref-9a1c..." collide.

Claims expire (a crashed worker must not hold a thing hostage) and are released when the
work settles, recording the outcome and every duplicate that arrived meanwhile.
"""

from __future__ import annotations

import hashlib
import re
from datetime import timedelta
from typing import Optional

from django.db import IntegrityError, transaction
from django.utils import timezone

DEFAULT_TTL_MINUTES = 90

_PREFIX = re.compile(r"^\s*((re|fw|fwd|aw|wg|tr)\s*:\s*)+", re.I)
_REFID = re.compile(r"\b(ref|reference|id|ticket|case|incident)\s*[-:#]?\s*[a-z0-9\-]{6,}\b", re.I)
_HEX = re.compile(r"\b[0-9a-f]{8,}\b", re.I)
_DIGITS = re.compile(r"\d{4,}")
_WS = re.compile(r"\s+")


def normalise_subject(subject: str) -> str:
    s = str(subject or "")
    s = _PREFIX.sub("", s)
    s = _REFID.sub(" ", s)
    s = _HEX.sub(" ", s)
    s = _DIGITS.sub(" ", s)
    s = re.sub(r"[^\w\s]", " ", s)
    s = _WS.sub(" ", s).strip().lower()
    return s[:120]


def _h(*parts: str) -> str:
    return hashlib.sha1("|".join(str(p or "").strip().lower() for p in parts).encode("utf-8")).hexdigest()


def condition_fingerprint(condition_key: str, customer: str, host: str = "") -> str:
    return _h("cond", condition_key, customer, host)


def subject_fingerprint(subject_line: str, requester_email: str = "", customer: str = "") -> str:
    domain = (requester_email or "").split("@")[-1] if requester_email else ""
    return _h("subj", normalise_subject(subject_line), customer or domain)


def find_active(fingerprint: str):
    """The live claim on this thing, or None. Expired claims are swept as a side effect."""
    from core.models import AITicketWorkClaim

    now = timezone.now()
    AITicketWorkClaim.objects.filter(active=True, expires_at__lt=now).update(
        active=False, released_at=now, outcome="expired",
    )
    return AITicketWorkClaim.objects.filter(fingerprint=fingerprint, active=True).first()


def claim(fingerprint: str, *, ticket_ref: str, worker: str, what: str = "",
          subject=None, ttl_minutes: int = DEFAULT_TTL_MINUTES) -> dict:
    """Take the claim, or learn who has it.

    Returns {"ok": True, "claim": row} when this caller now owns the thing, or
            {"ok": False, "claim": row} with the EXISTING claim when someone else does.
    A repeat call for the SAME ticket returns ok=True (re-entrant), so a re-triage of the
    ticket being worked does not treat itself as a duplicate.
    """
    from core.models import AITicketWorkClaim

    existing = find_active(fingerprint)
    if existing:
        if existing.ticket_ref == ticket_ref:
            return {"ok": True, "claim": existing, "reentrant": True}
        if ticket_ref not in (existing.duplicates or []):
            existing.duplicates = list(existing.duplicates or []) + [ticket_ref]
            existing.save(update_fields=["duplicates"])
        return {"ok": False, "claim": existing}
    try:
        with transaction.atomic():
            row = AITicketWorkClaim.objects.create(
                fingerprint=fingerprint, ticket_ref=ticket_ref, worker=worker[:120],
                what=(what or "")[:300], subject=subject, active=True,
                expires_at=timezone.now() + timedelta(minutes=max(1, ttl_minutes)),
            )
        return {"ok": True, "claim": row}
    except IntegrityError:
        # Lost the race by milliseconds: the other taker's row is the truth.
        existing = find_active(fingerprint)
        if existing and existing.ticket_ref != ticket_ref:
            if ticket_ref not in (existing.duplicates or []):
                existing.duplicates = list(existing.duplicates or []) + [ticket_ref]
                existing.save(update_fields=["duplicates"])
        return {"ok": False, "claim": existing}


def find_recent(fingerprint: str, minutes: int = 60):
    """The last claim on this thing that FINISHED cleanly, within `minutes`.

    A duplicate does not always arrive while the first ticket is being worked - it often
    lands a minute after it finished, from a second person in the same office. Without this
    the second ticket would be worked from scratch: another model session, another restart
    of a service that was just restarted. So recently-completed work counts as "already
    handled" too, and the new ticket is resolved against it instead of redoing it.
    """
    from core.models import AITicketWorkClaim

    since = timezone.now() - timezone.timedelta(minutes=max(1, int(minutes or 0)))
    # WHICH OUTCOMES COUNT AS "already handled". A claim released by autowork carries the
    # ACTION as its outcome ("replied"), not the word "done" - filtering on "done" alone
    # matched nothing, which would have let every late duplicate be worked from scratch.
    # Only genuine successes count: a run that failed, errored or needed a human leaves the
    # work undone, so the next ticket about it SHOULD be picked up.
    DONE = ("done", "replied", "cancelled", "resolved")
    return (
        AITicketWorkClaim.objects.filter(
            fingerprint=fingerprint, active=False, released_at__gte=since, outcome__in=DONE,
        )
        .order_by("-released_at")
        .first()
    )


def release(fingerprint: str, *, ticket_ref: str, outcome: str = "done") -> Optional[object]:
    from core.models import AITicketWorkClaim

    row = AITicketWorkClaim.objects.filter(
        fingerprint=fingerprint, ticket_ref=ticket_ref, active=True,
    ).first()
    if not row:
        return None
    row.active = False
    row.released_at = timezone.now()
    row.outcome = (outcome or "done")[:40]
    row.save(update_fields=["active", "released_at", "outcome"])
    return row


def already_being_worked(*, subject_line: str, requester_email: str = "", customer: str = "",
                         condition_key: str = "", host: str = "", exclude_ticket: str = "") -> Optional[dict]:
    """For a chat/agent about to start: is this thing already in hand on ANOTHER ticket?

    Checks both fingerprints; returns a small dict for a system note, or None.
    """
    fps = []
    if condition_key:
        fps.append(condition_fingerprint(condition_key, customer, host))
    fps.append(subject_fingerprint(subject_line, requester_email, customer))
    for fp in fps:
        row = find_active(fp)
        if row and row.ticket_ref != exclude_ticket:
            return {
                "ticket_ref": row.ticket_ref, "worker": row.worker, "what": row.what,
                "since": row.claimed_at, "fingerprint": fp,
            }
    return None
