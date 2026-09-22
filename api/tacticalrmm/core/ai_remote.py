"""Remote (mobile) access to an open AI window — the one place that decides it.

A technician working a ticket is frequently not at the desk the ticket is being worked
from. This feature lets them pair a phone to ONE open AI window and carry on the SAME
conversation from it: read the stream, answer, approve a device action.

Three independent things must all be true before a window may be reached from a phone,
and they are deliberately different KINDS of decision:

    1. `CoreSettings.ai_remote_relay_url` is set    -- an operator chose a relay
    2. `CoreSettings.ai_remote_enabled` is on       -- an operator opened the door
    3. the caller's role has `can_use_ai_remote`    -- this person may walk through it

The relay is a network boundary that can see routed plaintext protocol content and
metadata, so (1) has no shipped default and (2) cannot be switched on without it. That
is the whole reason the URL is a separate field from the flag: filling in an address is
not the same as opening the door to it.

This computes what goes in the session blob. The bridge trusts the blob and nothing
else - a browser that sends `set_remote` on a window whose blob says `remote_allowed:
false` is answered with a refusal, exactly like Auto-approve and Auto-credential.
"""


def remote_blob_fields(core, user, is_super=False):
    """The two `remote_*` keys every AI session blob carries.

    Returns the relay URL only when the caller may actually use it. A URL in a blob the
    user cannot act on is a credential leak with extra steps: the blob is handed to the
    browser's bridge session, so it should carry the address only when this window is
    genuinely allowed to dial it.
    """
    # RETIRED 2026-09-15. The phone-relay "remote" feature is gone: the mobile app is a
    # viewer of the server-resident session like any browser (see pibridge/src/live-hub.js).
    # This helper now carries the fields that replaced it, so every session blob - device
    # chat, multi-machine chat, decision chat - gets them from one place.
    role = getattr(user, "role", None)
    return {
        "remote_allowed": False,
        "remote_relay_url": "",
        # How long the session survives with nobody watching (Global Setting; 0 = forever).
        "detach_grace_minutes": int(getattr(core, "ai_chat_detach_grace_minutes", 5) or 0),
        # Seat rules (live-presence.js): superusers are admins; the role grants take-over.
        "is_superuser": bool(is_super),
        "can_take_over_ai_session": bool(is_super or (role and getattr(role, "can_take_over_ai_session", False))),
    }
