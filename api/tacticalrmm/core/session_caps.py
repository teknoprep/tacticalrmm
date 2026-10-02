"""Per-session chat capability grants (owner, 2026-09-27).

The hamburger switches in an AI chat - Write mode, Auto-approve, Auto-credential, Auto-TOTP and
customer email - are gated by the user's ROLE. That is the right default and has no middle
ground: a technician whose role lacks a switch cannot have it for the ONE ticket where an admin
decides it is warranted. This module is that middle ground.

  * `active_caps(user, scope_kind, scope_ref)` - what an admin has granted this user HERE.
  * `apply_caps(...)` - OR the grants into the blob fields the window reads.
  * Grant/revoke helpers + the capability catalogue for the admin UI.

A grant can only ADD to what the role already allows. Nothing here weakens the approval prompts,
the judge or the credential gate: those still run underneath whatever this hands over.
"""

from __future__ import annotations

import datetime as dt

from django.utils import timezone

# The catalogue. `blob` is the field the chat window reads to decide whether to show the switch.
CAPABILITIES = [
    {
        "id": "write",
        "label": "Write mode (change devices)",
        "blob": "mutate_allowed",
        "role_perm": "can_use_ai_mutate",
        "hint": "Lets the chat run commands that MODIFY a device. Approvals and the judge still apply.",
    },
    {
        "id": "autoapprove",
        "label": "Auto-approve device changes",
        "blob": "autoapprove_allowed",
        "role_perm": "can_use_ai_autoapprove",
        "hint": "Skips the approval prompt for disruptive device commands. Customer email and closing a ticket always ask anyway.",
    },
    {
        "id": "autocredential",
        "label": "Auto-credential (use stored logins)",
        "blob": "autocredential_allowed",
        "role_perm": "can_use_ai_autocredential",
        "hint": "Reads an IT Notebook login without asking each time. PRIVILEGED rows still prompt every time.",
    },
    {
        "id": "autototp",
        "label": "Auto-TOTP (use authenticator codes)",
        "blob": "autototp_allowed",
        "role_perm": "can_use_ai_autocredential",
        "hint": "Reads a stored authenticator code and types it into a sign-in, without a prompt. Ticket windows only.",
    },
    {
        "id": "email",
        "label": "Customer email",
        "blob": "allow_email",
        "role_perm": None,          # normally on for tickets, off for CRM discovery
        "hint": "May reply to the customer from this window.",
    },
]
CAP_IDS = [c["id"] for c in CAPABILITIES]
# The switch the bridge flips when an admin says "enable it for them" - the switch names the
# bridge's setters use (src/server.js apply_state).
CAP_STATE = {
    "write": "write",
    "autoapprove": "autoapprove",
    "autocredential": "autocredential",
    "autototp": "autototp",
    "email": "email",
}
_by_id = {c["id"]: c for c in CAPABILITIES}


def cap_label(cap_id: str) -> str:
    return _by_id.get(cap_id, {}).get("label", cap_id)


def clean_caps(caps) -> list:
    """Keep only known capability ids, de-duplicated and in catalogue order."""
    if isinstance(caps, str):
        caps = [c.strip() for c in caps.split(",")]
    wanted = {str(c) for c in (caps or [])}
    return [c for c in CAP_IDS if c in wanted]


def active_caps(user, scope_kind: str, scope_ref: str) -> set:
    """The union of every live grant for this user covering this scope.

    A SCOPE_ALL grant applies everywhere; a ticket grant only to that ticket ref; a device grant
    only to that agent id. Expiry is checked here, so no cleanup job is needed.
    """
    from core.models import AISessionCapability as C

    if not user or not getattr(user, "is_authenticated", True):
        return set()
    from django.db.models import Q

    now = timezone.now()
    rows = C.objects.filter(user=user, revoked_at__isnull=True).filter(
        Q(expires_at__isnull=True) | Q(expires_at__gt=now)   # no expiry, or one still to come
    )
    out = set()
    for row in rows:
        if row.scope_kind == C.SCOPE_ALL:
            out.update(row.caps or [])
        elif row.scope_kind == C.SCOPE_TICKET and scope_ref and (row.scope_ref or "").lower() == str(scope_ref).lower():
            out.update(row.caps or [])
        elif row.scope_kind == C.SCOPE_DEVICE and scope_ref and (row.scope_ref or "") == str(scope_ref):
            out.update(row.caps or [])
    return out & set(CAP_IDS)


def role_allows(user, cap_id: str) -> bool:
    """Does the user's ROLE already allow this? (Superusers allow everything.)"""
    if user.is_superuser or (getattr(user, "role", None) and user.role.is_superuser):
        return True
    perm = _by_id.get(cap_id, {}).get("role_perm")
    if not perm:
        return False
    return bool(getattr(user, "role", None) and getattr(user.role, perm, False))


def resolve_perms(user, scope_kind: str, scope_ref: str) -> dict:
    """The effective hamburger permissions for this user in this scope, and which of them came
    from an admin GRANT rather than the role. One place so the blob, the API response and the
    live push to the bridge can never disagree."""
    caps = active_caps(user, scope_kind, scope_ref)
    perms = {}
    granted = []
    for cap_id, spec in _by_id.items():
        role_ok = role_allows(user, cap_id)
        has = role_ok or cap_id in caps
        perms[spec["blob"]] = bool(has)
        if has and not role_ok:
            granted.append(cap_id)
    return {"perms": perms, "granted": sorted(granted), "caps": sorted(caps)}


def apply_caps(blob: dict, user, scope_kind: str, scope_ref: str) -> dict:
    """OR the grants into a chat blob. Returns {cap: True} for the ones a GRANT provided, so the
    window can say "granted for this ticket" rather than pretending the role allows it."""
    r = resolve_perms(user, scope_kind, scope_ref)
    for field, val in r["perms"].items():
        if val:
            blob[field] = True          # a grant can only ever ADD to what the role allows
    blob["caps"] = r["caps"]
    blob["caps_granted"] = r["granted"]
    return {c: True for c in r["granted"]}


def grant(user, scope_kind: str, scope_ref: str, caps, *, by: str = "", minutes: int | None = None,
          note: str = "") -> "object":
    """Create or extend the single grant row for this user+scope."""
    from core.models import AISessionCapability as C

    caps = clean_caps(caps)
    if not caps:
        raise ValueError("no known capability ids given")
    if scope_kind not in (C.SCOPE_TICKET, C.SCOPE_DEVICE, C.SCOPE_ALL):
        raise ValueError(f"unknown scope '{scope_kind}'")
    if scope_kind != C.SCOPE_ALL and not str(scope_ref or "").strip():
        raise ValueError("this scope needs a reference (a ticket or a device)")
    row = C.objects.filter(user=user, scope_kind=scope_kind, scope_ref=str(scope_ref or ""),
                           revoked_at__isnull=True).order_by("-created").first()
    expires = timezone.now() + dt.timedelta(minutes=int(minutes)) if minutes else None
    if row:
        row.caps = clean_caps(list(row.caps or []) + caps)
        row.expires_at = expires
        row.granted_by = by or row.granted_by
        if note:
            row.note = note[:200]
        row.save(update_fields=["caps", "expires_at", "granted_by", "note"])
        return row
    return C.objects.create(user=user, scope_kind=scope_kind, scope_ref=str(scope_ref or ""),
                            caps=caps, granted_by=by, expires_at=expires, note=note[:200])


def revoke(user, scope_kind: str, scope_ref: str, *, by: str = "", caps=None) -> int:
    """Remove caps from the grant (or the whole grant when `caps` is None). Returns rows touched."""
    from core.models import AISessionCapability as C

    qs = C.objects.filter(user=user, scope_kind=scope_kind, scope_ref=str(scope_ref or ""),
                          revoked_at__isnull=True)
    now = timezone.now()
    touched = 0
    for row in qs:
        if caps is None:
            row.revoked_at = now
            row.revoked_by = by
            row.save(update_fields=["revoked_at", "revoked_by"])
        else:
            left = [c for c in (row.caps or []) if c not in set(clean_caps(caps))]
            if left:
                row.caps = left
            else:
                row.revoked_at = now
                row.revoked_by = by
            row.save(update_fields=["caps", "revoked_at", "revoked_by"])
        touched += 1
    return touched
