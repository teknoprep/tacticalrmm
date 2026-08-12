"""
Odoo -> Tactical RMM entry points for the `ai_pi_bridge` Odoo addon.

Why these live in Django and not in the Node bridge
---------------------------------------------------
Django is already the orchestrator for every AI surface here: it holds the
provider API keys, resolves which models a user may use, and mints the
short-lived session blobs that the Node bridge consumes from Redis. Putting the
Odoo entry point anywhere else would mean duplicating model resolution and
copying provider keys somewhere new.

So Odoo calls Django, Django mints a pi-bridge session token exactly as the
device chat and the AI Decision chat already do, and the chat UI opens the
existing token-authenticated WebSocket. No new public route on the Node bridge,
and `location ^~ /pi/ { return 404; }` in nginx stays exactly as it is.

Security
--------
These endpoints are authenticated by a SHARED SECRET, not a user session. The
secret identifies the Odoo *server*; it confers no authority inside Odoo and no
authority here beyond "may ask about a user and mint a chat session".

Nothing here can write to Odoo. Every Odoo read and write happens inside the
Odoo addon, as the logged-in Odoo user, through `request.env`. That is the whole
point of the split: Odoo's own ACLs, record rules and company rules are the
permission model, and this service never holds Odoo credentials for the user.
"""

import hmac
import logging

from django.conf import settings
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

logger = logging.getLogger("django.request")

SECRET_SETTING = "ODOO_AI_SHARED_SECRET"


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
def _configured_secret() -> str:
    return getattr(settings, SECRET_SETTING, "") or ""


def _authorised(request) -> bool:
    """Constant-time comparison of the Bearer secret.

    A plain `==` on a secret leaks length and prefix information through timing;
    `compare_digest` does not.
    """
    expected = _configured_secret()
    if not expected:
        return False
    header = request.META.get("HTTP_AUTHORIZATION", "")
    if not header.startswith("Bearer "):
        return False
    presented = header[len("Bearer "):].strip()
    if not presented:
        return False
    return hmac.compare_digest(presented, expected)


def _deny():
    return JsonResponse({"error": "unauthorised"}, status=401)


def _integration_enabled() -> bool:
    """Master switch in Global Settings.

    Checked on EVERY request, not just at session mint, so flipping it off
    closes the integration immediately -- including for sessions that are
    mid-conversation, since they must come back here to mint or re-resolve.
    Turning it off needs no nginx change and no ERP-side change.
    """
    from core.utils import get_core_settings

    return bool(getattr(get_core_settings(), "ai_erp_integration_enabled", False))


def _disabled():
    return JsonResponse(
        {
            "error": "disabled",
            "message": (
                "The ERP AI integration is switched off in Tactical RMM "
                "Global Settings."
            ),
        },
        status=503,
    )


def _allowed_origins(core) -> list:
    raw = getattr(core, "ai_erp_allowed_origins", "") or ""
    return [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]


# ---------------------------------------------------------------------------
# Identity resolution
# ---------------------------------------------------------------------------
def _resolve_user(email: str):
    """Map an Odoo login to a TRMM user, or return None.

    Rules, all deliberately fail-closed:

      * the login must be a non-blank email. 1183 of 1199 TRMM users have a
        BLANK email, so a query that lets an empty string through would match
        almost the entire user table;
      * the match is exact and case-insensitive;
      * the user must be active;
      * there must be EXACTLY ONE match. Django does not enforce uniqueness on
        `email`, so two matches is ambiguous and is treated as no match rather
        than picking one.

    No match means the caller gets the default model only. Being unmatched
    always grants less, never more.
    """
    from accounts.models import User

    email = (email or "").strip()
    if not email or "@" not in email:
        return None, "Odoo login is not an email address."

    matches = list(User.objects.filter(email__iexact=email, is_active=True)[:3])
    if not matches:
        return None, "No active RMM user has this email address."
    if len(matches) > 1:
        logger.warning(
            "odoo_ai: %s ambiguous RMM matches for %s; treating as no match",
            len(matches), email,
        )
        return None, "More than one RMM user has this email address."
    return matches[0], ""


def _allowed_models(user):
    """Which models this user may use.

    This mirrors the existing resolver in core.views.AIDecisionSession so there
    is one rule in force, including its fallback: a role with no explicitly
    allowed models gets the models flagged `is_default`. That fallback is what
    makes "no permissions configured" mean "default model only".
    """
    from core.models import AIModel

    enabled = AIModel.objects.filter(
        enabled=True, provider__enabled=True
    ).select_related("provider")

    if user is None:
        return [m for m in enabled if m.is_default]

    is_super = user.is_superuser or (user.role and user.role.is_superuser)
    if is_super:
        return list(enabled)

    role = user.role
    allowed = list(
        role.ai_allowed_models.filter(
            enabled=True, provider__enabled=True
        ).select_related("provider")
        if role
        else AIModel.objects.none()
    ) or [m for m in enabled if m.is_default]
    return allowed


def _mdict(model, with_key=False):
    out = {
        "provider": model.provider.name,
        "model_id": model.model_id,
        "name": model.display_name,
        "display_name": model.display_name,
        "thinking_level": model.thinking_level,
        "base_url": model.provider.base_url,
        "is_default": bool(model.is_default),
    }
    if with_key:
        out["api_key"] = model.provider.api_key
    return out


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@require_GET
@csrf_exempt
def health(request):
    """Reachability probe for the Odoo addon's Test Connection button."""
    if not _authorised(request):
        return _deny()
    if not _integration_enabled():
        return _disabled()
    return JsonResponse({"ok": True, "service": "trmm-odoo-ai"})


@csrf_exempt
@require_POST
def identity(request):
    """Resolve an Odoo login to its RMM identity and permitted models."""
    if not _authorised(request):
        return _deny()
    if not _integration_enabled():
        return _disabled()

    import json

    try:
        payload = json.loads(request.body or b"{}")
    except ValueError:
        return JsonResponse({"error": "malformed json"}, status=400)

    email = payload.get("email") or ""
    user, reason = _resolve_user(email)
    models = _allowed_models(user)

    default = next((m for m in models if m.is_default), models[0] if models else None)

    return JsonResponse({
        "matched": user is not None,
        "trmm_username": user.username if user else "",
        "reason": reason,
        # No API keys here: this response is only used to paint a model picker.
        "models": [_mdict(m) for m in models],
        "default_model": default.model_id if default else "",
        # Reported for transparency, NOT used to authorise Odoo writes. Odoo's own
        # ACLs decide what may be written in Odoo; this flag governs RMM/device
        # actions and has no knowledge of Odoo record rules.
        "rmm_can_mutate": bool(
            user
            and (
                user.is_superuser
                or (user.role and user.role.is_superuser)
                or (user.role and user.role.can_use_ai_mutate)
            )
        ),
    })


@csrf_exempt
@require_POST
def session(request):
    """Mint a pi-bridge chat session for an Odoo record and return its token.

    The token is handed to the chat UI, which opens the EXISTING WebSocket route
    `/pi/ws/<token>`. Because that UI is served from the RMM host, the origin
    check already on that nginx location (`$http_origin != "https://rmm.blueuc.com"`)
    is satisfied without any change to it.

    The blob carries context and prompts only. It deliberately carries NO Odoo
    credentials and enables no Odoo write tooling: the model can propose actions,
    and the Odoo addon executes them as the logged-in user after a human
    confirms. That keeps the permission boundary on the Odoo side.
    """
    if not _authorised(request):
        return _deny()
    if not _integration_enabled():
        return _disabled()

    import json

    from agents.pi_session import create_pi_session
    from core.utils import get_core_settings

    try:
        payload = json.loads(request.body or b"{}")
    except ValueError:
        return JsonResponse({"error": "malformed json"}, status=400)

    email = payload.get("email") or ""
    user, reason = _resolve_user(email)
    models = _allowed_models(user)
    if not models:
        return JsonResponse(
            {"error": "No AI models are enabled on the RMM server."}, status=503
        )

    requested = (payload.get("ai_model") or "").strip()
    chosen = next((m for m in models if m.is_default), models[0])
    if requested:
        match = next((m for m in models if m.model_id == requested), None)
        if not match:
            # Asking for something outside the resolved set is refused rather
            # than quietly downgraded, so the caller learns the picker is stale.
            return JsonResponse(
                {"error": "Requested model is not permitted for this user."},
                status=403,
            )
        chosen = match

    core = get_core_settings()

    blob = {
        "kind": "odoo",
        "surface": "odoo",
        # --- identity, for attribution and the transcript only ---
        "username": user.username if user else (email or "odoo-user"),
        "user_email": email,
        "user_display": payload.get("actor_name") or (email or ""),
        "odoo_matched": user is not None,
        "odoo_uid": payload.get("odoo_uid") or 0,
        # --- what the user is looking at ---
        "odoo_record": {
            "model": payload.get("model") or "",
            "res_id": payload.get("res_id") or 0,
            "display": payload.get("record_display") or "",
        },
        # Customer name, so AI spend is attributable per account and not just in
        # aggregate. Supplied by Odoo, which is the only side that knows it.
        "odoo_client": payload.get("client") or "",
        "context": payload.get("context") or "",
        "system_prompt": payload.get("system_prompt") or "",
        # Transcript of the resumed conversation, supplied by Odoo (the durable
        # store). The bridge session is in-memory, so without this a resumed
        # chat would start cold.
        "prior_messages": [
            {"role": m.get("role") or "user", "content": str(m.get("content") or "")}
            for m in (payload.get("prior_messages") or [])
            if isinstance(m, dict)
        ][-100:],
        # Names and descriptions only. The model is told what it may ASK for;
        # it is never given a way to execute any of it.
        "available_intents": payload.get("intents") or [],
        # --- model selection ---
        "provider": chosen.provider.name,
        "model_id": chosen.model_id,
        "thinking_level": chosen.thinking_level,
        "base_url": chosen.provider.base_url,
        "api_key": chosen.provider.api_key,
        "allowed_models": [_mdict(m, with_key=True) for m in models],
        # --- flags: this surface never acts on RMM or Odoo directly ---
        "mutate_allowed": False,
        "allow_mutating": False,
        "autoapprove_allowed": False,
        "auto_approve": False,
        "require_approval": True,
        "helpdesk_enabled": False,
        "operator": {"enabled": False},
        # Cost visibility.
        #
        # Where an RMM user matched, that side's role permission is authoritative
        # and nothing here overrides it -- can_view_ai_cost keeps meaning what it
        # has always meant.
        #
        # Where NO RMM user matched there is no role to consult, and defaulting to
        # hidden was wrong: the spend is recorded either way (the ledger write is
        # independent of this flag), so hiding the figure only stopped the person
        # spending the money from seeing it. Odoo decides that case, because Odoo is
        # the only side that knows the user at all.
        "cost_visible": bool(
            (
                user.is_superuser
                or (user.role and user.role.is_superuser)
                or (user.role and user.role.can_view_ai_cost)
            )
            if user
            else payload.get("cost_visible_hint")
        ),
        "persist_history": True,
        # Reasoning standards that belong to the RMM side. The Odoo addon carries
        # its own prompts for the work it executes itself; this is what the RMM
        # side contributes.
        "sales_prompt": getattr(core, "ai_sales_prompt", "") or "",
    }

    # SHARED SESSION. If the caller already has a token for this conversation and
    # its blob is still alive in Redis, hand the SAME token back. Every browser
    # viewing that conversation then attaches to one AI session on the server
    # rather than starting its own, which is what makes the output live for
    # everyone instead of private per tab.
    reuse = (payload.get("reuse_token") or "").strip()
    token = ""
    if reuse:
        from agents.pi_session import get_pi_session

        try:
            if get_pi_session(reuse):
                token = reuse
        except Exception as exc:  # noqa: BLE001 - a lookup failure just means mint
            logger.info("odoo_ai: could not check session %s: %s", reuse[:8], exc)

    reused = bool(token)
    if not token:
        token = create_pi_session(data=blob)

    return JsonResponse({
        "reused": reused,
        "token": token,
        "model_id": chosen.model_id,
        "model_name": chosen.display_name,
        "matched": user is not None,
        "reason": reason,
        "models": [_mdict(m) for m in models],
    })


# ---------------------------------------------------------------------------
# Runtime config for the embedded chat UI
# ---------------------------------------------------------------------------
@require_GET
@csrf_exempt
def ui_config(request):
    """Runtime configuration for the static chat UI.

    Deliberately UNAUTHENTICATED and deliberately empty of secrets. It returns
    only which origins may embed the page and where to open the WebSocket -- the
    same class of information as the frontend's own /env-config.js.

    This exists so the ERP hostname is NEVER hardcoded in the page. ERP URLs
    change; a hardcoded origin means editing and redeploying static assets, and
    an origin check that is wrong is an origin check that gets disabled. Reading
    it from Global Settings at runtime keeps the check honest and editable.

    A token is still required to do anything: the UI cannot open a session
    without one, and only the parent ERP tab can supply it.
    """
    from core.utils import get_core_settings

    core = get_core_settings()
    if not bool(getattr(core, "ai_erp_integration_enabled", False)):
        return JsonResponse({"enabled": False, "parent_origins": [], "ws_base": ""})

    ws_base = (getattr(core, "ai_erp_ws_base", "") or "").strip().rstrip("/")
    if not ws_base:
        # Derive from the incoming request. Correct whenever the API is reached
        # on the same public host the UI was served from.
        scheme = "wss" if request.is_secure() else "ws"
        ws_base = f"{scheme}://{request.get_host()}"

    return JsonResponse({
        "enabled": True,
        "parent_origins": _allowed_origins(core),
        "ws_base": f"{ws_base}/pi/ws/",
    })


# ---------------------------------------------------------------------------
# Brand / email formatting
# ---------------------------------------------------------------------------
@csrf_exempt
@require_GET
def brand(request):
    """Brand tokens and the customer-reply sign-off, from the settings already here.

    The Odoo addon must produce review emails that look like everything else the
    company sends. Rather than a second copy of the palette and the sign-off drifting
    from this one, both are read from where they already live:

      * tokens from the bridge's brand.js -- the single source used by the helpdesk
        and sales email builders;
      * the sign-off from CoreSettings.ai_helpdesk_code, which is the SINGLE SOURCE
        OF TRUTH for it. Duplicating that string is exactly how TICKET/55726 ended
        up with a double sign-off.
    """
    if not _authorised(request):
        return _deny()
    if not _integration_enabled():
        return _disabled()

    import os
    import re

    from core.utils import get_core_settings

    tokens = {}
    brand_js = "/opt/pi-trmm-bridge/src/brand.js"
    try:
        if os.path.exists(brand_js):
            with open(brand_js, "r", encoding="utf-8") as fh:
                src = fh.read(20000)
            for key in ("name", "legalName", "tagline", "phone", "supportEmail",
                        "web", "address", "logoUrl", "primary", "primaryDark",
                        "text", "dark", "muted", "border"):
                m = re.search(r'\b%s:\s*"([^"]*)"' % key, src)
                if m:
                    tokens[key] = m.group(1)
    except OSError as exc:
        logger.warning("odoo_ai: could not read brand.js: %s", exc)

    signature = ""
    try:
        code = getattr(get_core_settings(), "ai_helpdesk_code", "") or ""
        m = re.search(r'REPLY_SIGNATURE\s*=\s*"((?:[^"\\]|\\.)*)"', code)
        if m:
            signature = m.group(1).encode().decode("unicode_escape")
    except Exception as exc:  # noqa: BLE001 - never fail the request over this
        logger.warning("odoo_ai: could not read REPLY_SIGNATURE: %s", exc)

    return JsonResponse({
        "tokens": tokens,
        "signature": signature,
    })


# ---------------------------------------------------------------------------
# AI Decision hand-off
# ---------------------------------------------------------------------------
@csrf_exempt
@require_POST
def decision(request):
    """Find, or create, the AI Decision thread for a helpdesk ticket.

    A ticket opened from Odoo should hand over to AI Decision when one exists,
    because that surface has the full RMM tool belt -- devices, scripts, the
    helpdesk operations -- while the Odoo panel deliberately has none. Sending a
    technician into the weaker surface when the stronger one already holds the
    thread would be a downgrade, and would split the conversation in two.

    Looked up by ticket_ref rather than by scraping the chatter, because that is
    the authoritative key: core/tasks.py keeps ONE durable thread per ticket_ref
    and reuses its token across close/reopen so history survives. A chatter link
    can be deleted, edited, or live in an email instead of a note; the row cannot.

    POST {"ticket_ref": "TICKET/59481"}                 -> look up only
    POST {"ticket_ref": "...", "create": true}           -> reuse or create
    """
    if not _authorised(request):
        return _deny()
    if not _integration_enabled():
        return _disabled()

    import json

    from django.conf import settings as dj_settings
    from django.utils.crypto import get_random_string

    from core.models import AIDecisionRequest

    try:
        payload = json.loads(request.body or b"{}")
    except ValueError:
        return JsonResponse({"error": "malformed json"}, status=400)

    ticket_ref = (payload.get("ticket_ref") or "").strip()
    if not ticket_ref:
        return JsonResponse({"error": "ticket_ref is required"}, status=400)

    base = (
        dj_settings.CORS_ORIGIN_WHITELIST[0]
        if getattr(dj_settings, "CORS_ORIGIN_WHITELIST", None)
        else ""
    )

    # Newest first, any status: a closed thread is still the thread for this ticket.
    existing = (
        AIDecisionRequest.objects.filter(ticket_ref=ticket_ref)
        .order_by("-updated")
        .first()
    )

    if not existing and not payload.get("create"):
        return JsonResponse({"exists": False, "url": "", "ticket_ref": ticket_ref})

    created = False
    if not existing:
        # Same reuse rule as the poller, so a thread created from Odoo and one
        # created by triage can never diverge into two threads for one ticket.
        existing = AIDecisionRequest.objects.create(
            token=get_random_string(32),
            ticket_ref=ticket_ref,
            question=(payload.get("question") or "").strip(),
            context=payload.get("context") or {},
            status="open",
        )
        created = True

    return JsonResponse({
        "exists": True,
        "created": created,
        "url": f"{base}/ai-decision/{existing.token}" if base else "",
        "token": existing.token,
        "ticket_ref": existing.ticket_ref,
        "status": existing.status,
        "messages": len(existing.messages or []),
        "updated": existing.updated.isoformat() if existing.updated else "",
    })


# ---------------------------------------------------------------------------
# Tech time (work ledger)
# ---------------------------------------------------------------------------
@csrf_exempt
@require_POST
def work(request):
    """Record technician TIME for an Odoo AI conversation.

    Cost and time are different questions and the RMM already separates them. This
    feeds the work ledger, not the spend ledger.

    The classification matters and is not a judgement call: a technician using the
    AI panel is a technician WORKING. So every entry is actor_kind="tech_via_ai"
    and the minutes go in human_minutes, never ai_minutes. Building a quote through
    the assistant is the tech's time exactly as typing it by hand would be; what the
    AI saved is accounted for separately as baseline-minus-actual, which is why the
    model refuses to sum human and AI minutes into one figure.

    Minutes come from the SAME estimator the other surfaces use
    (work_ledger.attention_minutes with caps_from_settings), so an hour in Odoo and
    an hour in a device chat are measured the same way and the totals reconcile.

    Idempotent: keyed on the conversation, so Odoo can post the full timestamp list
    after every turn and the entry is recomputed rather than duplicated.
    """
    if not _authorised(request):
        return _deny()
    if not _integration_enabled():
        return _disabled()

    import json
    from datetime import datetime

    from django.utils.dateparse import parse_datetime

    from core.models import TicketWorkEntry
    from core.utils import get_core_settings
    from core.work_ledger import attention_minutes, caps_from_settings, method_label

    try:
        payload = json.loads(request.body or b"{}")
    except ValueError:
        return JsonResponse({"error": "malformed json"}, status=400)

    conv_id = payload.get("conversation_id")
    if not conv_id:
        return JsonResponse({"error": "conversation_id is required"}, status=400)

    events = []
    for raw in payload.get("events") or []:
        dt = parse_datetime(raw) if isinstance(raw, str) else None
        if dt:
            if dt.tzinfo is None:
                from django.utils import timezone as _tz
                dt = _tz.make_aware(dt, _tz.utc)
            events.append(dt)
    events.sort()
    if not events:
        return JsonResponse({"ok": True, "skipped": "no timestamps"})

    user, _reason = _resolve_user(payload.get("email") or "")
    core = get_core_settings()
    caps = caps_from_settings(core)
    minutes, evidence = attention_minutes(events, caps)

    evidence.update({
        "source": "odoo_ai_panel",
        "conversation_id": conv_id,
        "turns": len(events),
        "odoo_model": payload.get("model") or "",
        "odoo_res_id": payload.get("res_id") or 0,
    })

    # One entry per conversation, recomputed in place.
    key = "odoo:conv:%s" % conv_id
    entry = TicketWorkEntry.objects.filter(source=key).first()
    values = dict(
        ticket_ref=payload.get("ticket_ref") or "",
        actor_kind="tech_via_ai",
        actor_user=user,
        actor_username=(user.username if user else (payload.get("email") or "")),
        actor_display=payload.get("actor_name") or (user.get_full_name() if user else ""),
        surface="odoo_ai",
        started_at=events[0],
        ended_at=events[-1],
        human_minutes=minutes,
        ai_minutes=0,
        confidence="sessionized",
        method=method_label(caps, kind="odoo-panel-turns"),
        evidence=evidence,
        source=key,
        note=(payload.get("record_display") or "")[:400],
    )
    if entry:
        for k, v in values.items():
            setattr(entry, k, v)
        entry.save()
        created = False
    else:
        entry = TicketWorkEntry.objects.create(**values)
        created = True

    return JsonResponse({
        "ok": True, "created": created, "entry_id": entry.id,
        "human_minutes": minutes, "turns": len(events),
        "actor": entry.actor_username, "evidence": evidence,
    })
