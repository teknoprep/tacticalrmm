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
    relay = (getattr(core, "ai_remote_relay_url", "") or "").strip()
    allowed = bool(
        relay
        and getattr(core, "ai_remote_enabled", False)
        and (is_super or (user.role and user.role.can_use_ai_remote))
    )
    return {
        "remote_allowed": allowed,
        "remote_relay_url": relay if allowed else "",
    }
