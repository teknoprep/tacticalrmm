"""AI desktop control per computer (owner, 2026-10-19).

The Pi AI Operator drives a computer's real screen, mouse and keyboard. Which computers it may
drive has always been ONE list - CoreSettings.ai_operator_allowed_agent_ids, edited in Global
Settings - and in practice that meant one machine. This module lets a person switch a computer on
or off from that computer's AI chat hamburger instead, without making a second list:

  * the allowlist stays the single source of truth (Global Settings shows the same thing);
  * the bridge (agents/views.py _pi_operator_policy) and the Operator coordinator (it reads
    /core/ai/operator/workstations/ before every session and action) both follow it, so turning a
    computer OFF stops the AI on it within seconds, whatever chat is open.

WHO MAY FLIP IT for a computer: someone who can reach that agent in the RMM AND whose role has
`can_use_ai_desktop` (superusers always) OR who holds an admin grant of the "desktop" capability
for that device (core/session_caps.py). Turning it on changes no other safety rule: the
Operator's own policy (InPrivate sign-ins, no delete, no secure desktop, brokered secrets) and the
bridge's approvals/judge still apply to every action.
"""

from __future__ import annotations

import logging

from django.db import transaction

logger = logging.getLogger("trmm")


def allowed_ids(core=None) -> list:
    """The computers the Operator may drive right now ([] while Operator is switched off)."""
    from core.models import CoreSettings

    core = core or CoreSettings.objects.only("ai_operator_enabled", "ai_operator_allowed_agent_ids").first()
    if not core or not core.ai_operator_enabled:
        return []
    return [str(a) for a in (core.ai_operator_allowed_agent_ids or []) if a]


def is_enabled(agent_id: str, core=None) -> bool:
    return str(agent_id or "") in set(allowed_ids(core))


def can_toggle(user, agent_id: str) -> bool:
    """May this person switch desktop control on/off for this computer?"""
    from core.session_caps import active_caps, role_allows
    from tacticalrmm.permissions import _has_perm_on_agent

    if not user or not getattr(user, "is_authenticated", False):
        return False
    try:
        if not _has_perm_on_agent(user, agent_id):
            return False
    except Exception:          # get_object_or_404 for an unknown agent
        return False
    return role_allows(user, "desktop") or "desktop" in active_caps(user, "device", agent_id)


def why_not_eligible(agent) -> str:
    """'' when this computer can be driven at all; otherwise the reason, in plain words."""
    from core.models import CoreSettings

    core = CoreSettings.objects.only("ai_operator_enabled").first()
    if not core or not core.ai_operator_enabled:
        return "Pi AI Operator (desktop access) is switched off in Global Settings."
    if agent.plat != "windows":
        return "AI desktop control works on Windows computers only."
    return ""


def set_enabled(agent, enabled: bool, *, by: str = "", via: str = "chat") -> dict:
    """Add or remove ONE computer from the Operator allowlist, audit it and tell the bridge.

    Returns {"changed": bool, "enabled": bool, "bridge_notified": bool}.
    """
    from core.models import CoreSettings
    from logs.models import AuditLog
    from tacticalrmm.constants import AuditActionType, AuditObjType

    agent_id = str(agent.agent_id)
    with transaction.atomic():
        core = CoreSettings.objects.select_for_update().first()
        ids = [str(a) for a in (core.ai_operator_allowed_agent_ids or []) if a]
        was = agent_id in ids
        if enabled and not was:
            ids.append(agent_id)
        elif not enabled and was:
            ids = [a for a in ids if a != agent_id]
        changed = was != bool(enabled)
        if changed:
            core.ai_operator_allowed_agent_ids = ids
            core.save(update_fields=["ai_operator_allowed_agent_ids"])
    if changed:
        try:
            AuditLog.objects.create(
                username=by or "unknown",
                agent=agent.hostname,
                agent_id=agent_id,
                object_type=AuditObjType.AGENT,
                action=AuditActionType.MODIFY,
                message=(f"{by or 'unknown'} {'ENABLED' if enabled else 'disabled'} AI desktop control "
                         f"(Pi AI Operator) on {agent.hostname} from the {via}."),
                debug_info={"feature": "ai_desktop_control", "enabled": bool(enabled), "via": via},
            )
        except Exception:
            logger.exception("ai desktop control: audit write failed")
    notified = push_to_bridge(agent, bool(enabled), by=by) if changed else False
    return {"changed": changed, "enabled": bool(enabled), "bridge_notified": notified}


def push_to_bridge(agent, enabled: bool, *, by: str = "") -> bool:
    """Tell the bridge so every LIVE chat on this computer gains or loses the desktop tools now
    (best effort: the next window open reads the allowlist anyway, and the coordinator refuses a
    computer that is off whatever the bridge thinks)."""
    import requests as _requests
    from django.conf import settings as _settings

    from agents.views import _pi_device_facts

    bridge = getattr(_settings, "PI_BRIDGE_URL", "http://127.0.0.1:8787")
    try:
        resp = _requests.post(f"{bridge}/pi/desktop", json={
            "agent_id": agent.agent_id,
            "enabled": bool(enabled),
            "by": by,
            "machine": {
                "agent_id": agent.agent_id,
                "hostname": agent.hostname,
                "device_facts": _pi_device_facts(agent),
            },
        }, timeout=5)
        return bool(resp.ok)
    except Exception:
        return False


def chat_desktop_machines(agents) -> list:
    """The computers OF THIS CHAT that desktop control could be switched on for, each with its
    current state. The bridge registers the Operator tools for them up front (hidden while off)
    so the hamburger switch can take effect in a live chat without reopening it."""
    from agents.views import _pi_device_facts

    ids = set(allowed_ids())
    from core.models import CoreSettings

    core = CoreSettings.objects.only("ai_operator_enabled").first()
    if not core or not core.ai_operator_enabled:
        return []
    return [
        {
            "agent_id": a.agent_id,
            "hostname": a.hostname,
            "device_facts": _pi_device_facts(a),
            "enabled": a.agent_id in ids,
        }
        for a in agents
        if a.plat == "windows"
    ]
