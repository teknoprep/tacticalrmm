"""BlueCloud Quick Support (TICKET/63164) - tech entry point + live queue.

The public page erp.blueuc.com/support hands end users a MeshCentral Assistant bound to the
MeshCentral device group "BlueCloud Quick Support". The Assistant only connects when the user clicks
"Request Help" and types a message (name + ticket number), so "online in that group" == "someone is
asking for help right now". Techs see and take those sessions from rmm.blueuc.com/quick-support,
never from mesh.blueuc.com.

Who may use it (unchanged): logged in to Tactical RMM (password + TOTP) AND the caller's synced
MeshCentral account (user//<name>___<id>) is a member of the MeshCentral user group "Support Techs".
Manage that group in MeshCentral or with /home/tactical/qs-mesh-setup.py.

Endpoints (all under /core/):
  GET  quick-support/                          legacy: login URL that opens the group in MeshCentral
  GET  quick-support/sessions/                 the queue (polled by the RMM every few seconds)
  POST quick-support/sessions/<id>/connect/    {mode: desktop|terminal|files} -> embed URL; CLAIMS it
  POST quick-support/sessions/<id>/release/    drop your claim
  POST quick-support/teams-test/               {url?} send a test card (Global Settings perms)

Claiming: opening a device (connect) records "<tech> is helping" for that device. MeshCentral's own
live session list (who has desktop/terminal/files open) is shown too. A claim ends when the tech
releases it or the customer closes the Assistant (device goes offline).

Teams: core.tasks.quick_support_teams_notify runs every 15s from celery beat. When enabled in
Global Settings > Quick Support it posts one Adaptive Card per new help request to the configured
Power Automate webhook, with a link straight to the queue and to Take Control.

Every grant, denial and connect is written to the TRMM audit log.
"""

import asyncio
import hashlib
import json
import time
from urllib.parse import quote

import requests
import websockets
from django.conf import settings
from django.core.cache import cache
from meshctrl.utils import get_login_token
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from core.permissions import CoreSettingsPerms
from core.utils import get_core_settings, get_mesh_ws_url
from logs.models import AuditLog
from tacticalrmm.constants import TRMM_WS_MAX_SIZE, AuditActionType, AuditObjType
from tacticalrmm.logger import logger

QS_GROUP_NAME = "BlueCloud Quick Support"
QS_UGRP_NAME = "Support Techs"

MESH_TIMEOUT = 10  # seconds; never let a slow MeshCentral hang an API worker
GROUP_TTL = 60  # group id + Support Techs membership
NODES_TTL = 3  # the device list; shared by every tech polling the page
CLAIM_TTL = 8 * 3600
SEEN_TTL = 24 * 3600
TEAMS_SENT_TTL = 12 * 3600

VIEWMODES = {"desktop": 11, "terminal": 12, "files": 13}


class QSError(Exception):
    def __init__(self, detail, status):
        super().__init__(detail)
        self.detail = detail
        self.status = status


# ---------------------------------------------------------------- MeshCentral ---------------
def _mesh(payloads):
    """Send several control.ashx actions over ONE websocket; return the replies in order."""

    async def _do():
        async with websockets.connect(get_mesh_ws_url(), max_size=TRMM_WS_MAX_SIZE) as ws:
            out = []
            for p in payloads:
                await ws.send(json.dumps(p))
                while True:
                    r = json.loads(await ws.recv())
                    if r.get("action") == p["action"]:
                        out.append(r)
                        break
            return out

    async def _bounded():
        return await asyncio.wait_for(_do(), MESH_TIMEOUT)

    try:
        return asyncio.run(_bounded())
    except Exception as e:
        logger.warning(f"quick-support: MeshCentral query failed: {e!r}")
        raise QSError("MeshCentral is not responding. Try again in a minute.", 503)


def _group_and_techs():
    """-> ({"id": mesh//..., "key": ...}, {lowercased mesh user ids in Support Techs}). Cached."""
    hit = cache.get("qs:group")
    if hit:
        return hit
    meshes, ugroups = _mesh([{"action": "meshes"}, {"action": "usergroups"}])
    group = next(
        (m for m in meshes.get("meshes") or [] if m.get("name") == QS_GROUP_NAME and not m.get("deleted")),
        None,
    )
    ugrp = next(
        (g for g in (ugroups.get("ugroups") or {}).values() if g.get("name") == QS_UGRP_NAME),
        None,
    )
    if group is None or ugrp is None:
        raise QSError("Quick Support is not set up in MeshCentral (group or Support Techs missing).", 503)
    techs = {k.lower() for k in (ugrp.get("links") or {}) if k.startswith("user/")}
    val = ({"id": group["_id"], "key": group["_id"].split("/")[-1]}, techs)
    cache.set("qs:group", val, GROUP_TTL)
    return val


def _nodes(group_id):
    hit = cache.get("qs:nodes")
    if hit is not None:
        return hit
    (r,) = _mesh([{"action": "nodes", "meshid": group_id}])
    nodes = (r.get("nodes") or {}).get(group_id, [])
    cache.set("qs:nodes", nodes, NODES_TTL)
    return nodes


# ---------------------------------------------------------------- access --------------------
def _audit(request, message, granted, **extra):
    try:
        AuditLog.objects.create(
            username=request.user.username,
            object_type=AuditObjType.CORE,
            action=AuditActionType.REMOTE_SESSION if granted else AuditActionType.VIEW,
            message=message,
            debug_info={"ip": getattr(request, "_client_ip", None), "quick_support": True, "granted": granted, **extra},
        )
    except Exception:
        logger.exception("quick-support: audit write failed")


def _require_tech(request, audit_denial=True):
    """-> (core, group). Raises QSError(403/503)."""
    user = request.user
    if getattr(user, "agent", None) is not None or getattr(user, "is_installer_user", False) or getattr(
        user, "block_dashboard_login", False
    ):
        raise QSError("This account cannot open Quick Support.", 403)
    core = get_core_settings()
    if not core.sync_mesh_with_trmm:
        raise QSError("MeshCentral user sync is off, so Quick Support cannot identify you.", 503)
    group, techs = _group_and_techs()
    if user.mesh_user_id.lower() not in techs:
        if audit_denial:
            _audit(request, f"{user.username} was DENIED Quick Support (not in MeshCentral '{QS_UGRP_NAME}').", False)
        raise QSError(
            f"Your account is not authorised for Quick Support. Ask an administrator to add you to '{QS_UGRP_NAME}'.",
            403,
        )
    return core, group


# ---------------------------------------------------------------- queue entries -------------
def _mesh_user_label(uid):
    """user//chris___3 -> the TRMM username (by pk), falling back to the mesh name."""
    from accounts.models import User

    name = uid.split("/")[-1]
    base, _, pk = name.rpartition("___")
    if pk.isdigit():
        u = User.objects.filter(pk=int(pk)).only("username").first()
        if u:
            return u.username
    return base or name


def _entry(n):
    nid = n["_id"]
    key = nid.split("/")[-1]
    online = bool((n.get("conn") or 0) & 1)
    sess = n.get("sessions") or {}
    help_map = sess.get("help") or {}
    help_user, help_text = (next(iter(help_map.items())) if help_map else (None, None))

    connected = []
    for kind in ("kvm", "terminal", "files"):
        for uid in sess.get(kind) or {}:
            label = _mesh_user_label(uid)
            if label not in connected:
                connected.append(label)

    claim = cache.get(f"qs:claim:{key}")
    if not online:
        if claim:
            cache.delete(f"qs:claim:{key}")
        claim = None

    since = None
    if help_text:
        seen_key = "qs:seen:" + hashlib.sha1(f"{nid}|{help_text}".encode()).hexdigest()
        since = cache.get(seen_key)
        if since is None:
            since = time.time()
            cache.set(seen_key, since, SEEN_TTL)
    elif n.get("agct"):
        since = n["agct"] / 1000

    if not online:
        status = "left"
    elif connected or claim:
        status = "helping"
    elif help_text:
        status = "waiting"
    else:
        status = "idle"  # Assistant open but the help request was cancelled

    return {
        "id": key,
        "name": n.get("name") or n.get("host") or key,
        "os": n.get("osdesc") or "",
        "ip": n.get("ip") or "",
        "users": n.get("users") or [],
        "help_user": help_user,
        "help_text": help_text,
        "online": online,
        "status": status,
        "since": since,
        "claimed_by": claim["user"] if claim else None,
        "claimed_at": claim["at"] if claim else None,
        "connected": connected,
    }


_ORDER = {"waiting": 0, "helping": 1, "idle": 2, "left": 3}


def queue_entries(group):
    entries = [_entry(n) for n in _nodes(group["id"])]
    entries.sort(key=lambda e: (_ORDER[e["status"]], e["since"] or 0))
    return entries


def _frontend_url():
    try:
        return settings.CORS_ORIGIN_WHITELIST[0].rstrip("/")
    except Exception:
        return "https://rmm.blueuc.com"


# ---------------------------------------------------------------- views ---------------------
class QuickSupportEntry(APIView):
    """Legacy: open the whole group in MeshCentral (kept as a fallback link)."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        try:
            core, group = _require_tech(request)
        except QSError as e:
            return Response({"detail": e.detail}, status=e.status)
        token = get_login_token(key=core.mesh_token, user=request.user.mesh_user_id)
        url = f"{core.mesh_site}/?login={token}&gotomesh={quote(group['key'], safe='')}&viewmode=1"
        _audit(request, f"{request.user.username} opened Quick Support in MeshCentral (group '{QS_GROUP_NAME}').", True)
        return Response({"url": url, "group": QS_GROUP_NAME})


class QuickSupportSessions(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        try:
            _, group = _require_tech(request, audit_denial=False)  # polled; don't flood the audit log
            entries = queue_entries(group)
        except QSError as e:
            return Response({"detail": e.detail}, status=e.status)
        return Response(
            {
                "entries": entries,
                "waiting": sum(1 for e in entries if e["status"] == "waiting"),
                "me": request.user.username,
                "now": time.time(),
            }
        )


def _find(group, key):
    for n in _nodes(group["id"]):
        if n["_id"].split("/")[-1] == key:
            return n
    cache.delete("qs:nodes")  # maybe it just connected; look once more, uncached
    for n in _nodes(group["id"]):
        if n["_id"].split("/")[-1] == key:
            return n
    return None


class QuickSupportConnect(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, node):
        mode = request.data.get("mode", "desktop")
        if mode not in VIEWMODES:
            return Response({"detail": "mode must be desktop, terminal or files"}, status=400)
        try:
            core, group = _require_tech(request)
            n = _find(group, node)  # ONLY devices in the Quick Support group can be opened here
        except QSError as e:
            return Response({"detail": e.detail}, status=e.status)
        if n is None:
            return Response({"detail": "That Quick Support session is no longer there."}, status=404)

        e = _entry(n)
        me = request.user.username
        previous = e["claimed_by"]
        cache.set(f"qs:claim:{node}", {"user": me, "at": time.time()}, CLAIM_TTL)
        cache.delete("qs:nodes")

        token = get_login_token(key=core.mesh_token, user=request.user.mesh_user_id)
        url = f"{core.mesh_site}/?login={token}&gotonode={quote(node, safe='')}&viewmode={VIEWMODES[mode]}&hide=31"
        what = f"'{e['help_text']}'" if e["help_text"] else "(no request text)"
        _audit(
            request,
            f"{me} opened Quick Support {mode} on {e['name']} {what}"
            + (f" (taking over from {previous})" if previous and previous != me else ""),
            True,
            node=node,
            mode=mode,
        )
        return Response({"url": url, "entry": {**e, "claimed_by": me}, "previous_claim": previous})


class QuickSupportRelease(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, node):
        try:
            _require_tech(request)
        except QSError as e:
            return Response({"detail": e.detail}, status=e.status)
        claim = cache.get(f"qs:claim:{node}")
        if claim:
            cache.delete(f"qs:claim:{node}")
            cache.delete("qs:nodes")
            _audit(request, f"{request.user.username} released Quick Support device {node} (was {claim['user']}).", True, node=node)
        return Response({"ok": True})


# ---------------------------------------------------------------- Teams ---------------------
def _card(e, test=False):
    base = _frontend_url()
    dev = quote(e["id"], safe="")
    who = e.get("help_user") or ", ".join(e.get("users") or []) or "unknown"
    facts = [
        {"title": "Customer says", "value": e.get("help_text") or "-"},
        {"title": "Computer", "value": e.get("name") or "-"},
        {"title": "Windows user", "value": who},
    ]
    if e.get("ip"):
        facts.append({"title": "Public IP", "value": e["ip"]})
    if e.get("os"):
        facts.append({"title": "OS", "value": e["os"]})
    title = "TEST - Quick Support notifications are working" if test else "Someone is waiting for Quick Support"
    actions = [{"type": "Action.OpenUrl", "title": "Open Quick Support queue", "url": f"{base}/quick-support?device={dev}"}]
    if not test:
        actions.insert(
            0,
            {"type": "Action.OpenUrl", "title": "Take Control", "url": f"{base}/quick-support/session/{dev}?mode=desktop"},
        )
    card = {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.4",
        "body": [
            {"type": "TextBlock", "size": "Medium", "weight": "Bolder", "text": title, "wrap": True},
            {"type": "FactSet", "facts": facts},
        ],
        "actions": actions,
    }
    return {
        "type": "message",
        "attachments": [{"contentType": "application/vnd.microsoft.card.adaptive", "contentUrl": None, "content": card}],
    }


def _post_teams(url, payload):
    r = requests.post(url, json=payload, timeout=10)
    if not 200 <= r.status_code < 300:
        raise RuntimeError(f"Teams webhook returned HTTP {r.status_code}: {r.text[:200]}")


def run_teams_notify():
    """Celery beat (15s): one Teams card per NEW help request."""
    core = get_core_settings()
    url = (getattr(core, "quick_support_teams_webhook", "") or "").strip()
    if not getattr(core, "quick_support_teams_enabled", False) or not url:
        return
    if not cache.add("qs:teams:lock", 1, 60):
        return
    try:
        group, _ = _group_and_techs()
        for e in queue_entries(group):
            if e["status"] != "waiting" or not e["help_text"]:
                continue
            sent_key = "qs:teams:sent:" + hashlib.sha1(f"{e['id']}|{e['help_text']}".encode()).hexdigest()
            if not cache.add(sent_key, 1, TEAMS_SENT_TTL):
                continue
            try:
                _post_teams(url, _card(e))
                logger.info(f"quick-support: Teams notified for {e['name']}")
            except Exception as ex:
                cache.delete(sent_key)  # retry on the next run
                logger.warning(f"quick-support: Teams notify failed: {ex!r}")
    except QSError:
        pass
    finally:
        cache.delete("qs:teams:lock")


class QuickSupportTeamsTest(APIView):
    permission_classes = [IsAuthenticated, CoreSettingsPerms]

    def post(self, request):
        url = (request.data.get("url") or getattr(get_core_settings(), "quick_support_teams_webhook", "") or "").strip()
        if not url.startswith("https://"):
            return Response({"detail": "Enter the https:// webhook URL first."}, status=400)
        sample = {
            "id": "test",
            "name": "EXAMPLE-PC",
            "help_user": "jdoe",
            "help_text": f"Test message sent by {request.user.username} from Global Settings",
            "ip": "",
            "os": "Windows 11",
        }
        try:
            _post_teams(url, _card(sample, test=True))
        except Exception as e:
            return Response({"detail": str(e)}, status=400)
        return Response({"ok": True})
