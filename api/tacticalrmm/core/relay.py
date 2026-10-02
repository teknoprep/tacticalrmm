"""PI RELAY - Django side (2026-09-27). See /opt/pi-trmm-bridge/docs/PI-RELAY.md.

A pi running anywhere talks to the bridge (https://api.blueuc.com/pi/relay/v1/...) with
HTTP Basic: RMM username (or email) + an AIRelayKey. The bridge asks THIS module whether
the credential is good (POST /core/ai/relay/verify/, bridge-only) and gets back the user,
the key's agent group roster and the provider keys that group needs. Model calls then run
in the bridge with the RMM's keys and are written to the spend ledger as surface "relay".

Key management endpoints (the Settings UI and `manage.py relay_keys` both use this logic):
  GET    /core/ai/relay/keys/        list (admins: all, others: their own)
  POST   /core/ai/relay/keys/        issue a key - the full key is returned ONCE
  DELETE /core/ai/relay/keys/<pk>/   revoke
"""

from __future__ import annotations

import datetime as dt
import hmac
from decimal import Decimal

from django.conf import settings
from django.db.models import Sum
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from tacticalrmm.permissions import _has_perm


# ---------------------------------------------------------------------------- helpers
def user_can_use_ai(user) -> bool:
    if not user or not user.is_active:
        return False
    if user.is_superuser or (user.role and getattr(user.role, "is_superuser", False)):
        return True
    return bool(user.role and getattr(user.role, "can_use_ai", False))


def _local_day_and_month_start():
    from core.models import CoreSettings

    try:
        import zoneinfo

        tz = zoneinfo.ZoneInfo(CoreSettings.objects.first().default_time_zone or "UTC")
    except Exception:
        tz = dt.timezone.utc
    now = timezone.now().astimezone(tz)
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return day, day.replace(day=1)


def key_spend(row) -> dict:
    from core.models import AISpendEntry

    day, month = _local_day_and_month_start()
    qs = AISpendEntry.objects.filter(session_id__startswith=row.ledger_prefix)
    today = qs.filter(at__gte=day).aggregate(s=Sum("cost_total"))["s"] or Decimal(0)
    this_month = qs.filter(at__gte=month).aggregate(s=Sum("cost_total"))["s"] or Decimal(0)
    return {"today_usd": float(today), "month_usd": float(this_month)}


def key_public(row, *, spend: bool = True) -> dict:
    out = {
        "id": row.pk,
        "key_id": row.key_id,
        "key_hint": f"{row.PREFIX}_{row.key_id}_…",
        "label": row.label,
        "purpose": row.purpose,
        "username": row.user.username,
        "email": row.user.email or "",
        "groups": [{"id": g.id, "name": g.name, "slug": g.slug} for g in row.groups.all()],
        "created": row.created.isoformat() if row.created else None,
        "created_by": row.created_by,
        "expires_at": row.expires_at.isoformat() if row.expires_at else None,
        "revoked_at": row.revoked_at.isoformat() if row.revoked_at else None,
        "revoked_by": row.revoked_by,
        "last_used_at": row.last_used_at.isoformat() if row.last_used_at else None,
        "last_used_ip": row.last_used_ip,
        "daily_budget_usd": float(row.daily_budget_usd) if row.daily_budget_usd is not None else None,
        "monthly_budget_usd": float(row.monthly_budget_usd) if row.monthly_budget_usd is not None else None,
        "allowed_ips": row.allowed_ips,
        "unlimited": row.daily_budget_usd is None and row.monthly_budget_usd is None,
        "install_sent_at": row.install_sent_at.isoformat() if row.install_sent_at else None,
        "install_sent_to": row.install_sent_to,
        "install_sent_by": row.install_sent_by,
        "rotated_at": row.rotated_at.isoformat() if row.rotated_at else None,
        "email_to": install_recipient(row.user),
        "active": row.revoked_at is None and (row.expires_at is None or row.expires_at > timezone.now()),
    }
    out["uses"] = key_uses(row)
    if spend:
        out["spend"] = key_spend(row)
    return out


LOCAL_IPS = {"127.0.0.1", "::1", "localhost"}


def where_label(ip: str) -> str:
    """Plain words for an address, so "127.0.0.1" stops being a riddle."""
    ip = str(ip or "")
    if ip in LOCAL_IPS:
        return "this RMM server itself (local)"
    if ip.startswith(("10.", "192.168.")) or any(ip.startswith(f"172.{n}.") for n in range(16, 32)):
        return "private network"
    return "internet" if ip else "unknown"


def key_uses(row, limit: int = 12) -> list:
    return [{
        "ip": u.ip, "where": where_label(u.ip), "client": u.client, "times": u.times,
        "first_seen": u.first_seen.isoformat(), "last_seen": u.last_seen.isoformat(),
    } for u in row.uses.all()[:limit]]


def record_use(row, ip: str = "", client: str = "") -> None:
    """Where this key was just used from (see core.models.AIRelayKeyUse)."""
    from django.db.models import F
    from core.models import AIRelayKeyUse
    now = timezone.now()
    ip = (ip or "unknown")[:64]
    client = (client or "")[:64]
    n = AIRelayKeyUse.objects.filter(key=row, ip=ip).update(
        last_seen=now, times=F("times") + 1, **({"client": client} if client else {}))
    if not n:
        AIRelayKeyUse.objects.get_or_create(key=row, ip=ip, defaults={"first_seen": now, "last_seen": now, "client": client})


# ---------------------------------------------------------------------------- verify
def verify(username: str, full_key: str, ip: str = "", client: str = "") -> dict:
    """The one decision. Returns {"ok": True, ...} or {"ok": False, "reason": ..., "status": ...}.

    Reasons are for the bridge's log; the bridge shows the CLIENT only a generic message for
    anything credential-related, so this cannot be used as an oracle for which part was wrong.
    """
    from core.agent_groups import public_group
    from core.models import AIProvider, AIRelayKey, CoreSettings

    def no(reason, status=401, message=None):
        return {"ok": False, "reason": reason, "status": status, "message": message}

    key_id = AIRelayKey.parse(full_key)
    if not key_id:
        return no("malformed key")
    row = (AIRelayKey.objects.select_related("user", "user__role")
           .prefetch_related("groups").filter(key_id=key_id).first())
    if not row or not row.matches(full_key):
        return no(f"unknown key or bad secret ({key_id})")
    u = row.user
    uname = str(username or "").strip().lower()
    if not uname or uname not in {u.username.lower(), (u.email or "").lower()}:
        return no(f"username '{uname}' does not own key {key_id}")
    if row.revoked_at:
        return no(f"key {key_id} revoked")
    if row.expires_at and row.expires_at <= timezone.now():
        return no(f"key {key_id} expired")
    if not user_can_use_ai(u):
        return no(f"user {u.username} inactive or lacks can_use_ai")
    core = CoreSettings.objects.first()
    if not core or not core.ai_module_enabled:
        return no("AI module disabled", 503, "The AI module is disabled on this RMM.")
    group_objs = list(row.groups.filter(enabled=True).prefetch_related("members"))
    if not group_objs:
        names = ", ".join(row.groups.values_list("name", flat=True)) or "(none)"
        return no(f"key {key_id} has no enabled group", 403, f"The agent group(s) on this key are disabled: {names}.")
    if ip and not row.ip_allowed(ip):
        return no(f"ip {ip} not in allowlist for {key_id}", 403, "This key may not be used from this address.")

    spend = key_spend(row)
    if row.daily_budget_usd is not None and spend["today_usd"] >= float(row.daily_budget_usd):
        return no(f"daily budget spent ({key_id})", 429,
                  f"Daily budget of ${row.daily_budget_usd} for this key is used up (resets at midnight).")
    if row.monthly_budget_usd is not None and spend["month_usd"] >= float(row.monthly_budget_usd):
        return no(f"monthly budget spent ({key_id})", 429,
                  f"Monthly budget of ${row.monthly_budget_usd} for this key is used up.")

    groups = [public_group(g) for g in group_objs]
    providers_needed = {r["provider"] for grp in groups for r in grp.get("roles", [])}
    provider_keys = {
        p.name: p.api_key
        for p in AIProvider.objects.filter(enabled=True, name__in=providers_needed)
        if p.api_key
    }

    # last-used bookkeeping, at most once a minute per key (this runs on every cache miss)
    now = timezone.now()
    if not row.last_used_at or (now - row.last_used_at).total_seconds() > 60 or row.last_used_ip != ip:
        type(row).objects.filter(pk=row.pk).update(last_used_at=now, last_used_ip=(ip or "")[:64])
    try:
        record_use(row, ip, client)
    except Exception:  # bookkeeping must never refuse a valid key
        pass

    return {
        "ok": True,
        "user": {
            "username": u.username,
            "email": u.email or "",
            "display": (u.get_full_name() if hasattr(u, "get_full_name") else "") or u.username,
        },
        "key": {
            "key_id": row.key_id,
            "label": row.label,
            "expires_at": row.expires_at.isoformat() if row.expires_at else None,
            "daily_budget_usd": float(row.daily_budget_usd) if row.daily_budget_usd is not None else None,
            "monthly_budget_usd": float(row.monthly_budget_usd) if row.monthly_budget_usd is not None else None,
            "ledger_prefix": row.ledger_prefix,
            "spend": spend,
        },
        "groups": groups,
        "provider_keys": provider_keys,
    }


class AIRelayVerify(APIView):
    """Bridge-only. Two locks: the bridge's TRMM API key (IsAuthenticated) AND the 512-bit
    PI_RELAY_INTERNAL_SECRET in X-Relay-Internal. The response carries provider API keys,
    so neither alone is enough."""

    permission_classes = [IsAuthenticated]

    def post(self, request):
        expected = getattr(settings, "PI_RELAY_INTERNAL_SECRET", "")
        got = request.headers.get("X-Relay-Internal", "")
        if not expected or not hmac.compare_digest(expected.encode(), got.encode()):
            return Response({"ok": False, "reason": "forbidden"}, status=403)
        d = request.data or {}
        return Response(verify(str(d.get("username") or ""), str(d.get("key") or ""), str(d.get("ip") or ""),
                               str(d.get("client") or "")))


# ---------------------------------------------------------------------------- management
def _is_admin(request) -> bool:
    return _has_perm(request, "can_edit_core_settings")


MAX_BUDGET_USD = Decimal("100000")


class BadInput(ValueError):
    pass


def parse_budget(v):
    """None / "" / "unlimited" -> None (no cap). Otherwise a USD amount 0..100000."""
    if v is None or str(v).strip().lower() in ("", "none", "null", "unlimited"):
        return None
    try:
        d = Decimal(str(v)).quantize(Decimal("0.01"))
    except Exception:
        raise BadInput(f"'{v}' is not a dollar amount")
    if d < 0 or d > MAX_BUDGET_USD:
        raise BadInput(f"budget must be between $0 and ${MAX_BUDGET_USD}")
    return d


def parse_ips(v) -> str:
    import ipaddress

    items = [x.strip() for x in str(v or "").replace("\n", ",").split(",") if x.strip()]
    for x in items:
        try:
            ipaddress.ip_network(x, strict=False)
        except ValueError:
            raise BadInput(f"'{x}' is not an IP address or CIDR")
    return ", ".join(items)


def resolve_budgets(d, *, is_admin: bool):
    """-> (daily, monthly) from a create/edit payload. Unlimited = both None, admins only;
    otherwise at least one cap is required (a key with no cap must be a deliberate choice)."""
    if d.get("unlimited") in (True, "true", "1", 1):
        if not is_admin:
            raise PermissionError("Only an admin can give a key unlimited spend.")
        return None, None
    daily, monthly = parse_budget(d.get("daily_budget_usd")), parse_budget(d.get("monthly_budget_usd"))
    if daily is None and monthly is None:
        raise BadInput("Set a daily and/or monthly budget, or choose Unlimited.")
    return daily, monthly


def issue_key(*, user, groups, label="", created_by="", expires_days=None,
              daily_budget_usd=None, monthly_budget_usd=None, allowed_ips="", purpose=""):
    from core.models import AIRelayKey

    expires_at = timezone.now() + dt.timedelta(days=int(expires_days)) if expires_days else None
    row, full_key = AIRelayKey.issue(
        user=user, label=label, created_by=created_by, expires_at=expires_at,
        daily_budget_usd=Decimal(str(daily_budget_usd)) if daily_budget_usd not in (None, "") else None,
        monthly_budget_usd=Decimal(str(monthly_budget_usd)) if monthly_budget_usd not in (None, "") else None,
        allowed_ips=allowed_ips or "",
    )
    if purpose:
        type(row).objects.filter(pk=row.pk).update(purpose=str(purpose)[:2000])
        row.purpose = str(purpose)[:2000]
    row.groups.set(list(groups))
    return row, full_key


def resolve_groups(d):
    """Groups from a payload. Accepts `group_ids` (list), `group_id` (single) or `group`
    (a slug, a comma-separated list of slugs, or a list of either). Unknown slugs are dropped
    silently and the caller reports what matched."""
    from core.models import AIAgentGroup

    ids = d.get("group_ids")
    if ids is None:
        ids = d.get("group_id") or d.get("group") or []
    if isinstance(ids, (str, int)):
        ids = ids if isinstance(ids, int) else [x.strip() for x in str(ids).split(",")]
    elif not isinstance(ids, (list, tuple, set)):
        ids = [ids]
    ids = [x for x in ids if str(x).strip()]
    out = []
    for v in ids:
        g = (AIAgentGroup.objects.filter(pk=v).first() if str(v).isdigit()
             else AIAgentGroup.objects.filter(slug=str(v)).first())
        if g and g not in out:
            out.append(g)
    return out


class AIRelayKeys(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from core.models import AIRelayKey

        qs = AIRelayKey.objects.select_related("user").prefetch_related("groups")
        if not _is_admin(request):
            qs = qs.filter(user=request.user)
        return Response({"keys": [key_public(k) for k in qs],
                         "client_version": served_client_version()})

    def post(self, request):
        from accounts.models import User
        from core.models import AIAgentGroup

        d = request.data or {}
        target = request.user
        uname = str(d.get("username") or "").strip()
        if uname and uname.lower() not in {request.user.username.lower(), (request.user.email or "").lower()}:
            if not _is_admin(request):
                return Response("Only an admin can issue a relay key for another user.", status=403)
            target = (User.objects.filter(username__iexact=uname).first()
                      or User.objects.filter(email__iexact=uname).first())
            if not target:
                return Response(f"No RMM user '{uname}'.", status=400)
        if not user_can_use_ai(target):
            return Response(f"{target.username} is inactive or does not have the 'Use AI' permission.", status=400)
        groups = resolve_groups(d)
        if not groups:
            return Response("Pick at least one agent group.", status=400)
        try:
            daily, monthly = resolve_budgets(d, is_admin=_is_admin(request))
            ips = parse_ips(d.get("allowed_ips"))
        except PermissionError as e:
            return Response(str(e), status=403)
        except BadInput as e:
            return Response(str(e), status=400)
        purpose = str(d.get("purpose") or "").strip()
        if not purpose:
            # Every key must be explainable later: which computer, which person, why.
            return Response("Say why this key is needed (Purpose) - e.g. \"Sean's laptop, pi for ticket work\".", status=400)
        row, full_key = issue_key(
            user=target, groups=groups, label=str(d.get("label") or "")[:100],
            created_by=request.user.username, expires_days=d.get("expires_days") or None,
            daily_budget_usd=daily, monthly_budget_usd=monthly, allowed_ips=ips, purpose=purpose,
        )
        email = None
        if d.get("send_email") in (True, "true", "1", 1):
            email = send_install_email(row, full_key, request.user.username)
            if email["ok"]:
                type(row).objects.filter(pk=row.pk).update(
                    install_sent_at=timezone.now(), install_sent_to=email["sent_to"],
                    install_sent_by=request.user.username)
                row.refresh_from_db()
        return Response({"key": full_key, "row": key_public(row, spend=False), "email": email,
                         "warning": "Copy this key now. It is never shown again."})


class AIRelayKeyDetail(APIView):
    permission_classes = [IsAuthenticated]

    def patch(self, request, pk):
        """Edit a key. Owner or admin: label, allowed_ips. Admin only: budgets / unlimited,
        expiry, and which groups the key reaches (a user must not be able to lift their own cap
        or widen their own access). Takes effect within 30s."""
        from core.models import AIRelayKey

        row = AIRelayKey.objects.filter(pk=pk).first()
        if not row:
            return Response("Not found.", status=404)
        admin = _is_admin(request)
        if row.user_id != request.user.id and not admin:
            return Response("Not yours.", status=403)
        if row.revoked_at:
            return Response("This key is revoked; issue a new one.", status=400)
        d = request.data or {}
        fields = []
        new_groups = None
        try:
            if "label" in d:
                row.label = str(d.get("label") or "")[:100]
                fields.append("label")
            if "purpose" in d:
                row.purpose = str(d.get("purpose") or "").strip()[:2000]
                fields.append("purpose")
            if "allowed_ips" in d:
                row.allowed_ips = parse_ips(d.get("allowed_ips"))
                fields.append("allowed_ips")
            wants_budget = any(k in d for k in ("unlimited", "daily_budget_usd", "monthly_budget_usd"))
            wants_expiry = any(k in d for k in ("expires_days", "never_expires"))
            wants_groups = any(k in d for k in ("group_ids", "group_id", "group"))
            if (wants_budget or wants_expiry) and not admin:
                return Response("Only an admin can change a key's budget or expiry.", status=403)
            if wants_groups:
                if not admin:
                    return Response("Only an admin can change which groups a key reaches.", status=403)
                groups = resolve_groups(d)
                if not groups:
                    raise BadInput("Pick at least one agent group.")
                new_groups = groups
            if wants_budget:
                row.daily_budget_usd, row.monthly_budget_usd = resolve_budgets(d, is_admin=admin)
                fields += ["daily_budget_usd", "monthly_budget_usd"]
            if wants_expiry:
                if d.get("never_expires") in (True, "true", "1", 1) or d.get("expires_days") in (None, "", 0, "0"):
                    row.expires_at = None
                else:
                    days = int(d.get("expires_days"))
                    if days < 1 or days > 3650:
                        raise BadInput("expiry must be 1-3650 days")
                    row.expires_at = timezone.now() + dt.timedelta(days=days)
                fields.append("expires_at")
        except PermissionError as e:
            return Response(str(e), status=403)
        except (BadInput, ValueError) as e:
            return Response(str(e), status=400)
        if fields:
            row.save(update_fields=fields)
        if new_groups is not None:
            row.groups.set(new_groups)
        return Response(key_public(row))

    def delete(self, request, pk):
        """DELETE = revoke (stops working within 30s, row kept as the record of who had access).
        DELETE ?purge=1 = delete the row for good - admin only, and only once revoked, so an
        active key can never be removed by a single click."""
        from core.models import AIRelayKey

        row = AIRelayKey.objects.filter(pk=pk).first()
        if not row:
            return Response("Not found.", status=404)
        admin = _is_admin(request)
        if row.user_id != request.user.id and not admin:
            return Response("Not yours.", status=403)
        purge = str(request.query_params.get("purge") or "").lower() in ("1", "true", "yes")
        if purge:
            if not admin:
                return Response("Only an admin can delete a key permanently.", status=403)
            if not row.revoked_at:
                return Response("Revoke the key first, then delete it.", status=400)
            who = str(row)
            row.delete()
            return Response({"ok": True, "deleted": who})
        if not row.revoked_at:
            row.revoked_at = timezone.now()
            row.revoked_by = request.user.username
            row.save(update_fields=["revoked_at", "revoked_by"])
        return Response(key_public(row, spend=False))


# ---------------------------------------------------------------------------- install email
RELAY_PUBLIC_URL = "https://api.blueuc.com/pi/relay/v1"


def install_recipient(user) -> str:
    """The user's RMM email; a username that IS an email works too. '' = nowhere to send."""
    import re

    for v in (user.email, user.username):
        v = str(v or "").strip()
        if re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", v):
            return v
    return ""


def build_install_email(row, full_key: str, sent_by: str) -> tuple[str, str, str]:
    """-> (subject, text, html). One email per KEY, listing every group it can reach.
    Light theme, dark text (email clients strip backgrounds)."""
    from html import escape as e

    u = row.user
    name = (u.get_full_name() if hasattr(u, "get_full_name") else "") or u.username
    login = install_recipient(u) or u.username
    ginfo = []
    for g in row.groups.all().order_by("name"):
        roles = [(m.role, m.display_name or m.model_id) for m in g.members.filter(enabled=True).order_by("id")]
        ginfo.append({
            "slug": g.slug, "name": g.name, "description": g.description or "",
            "roles": roles, "orch": next((d for r, d in roles if r == "orchestrator"), ""),
            "specialists": ", ".join(f"{r} ({d})" for r, d in roles if r not in ("orchestrator", "judge")),
        })
    if not ginfo:  # a key with no groups cannot be used; say so rather than send a useless email
        ginfo = [{"slug": "-", "name": "(no group)", "description": "", "roles": [], "orch": "", "specialists": ""}]
    group_names = ", ".join(g["name"] for g in ginfo)
    budget = ("Unlimited" if row.daily_budget_usd is None and row.monthly_budget_usd is None else
              " / ".join(x for x in (
                  f"${row.daily_budget_usd} per day" if row.daily_budget_usd is not None else "",
                  f"${row.monthly_budget_usd} per month" if row.monthly_budget_usd is not None else "") if x))
    expires = row.expires_at.strftime("%Y-%m-%d") if row.expires_at else "never"
    subject = f"Pi RMM access for {name} - {group_names} (delete this email after setup)"

    group_lines = "\n".join(
        f"  - {g['name']} ({g['slug']})" + (f" - {g['description']}" if g["description"] else "") for g in ginfo)
    use_lines = "\n".join(f"      /group {g['slug']:<12} run the chat on {g['name']} ({g['orch']})" for g in ginfo)
    spec_block = "\n\n".join(
        f"  {g['name']} specialists (the AI calls these itself with `delegate`):\n    {g['specialists']}"
        for g in ginfo if g["specialists"])

    text = f"""Hi {name},

You have been given access to the RMM's AI agent group(s) from pi on your own computer. Every AI
call goes through the RMM (company API keys, company spend tracking) - you do not need your own
OpenAI / Anthropic / DeepSeek keys.

YOUR SIGN-IN (treat the key like a password)
  RMM username: {login}
  Relay key:    {full_key}
  Groups:       {group_names}
{group_lines}
  Spend limit:  {budget}  (for all groups together)
  Expires:      {expires}

STEP 1 - INSTALL PI (skip if you already have it)
  All systems: install Node.js 22.19 or newer from https://nodejs.org (LTS), then run:
      npm install -g --ignore-scripts @earendil-works/pi-coding-agent
  Mac / Linux alternative:
      curl -fsSL https://pi.dev/install.sh | sh
  Windows: also install Git for Windows (https://git-scm.com/download/win) - pi uses Git Bash
  to run commands. Run the npm command in PowerShell or Windows Terminal.

STEP 2 - INSTALL THE RMM EXTENSION
  Mac / Linux (Terminal):
      curl -fsSL {RELAY_PUBLIC_URL}/client/install.sh | bash
  Windows (PowerShell):
      irm {RELAY_PUBLIC_URL}/client/install.ps1 | iex

STEP 3 - SIGN IN (once)
  Start pi (type: pi), then type:
      /rmm-login
  Enter your RMM username ({login}) and the relay key above. It signs you in to every group at once.

STEP 4 - USE IT
{use_lines}
      /rmm-status        your groups, models and spend today / this month
{spec_block}
  Everything you run is recorded against your name in the RMM.

DELETE THIS EMAIL WHEN YOU ARE SIGNED IN
  The relay key is a password that spends company money on AI and is tied to your name.
  Email is stored on mail servers, synced to phones, backed up and easy to forward - anyone who
  gets this key and your username can use it until it is revoked.
  After /rmm-login works (the key is then saved on your computer, readable only by you):
    1. delete this email, and
    2. empty Deleted Items / Trash.
  Never paste the key into a ticket, chat, document or screenshot. If you think it leaked,
  tell your RMM admin - they can revoke it or send you a new one in seconds.

Sent by {sent_by} from the RMM.
"""

    code = "font-family:Consolas,Menlo,monospace;background:#f4f4f4;border:1px solid #d0d7de;border-radius:4px;padding:8px 10px;display:block;white-space:pre-wrap;word-break:break-all;color:#24292f"
    h2 = "color:#1a3c6e;font-size:16px;margin:22px 0 6px"
    th = "background-color:#1a3c6e;color:#ffffff;text-align:left;padding:6px 10px"
    td = "padding:6px 10px;border-bottom:1px solid #e1e4e8;color:#24292f"
    group_rows = "".join(
        f"<tr><td style='{td}'><b>{e(g['name'])}</b> (<code>{e(g['slug'])}</code>)</td>"
        f"<td style='{td}'>{e(g['orch'])}</td>"
        f"<td style='{td}'>{e(g['specialists'] or '-')}</td></tr>" for g in ginfo)
    use_rows = "".join(
        f"<tr><td style='{td}'><code>/group {e(g['slug'])}</code></td><td style='{td}'>Run the chat on {e(g['name'])}</td></tr>"
        for g in ginfo)
    html = f"""<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#24292f;background:#ffffff;max-width:760px">
<p>Hi {e(name)},</p>
<p>You have been given access to the RMM's <b>{e(group_names)}</b> AI agent group(s) from <b>pi</b> on your own computer.
Every AI call goes through the RMM (company API keys, company spend tracking) - you do <b>not</b> need your own OpenAI / Anthropic / DeepSeek keys.</p>

<h2 style="{h2}">Your sign-in (treat the key like a password)</h2>
<table style="border-collapse:collapse;width:100%">
<tr><td style="{td};width:150px"><b>RMM username</b></td><td style="{td}"><code style="{code}">{e(login)}</code></td></tr>
<tr><td style="{td}"><b>Relay key</b></td><td style="{td}"><code style="{code}">{e(full_key)}</code></td></tr>
<tr><td style="{td}"><b>Groups</b></td><td style="{td}">{e(group_names)}</td></tr>
<tr><td style="{td}"><b>Spend limit</b></td><td style="{td}">{e(budget)} <span style="color:#57606a">(all groups together)</span></td></tr>
<tr><td style="{td}"><b>Expires</b></td><td style="{td}">{e(expires)}</td></tr>
</table>

<h2 style="{h2}">Step 1 - Install pi (skip if you already have it)</h2>
<p><b>All systems:</b> install <a href="https://nodejs.org">Node.js</a> 22.19 or newer (LTS), then run:</p>
<code style="{code}">npm install -g --ignore-scripts @earendil-works/pi-coding-agent</code>
<p><b>Mac / Linux alternative:</b></p>
<code style="{code}">curl -fsSL https://pi.dev/install.sh | sh</code>
<p><b>Windows:</b> also install <a href="https://git-scm.com/download/win">Git for Windows</a> - pi uses Git Bash to run commands. Run the npm command in PowerShell or Windows Terminal.</p>

<h2 style="{h2}">Step 2 - Install the RMM extension</h2>
<p><b>Mac / Linux</b> (Terminal):</p>
<code style="{code}">curl -fsSL {e(RELAY_PUBLIC_URL)}/client/install.sh | bash</code>
<p><b>Windows</b> (PowerShell):</p>
<code style="{code}">irm {e(RELAY_PUBLIC_URL)}/client/install.ps1 | iex</code>

<h2 style="{h2}">Step 3 - Sign in (once)</h2>
<p>Start pi (type <code>pi</code>), then type <code>/rmm-login</code> and enter your RMM username (<b>{e(login)}</b>) and the relay key above.
That signs you in to every group at once.</p>

<h2 style="{h2}">Step 4 - Use it</h2>
<table style="border-collapse:collapse;width:100%">
<tr><th style="{th}">Type in pi</th><th style="{th}">What it does</th></tr>
{use_rows}
<tr><td style="{td}"><code>/rmm-status</code></td><td style="{td}">Your groups, models and spend today / this month</td></tr>
</table>

<h2 style="{h2}">Your groups</h2>
<table style="border-collapse:collapse;width:100%">
<tr><th style="{th}">Group</th><th style="{th}">Runs the chat</th><th style="{th}">Specialists (the AI delegates to these itself)</th></tr>
{group_rows}
</table>

<h2 style="{h2};color:#b42318">Delete this email when you are signed in</h2>
<p>The relay key is a <b>password that spends company money on AI</b> and is tied to your name. Email is stored on mail servers,
synced to phones, backed up and easy to forward - anyone who gets this key and your username can use it until it is revoked.</p>
<p>After <code>/rmm-login</code> works (the key is then saved on your computer, readable only by you):</p>
<ol><li><b>Delete this email</b>, and</li><li><b>empty Deleted Items / Trash</b>.</li></ol>
<p>Never paste the key into a ticket, chat, document or screenshot. If you think it leaked, tell your RMM admin -
they can revoke it or send you a new one in seconds.</p>
<p style="color:#57606a;font-size:12px;margin-top:24px">Sent by {e(sent_by)} from the RMM.</p>
</div>"""
    return subject, text, html


def send_install_email(row, full_key: str, sent_by: str) -> dict:
    from core.models import CoreSettings

    to = install_recipient(row.user)
    if not to:
        return {"ok": False, "message": f"{row.user.username} has no email address in the RMM - add one to their user first."}
    subject, text, html = build_install_email(row, full_key, sent_by)
    try:
        msg, ok = CoreSettings.objects.first().send_mail(subject, text, override_recipients=[to], html_body=html)
    except Exception as ex:  # SMTP errors must not 500 the settings page
        msg, ok = str(ex), False
    return {"ok": bool(ok), "sent_to": to, "message": str(msg or "")}


# ---------------------------------------------------------------- client upgrade notice
def served_client_version() -> str:
    """The version of the extension the relay is actually serving. Read from the file the
    installer hands out, so the email can never claim a version we are not shipping."""
    import re

    for path in ("/opt/pi-trmm-bridge/relay-client/index.ts",
                 "/rmm/pibridge/relay-client/index.ts"):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                m = re.search(r'CLIENT_VERSION\s*=\s*"([^"]+)"', fh.read())
            if m:
                return m.group(1)
        except OSError:
            continue
    return ""


def build_client_upgrade_email(row, sent_by: str) -> tuple[str, str, str]:
    """-> (subject, text, html). An UPDATE notice, not an install email.

    Deliberately carries NO key: the recipient already has one and it is not changing, and
    the key cannot be read back from the database anyway (only its HMAC is stored). Telling
    users to re-run the installer must never look like a rotation, or they will assume their
    old key is dead and go hunting for a new one.
    """
    from html import escape as e

    u = row.user
    name = (u.get_full_name() if hasattr(u, "get_full_name") else "") or u.username
    login = install_recipient(u) or u.username
    version = served_client_version()
    shown = f" (now v{version})" if version else ""
    subject = "Action needed: update the Pi + RMM extension on your computer (2 minutes)"

    text = f"""Hi {name},

A quick update about your RMM AI access from pi.

NOTHING ABOUT YOUR ACCESS HAS CHANGED. The relay key you already have keeps working, and you
do NOT need a new one. This is only about the small extension pi loads on your computer.

WHAT AND WHY
  The extension that gives you /rmm-login, /group and /rmm-status has been updated{shown}.
  The relay itself was upgraded to let one key reach several agent groups (IT, Coding,
  Coding+) and to pick up group changes without restarting pi. An OLD extension cannot
  complete the handshake with the upgraded relay, so you may see one of these:

      the relay speaks protocol 2 but this extension speaks 1 - update it
      Relay protocol mismatch: server speaks 2, client sent 1. Update the rmm-relay extension.
      RMM relay error (401): Invalid, expired or revoked relay credentials.

  If you see nothing wrong, you can still update - it takes a minute and changes nothing else.

HOW TO UPDATE - one line

  Mac / Linux (Terminal):
      curl -fsSL {RELAY_PUBLIC_URL}/client/install.sh | bash

  Windows (PowerShell):
      irm {RELAY_PUBLIC_URL}/client/install.ps1 | iex

  Then restart pi. Your sign-in is kept, so you should not need to do anything else.
  If you do get asked, sign in with your RMM username ({login}) and the SAME relay key you
  already have:
      /rmm-login

  Check what you are running at any time with:
      /rmm-status

If the command fails, or /rmm-status still shows an old version after restarting, reply to
this email and we will sort it out.

Sent by {sent_by}.
"""

    code = "font-family:Consolas,Menlo,monospace;background:#f4f4f4;border:1px solid #d0d7de;border-radius:4px;padding:8px 10px;display:block;white-space:pre-wrap;word-break:break-all;color:#24292f"
    h2 = "color:#1a3c6e;font-size:16px;margin:22px 0 6px"
    td = "padding:6px 10px;border-bottom:1px solid #e1e4e8;color:#24292f"
    html = f"""<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#24292f;background:#ffffff;max-width:760px">
<p>Hi {e(name)},</p>
<p>A quick update about your RMM AI access from <b>pi</b>.</p>
<p style="background:#eef6ff;border-left:3px solid #1a3c6e;padding:10px 12px">
<b>Nothing about your access has changed.</b> The relay key you already have keeps working, and you
<b>do not need a new one</b>. This is only about the small extension pi loads on your computer.</p>

<h2 style="{h2}">What and why</h2>
<p>The extension that gives you <code>/rmm-login</code>, <code>/group</code> and <code>/rmm-status</code> has been updated{(' to <b>v' + e(version) + '</b>') if version else ''}.
The relay itself was upgraded so one key can reach several agent groups (<b>IT, Coding, Coding+</b>) and so
group changes reach you without restarting pi. An <b>old</b> extension cannot complete the handshake with the
upgraded relay, so you may be seeing one of these:</p>
<code style="{code}">the relay speaks protocol 2 but this extension speaks 1 - update it
Relay protocol mismatch: server speaks 2, client sent 1. Update the rmm-relay extension.
RMM relay error (401): Invalid, expired or revoked relay credentials.</code>
<p>If nothing looks wrong you can still update - it takes a minute and changes nothing else.</p>

<h2 style="{h2}">How to update - one line</h2>
<p><b>Mac / Linux</b> (Terminal):</p>
<code style="{code}">curl -fsSL {e(RELAY_PUBLIC_URL)}/client/install.sh | bash</code>
<p><b>Windows</b> (PowerShell):</p>
<code style="{code}">irm {e(RELAY_PUBLIC_URL)}/client/install.ps1 | iex</code>
<p>Then <b>restart pi</b>. Your sign-in is kept, so you should not need to do anything else — if you do get asked,
sign in with your RMM username (<b>{e(login)}</b>) and the <b>same relay key you already have</b>:</p>
<code style="{code}">/rmm-login</code>
<p>Check what you are running at any time with <code>/rmm-status</code>.</p>

<table style="border-collapse:collapse;width:100%">
<tr><td style="{td};width:190px"><b>Your RMM username</b></td><td style="{td}"><code>{e(login)}</code></td></tr>
<tr><td style="{td}"><b>Your relay key</b></td><td style="{td}">Unchanged — keep using the one you have. Never email it to us.</td></tr>
<tr><td style="{td}"><b>New client version</b></td><td style="{td}">{e(version) or 'latest'}</td></tr>
</table>

<p style="color:#57606a">If the command fails, or <code>/rmm-status</code> still shows an old version after restarting,
just reply to this email and we will sort it out.</p>
<p style="color:#57606a;font-size:12px;margin-top:24px">Sent by {e(sent_by)}.</p>
</div>"""
    return subject, text, html


def send_client_upgrade_email(row, sent_by: str) -> dict:
    """Send the update notice for one key (so one email per key holder, not per key)."""
    from core.models import CoreSettings

    to = install_recipient(row.user)
    if not to:
        return {"ok": False, "sent_to": "", "message": f"{row.user.username} has no email address in the RMM."}
    subject, text, html = build_client_upgrade_email(row, sent_by)
    try:
        msg, ok = CoreSettings.objects.first().send_mail(subject, text, override_recipients=[to], html_body=html)
    except Exception as ex:  # SMTP errors must not 500 the settings page
        msg, ok = str(ex), False
    return {"ok": bool(ok), "sent_to": to, "message": str(msg or "")}


def notify_all_relay_users(sent_by: str, *, only_user: str = "", dry_run: bool = False) -> dict:
    """Email every ACTIVE key holder the update notice. One email per person even if they hold
    several keys. Never touches key material - this is a notice, not a rotation."""
    from core.models import AIRelayKey

    qs = (AIRelayKey.objects.select_related("user")
          .filter(revoked_at__isnull=True)
          .prefetch_related("groups").order_by("user_id", "id"))
    if only_user:
        qs = qs.filter(user__username__iexact=only_user) | qs.filter(user__email__iexact=only_user)
    now = timezone.now()
    qs = qs.filter(expires_at__isnull=True) | qs.filter(expires_at__gt=now)

    seen: set[int] = set()
    out = {"sent": [], "skipped": [], "failed": [], "dry_run": dry_run,
           "client_version": served_client_version()}
    for row in qs:
        if row.user_id in seen:
            continue
        seen.add(row.user_id)
        to = install_recipient(row.user)
        if not to:
            out["skipped"].append({"user": row.user.username, "reason": "no email address"})
            continue
        if dry_run:
            out["sent"].append({"user": row.user.username, "to": to, "dry_run": True})
            continue
        res = send_client_upgrade_email(row, sent_by)
        if res["ok"]:
            type(row).objects.filter(pk=row.pk).update(
                install_sent_at=now, install_sent_to=res["sent_to"], install_sent_by=sent_by)
            out["sent"].append({"user": row.user.username, "to": res["sent_to"]})
        else:
            out["failed"].append({"user": row.user.username, "to": to, "error": res["message"][:300]})
    return out


class AIRelayKeyNotifyUpdate(APIView):
    """POST /core/ai/relay/keys/notify-update/ - email every active key holder the "update your
    pi extension" notice. Admin only. `?dry_run=1` reports who WOULD be emailed without sending.
    Keys are never changed: if you want a new secret for one key, use send-install instead."""

    permission_classes = [IsAuthenticated]

    def post(self, request):
        if not _is_admin(request):
            return Response("Edit Core Settings is required to email relay users.", status=403)
        dry = str(request.query_params.get("dry_run") or (request.data or {}).get("dry_run") or "").lower() in ("1", "true", "yes")
        only = str((request.data or {}).get("user") or "").strip()
        out = notify_all_relay_users(request.user.username, only_user=only, dry_run=dry)
        out["ok"] = not out["failed"]
        return Response(out)


class AIRelayKeySendInstall(APIView):
    """POST /core/ai/relay/keys/<pk>/send-install/ - email the user a NEW secret for this key
    plus setup instructions. The new secret is saved only if the email was accepted, so a
    mail failure never locks anyone out; on success the previous secret stops working."""

    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        from core.models import AIRelayKey

        row = AIRelayKey.objects.select_related("user").prefetch_related("groups").filter(pk=pk).first()
        if not row:
            return Response("Not found.", status=404)
        if row.user_id != request.user.id and not _is_admin(request):
            return Response("Not yours.", status=403)
        if row.revoked_at:
            return Response("This key is revoked; issue a new one.", status=400)
        full_key, new_hash = row.new_secret()
        res = send_install_email(row, full_key, request.user.username)
        if not res["ok"]:
            return Response(f"Email not sent ({res['message']}). The key was NOT changed.", status=502)
        now = timezone.now()
        type(row).objects.filter(pk=row.pk).update(
            secret_hash=new_hash, rotated_at=now, install_sent_at=now,
            install_sent_to=res["sent_to"], install_sent_by=request.user.username)
        row.refresh_from_db()
        return Response({"ok": True, "sent_to": res["sent_to"], "row": key_public(row)})


# ---------------------------------------------------------------------------- session capabilities
class AISessionCapabilities(APIView):
    """Per-session chat capability grants - the hamburger switches an admin can hand a technician
    for ONE ticket or device (see core/session_caps.py). Admin-only: this is a permission."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        from core.session_caps import CAPABILITIES, active_caps

        if not _is_admin(request):
            return Response("Edit Core Settings is required to see capability grants.", status=403)
        # ---- EVERY LIVE GRANT (the Settings panel's table) ------------------------------
        # The panel had no way to answer "what is outstanding right now?" - it could only echo
        # the one user+scope currently selected, so an admin had to already know who to look
        # at. `?list=1` answers that question directly. Expiry is filtered here for the same
        # reason active_caps filters it: nothing needs a cleanup job.
        if str(request.query_params.get("list") or "") in ("1", "true", "yes"):
            from django.db.models import Q
            from django.utils import timezone as _timezone

            from core.models import AISessionCapability as C
            from core.session_caps import role_allows

            now = _timezone.now()
            rows = (
                C.objects.filter(revoked_at__isnull=True)
                .filter(Q(expires_at__isnull=True) | Q(expires_at__gt=now))
                .select_related("user")
                .order_by("-created")[:300]
            )
            # role_allows() re-reads the role for every cap; do it once per user.
            role_cache: dict = {}
            grants = []
            for row in rows:
                if row.user_id not in role_cache:
                    role_cache[row.user_id] = {c["id"]: role_allows(row.user, c["id"]) for c in CAPABILITIES}
                grants.append({**key_public_caps(row), "role_allowed": role_cache[row.user_id]})
            return Response({"grants": grants, "catalog": CAPABILITIES})

        scope_kind = str(request.query_params.get("scope_kind") or "all").strip()
        scope_ref = str(request.query_params.get("scope_ref") or "").strip()
        username = str(request.query_params.get("username") or "").strip()
        if not username:
            # The Settings panel needs the CATALOGUE before anyone has been chosen, so an
            # empty username returns the catalogue and no grants rather than a 400.
            # (Opening Pi.dev AI used to raise "scope_kind and username are required".)
            return Response({"username": "", "scope_kind": scope_kind, "scope_ref": scope_ref,
                             "caps": [], "catalog": CAPABILITIES, "role_allowed": {}})
        from accounts.models import User

        u = User.objects.filter(username__iexact=username).first() or User.objects.filter(email__iexact=username).first()
        if not u:
            return Response(f"No RMM user '{username}'.", status=400)
        from core.session_caps import role_allows

        caps = sorted(active_caps(u, scope_kind, scope_ref))
        return Response({
            "username": u.username,
            "scope_kind": scope_kind,
            "scope_ref": scope_ref,
            "caps": caps,
            "catalog": CAPABILITIES,
            # Which of these the user's ROLE already allows. Lets the panel say "their role
            # already allows this, so granting it changes nothing" instead of leaving an admin
            # to guess why the switch is on for someone they never granted anything.
            "role_allowed": {c["id"]: role_allows(u, c["id"]) for c in CAPABILITIES},
        })

    def post(self, request):
        """Grant (or extend) capabilities for a user in a scope, then tell the bridge so a LIVE
        session picks it up without the technician reopening the window."""
        from accounts.models import User

        from core.session_caps import clean_caps, grant

        if not _is_admin(request):
            return Response("Only an admin can grant a capability.", status=403)
        d = request.data or {}
        username = str(d.get("username") or "").strip()
        scope_kind = str(d.get("scope_kind") or "").strip()
        scope_ref = str(d.get("scope_ref") or "").strip()
        caps = clean_caps(d.get("caps"))
        if not caps:
            return Response("No known capability ids given.", status=400)
        u = User.objects.filter(username__iexact=username).first() or User.objects.filter(email__iexact=username).first()
        if not u:
            return Response(f"No RMM user '{username}'.", status=400)
        if not u.is_active:
            return Response(f"{u.username} is not active.", status=400)
        try:
            minutes = int(d.get("minutes") or 0) or None
            row = grant(u, scope_kind, scope_ref, caps, by=request.user.username,
                        minutes=minutes, note=str(d.get("note") or ""))
        except ValueError as e:
            return Response(str(e), status=400)
        # "Enable it for them" - an admin can also turn the switches ON, which is what the
        # technician asked for. The bridge applies them exactly as the technician's own toggle
        # would (and records the choice), so no take-over is involved.
        enable = d.get("enable") in (True, "true", "1", 1)
        state = {}
        if enable:
            from core.session_caps import CAP_STATE

            state = {CAP_STATE[c]: True for c in caps if c in CAP_STATE}
        pushed = _push_caps_to_bridge(u.username, scope_kind, scope_ref, apply_state=state)
        return Response({"ok": True, "row": key_public_caps(row), "bridge_notified": pushed,
                         "enabled": sorted(state)})

    def delete(self, request):
        from accounts.models import User

        from core.session_caps import revoke

        if not _is_admin(request):
            return Response("Only an admin can revoke a capability.", status=403)
        d = request.data or {}
        username = str(d.get("username") or "").strip()
        scope_kind = str(d.get("scope_kind") or "").strip()
        scope_ref = str(d.get("scope_ref") or "").strip()
        u = User.objects.filter(username__iexact=username).first() or User.objects.filter(email__iexact=username).first()
        if not u:
            return Response(f"No RMM user '{username}'.", status=400)
        n = revoke(u, scope_kind, scope_ref, by=request.user.username, caps=d.get("caps"))
        pushed = _push_caps_to_bridge(u.username, scope_kind, scope_ref)
        return Response({"ok": True, "removed": n, "bridge_notified": pushed})


def key_public_caps(row) -> dict:
    return {
        "id": row.pk,
        "username": row.user.username,
        "scope_kind": row.scope_kind,
        "scope_ref": row.scope_ref,
        "caps": row.caps or [],
        "note": row.note,
        "granted_by": row.granted_by,
        "created": row.created.isoformat() if row.created else None,
        "expires_at": row.expires_at.isoformat() if row.expires_at else None,
        "active": row.active,
    }


def _push_caps_to_bridge(username: str, scope_kind: str, scope_ref: str, apply_state: dict | None = None) -> bool:
    """Tell the bridge to re-read this user's capabilities for a live session (best effort: the
    grant also applies on the next window open, so a bridge hiccup changes nothing permanent)."""
    import requests as _requests
    from accounts.models import User
    from django.conf import settings as _settings

    from core.session_caps import resolve_perms

    u = User.objects.filter(username__iexact=username).first()
    if not u:
        return False
    r = resolve_perms(u, scope_kind, scope_ref)
    bridge = getattr(_settings, "PI_BRIDGE_URL", "http://127.0.0.1:8787")
    try:
        resp = _requests.post(f"{bridge}/pi/grants", json={
            "username": u.username,
            "scope_kind": scope_kind,
            "scope_ref": scope_ref,
            "perms": r["perms"],
            "caps_granted": r["granted"],
            "apply_state": apply_state or {},
        }, timeout=5)
        return bool(resp.ok)
    except Exception:
        return False
