"""
Remote Web Proxy / Tunnel feature.

Lets an authenticated TRMM user reach the HTTP/HTTPS admin UI of a device on an
agent's LAN (e.g. a firewall at https://192.168.200.254:8443) without any local
client, extra ports, or manual port-forwarding.

Mechanism (validated end-to-end):
  * A short-lived "proxy session" is created server-side and stored in redis,
    binding a random token -> {agent, target addr, target port, protocol, user}.
  * The browser loads an iframe pointed at  /agentproxy/<token>/<path...>  which
    nginx routes to the ASGI (uvicorn) server.
  * For every request we open a raw TCP tunnel to the target through MeshCentral's
    relay  (ws://127.0.0.1:4430/meshrelay.ashx?nodeid&tcpaddr&tcpport&auth),
    optionally wrap it in TLS (MemoryBIO) for https targets, speak HTTP/1.1 with
    h11, then rewrite the response so it renders inside the iframe (strip
    X-Frame-Options/CSP, fix redirects + root-relative URLs).
"""

import asyncio
import re
import secrets
import ssl
import urllib.parse
from typing import Any, Optional

import h11
import websockets
from asgiref.sync import sync_to_async
from django.core.cache import cache
from django.http import HttpResponse, JsonResponse

from tacticalrmm.logger import logger

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
MESH_PORT = 4430
RELAY_HOST = "127.0.0.1"
SESSION_PREFIX = "webproxy:"
SESSION_TTL = 60 * 60 * 4  # 4 hours
HANDSHAKE_TIMEOUT = 25
IO_TIMEOUT = 60
MAX_BODY = 64 * 1024 * 1024  # 64MB hard cap per response

# Hop-by-hop headers that must never be forwarded
HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}


# ---------------------------------------------------------------------------
# Session store (redis via django cache)
# ---------------------------------------------------------------------------
def create_session(
    *, agent_id: str, hex_node_id: str, protocol: str, addr: str, port: int,
    username: str, hostname: str,
) -> str:
    token = secrets.token_urlsafe(32)
    cache.set(
        f"{SESSION_PREFIX}{token}",
        {
            "agent_id": agent_id,
            "hex_node_id": hex_node_id,
            "protocol": protocol,  # "http" | "https"
            "addr": addr,
            "port": int(port),
            "username": username,
            "hostname": hostname,
        },
        SESSION_TTL,
    )
    return token


def get_session(token: str) -> Optional[dict[str, Any]]:
    return cache.get(f"{SESSION_PREFIX}{token}")


# ---------------------------------------------------------------------------
# Tunnel stream (raw TCP over MeshCentral relay, with optional TLS)
# ---------------------------------------------------------------------------
class TunnelStream:
    """Async byte stream to <addr>:<port> reached *through the agent*."""

    def __init__(self, ws, use_tls: bool, server_hostname: str):
        self.ws = ws
        self.use_tls = use_tls
        self._tls = None
        self._inbio = None
        self._outbio = None
        if use_tls:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE  # device certs are self-signed
            self._inbio, self._outbio = ssl.MemoryBIO(), ssl.MemoryBIO()
            self._tls = ctx.wrap_bio(
                self._inbio, self._outbio, server_hostname=server_hostname or "device"
            )

    @classmethod
    async def open(cls, *, hex_node_id: str, addr: str, port: int, use_tls: bool,
                   auth_token: str) -> "TunnelStream":
        nodeid = f"node//{hex_node_id}"
        q = urllib.parse.urlencode(
            {"auth": auth_token, "nodeid": nodeid, "tcpport": str(port), "tcpaddr": addr}
        )
        uri = f"ws://{RELAY_HOST}:{MESH_PORT}/meshrelay.ashx?{q}"
        ws = await websockets.connect(uri, max_size=None, open_timeout=HANDSHAKE_TIMEOUT)

        # wait for the 'c'/'cr' connect handshake from the relay
        while True:
            msg = await asyncio.wait_for(ws.recv(), HANDSHAKE_TIMEOUT)
            if isinstance(msg, bytes):
                # unexpected pre-connect binary, ignore
                continue
            if msg in ("c", "cr"):
                break
        self = cls(ws, use_tls, addr)
        if use_tls:
            await self._do_handshake()
        return self

    async def _flush_out(self):
        data = self._outbio.read()
        if data:
            await self.ws.send(data)

    async def _do_handshake(self):
        while True:
            try:
                self._tls.do_handshake()
                break
            except ssl.SSLWantReadError:
                await self._flush_out()
                d = await asyncio.wait_for(self.ws.recv(), HANDSHAKE_TIMEOUT)
                if isinstance(d, bytes):
                    self._inbio.write(d)
        await self._flush_out()

    async def write(self, data: bytes):
        if not self.use_tls:
            await self.ws.send(data)
            return
        self._tls.write(data)
        await self._flush_out()

    async def read(self) -> bytes:
        """Return next chunk of plaintext, or b'' on EOF."""
        if not self.use_tls:
            try:
                d = await asyncio.wait_for(self.ws.recv(), IO_TIMEOUT)
            except websockets.ConnectionClosed:
                return b""
            if isinstance(d, str):
                return await self.read()  # skip late control frames
            return d
        while True:
            try:
                out = self._tls.read(65536)
                return out  # may be b'' at clean EOF
            except ssl.SSLWantReadError:
                await self._flush_out()
                try:
                    d = await asyncio.wait_for(self.ws.recv(), IO_TIMEOUT)
                except (websockets.ConnectionClosed, asyncio.TimeoutError):
                    return b""
                if isinstance(d, bytes):
                    self._inbio.write(d)
            except (ssl.SSLEOFError, ssl.SSLError):
                return b""

    async def close(self):
        try:
            await self.ws.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# HTTP/1.1 round-trip over the tunnel using h11
# ---------------------------------------------------------------------------
async def http_request_via_tunnel(
    *, stream: TunnelStream, method: str, target: str, headers: list[tuple[str, str]],
    body: bytes,
) -> tuple[int, str, list[tuple[bytes, bytes]], bytes]:
    conn = h11.Connection(our_role=h11.CLIENT)

    to_send = conn.send(h11.Request(method=method, target=target, headers=headers))
    if body:
        to_send += conn.send(h11.Data(data=body))
    to_send += conn.send(h11.EndOfMessage())
    await stream.write(to_send)

    status = 502
    reason = "Bad Gateway"
    resp_headers: list[tuple[bytes, bytes]] = []
    chunks: list[bytes] = []
    total = 0
    got_response = False

    while True:
        event = conn.next_event()
        if event is h11.NEED_DATA:
            data = await stream.read()
            conn.receive_data(data)
            if data == b"":
                # peer closed; let h11 surface remaining events / end
                if conn.their_state in (h11.CLOSED, h11.DONE):
                    break
            continue
        if isinstance(event, h11.Response):
            got_response = True
            status = event.status_code
            reason = (event.reason or b"").decode("latin-1") if isinstance(event.reason, bytes) else str(event.reason or "")
            resp_headers = list(event.headers)
        elif isinstance(event, h11.Data):
            chunks.append(bytes(event.data))
            total += len(event.data)
            if total > MAX_BODY:
                break
        elif isinstance(event, (h11.EndOfMessage, h11.PAUSED)):
            break
        elif event is h11.ConnectionClosed or isinstance(event, h11.ConnectionClosed):
            break

    if not got_response:
        raise RuntimeError("no HTTP response from target")
    return status, reason, resp_headers, b"".join(chunks)


# ---------------------------------------------------------------------------
# Response rewriting so the page renders inside the TRMM iframe
# ---------------------------------------------------------------------------
def _prefix(token: str) -> str:
    return f"/agentproxy/{token}/"


def rewrite_location(value: str, sess: dict, token: str) -> str:
    base = _prefix(token)
    # absolute URL pointing back at the device -> route through proxy
    for scheme in ("http://", "https://"):
        host = f"{scheme}{sess['addr']}"
        if value.startswith(host):
            rest = value[len(host):]
            # strip optional :port
            if rest.startswith(f":{sess['port']}"):
                rest = rest[len(f":{sess['port']}"):]
            if rest.startswith("/"):
                rest = rest[1:]
            return base + rest
    # root-relative
    if value.startswith("/"):
        return base + value[1:]
    return value


_ROOT_REL_RE = re.compile(
    rb'''(\b(?:href|src|action|formaction|data-url|background)\s*=\s*["'])/(?!/)''',
    re.IGNORECASE,
)
_CSS_URL_RE = re.compile(rb'''(url\(\s*["']?)/(?!/)''', re.IGNORECASE)


def _client_shim(token: str) -> bytes:
    """JS injected into HTML pages that patches XHR/fetch/WebSocket so URLs the
    app builds dynamically in JavaScript (e.g. Proxmox/ExtJS calling
    /api2/json/access/domains) are routed back through the proxy prefix."""
    import json as _json

    p = _prefix(token).rstrip("/")  # /agentproxy/<token>
    pj = _json.dumps(p)
    js = (
        "(function(){var P=" + pj + ";"
        "function fix(u){try{if(typeof u!=='string')return u;"
        "if(u.slice(0,P.length+1)===P+'/')return u;"  # already prefixed
        "if(u.charAt(0)==='/'&&u.charAt(1)!=='/')return P+u;"  # root-relative
        "return u;}catch(e){return u;}}"
        "var O=XMLHttpRequest.prototype.open;"
        "XMLHttpRequest.prototype.open=function(){"
        "if(arguments.length>1){arguments[1]=fix(arguments[1]);}"
        "return O.apply(this,arguments);};"
        "if(window.fetch){var F=window.fetch;window.fetch=function(i,n){"
        "try{if(typeof i==='string'){i=fix(i);}}catch(e){}return F.call(this,i,n);};}"
        "if(window.WebSocket){var W=window.WebSocket;var NW=function(u,pr){"
        "try{u=fix(u);}catch(e){}return pr?new W(u,pr):new W(u);};"
        "NW.prototype=W.prototype;NW.CONNECTING=W.CONNECTING;NW.OPEN=W.OPEN;"
        "NW.CLOSING=W.CLOSING;NW.CLOSED=W.CLOSED;window.WebSocket=NW;}"
        "})();"
    )
    return b"<script>" + js.encode() + b"</script>"


def rewrite_body(body: bytes, content_type: str, token: str) -> bytes:
    ct = (content_type or "").lower()
    prefix = _prefix(token).encode()

    if "text/html" in ct:
        # static root-relative attribute URLs: ="/x" -> "/agentproxy/<token>/x"
        body = _ROOT_REL_RE.sub(rb"\1" + prefix[:-1] + b"/", body)
        # inject runtime shim (first, so it patches before app code runs) + <base>
        m = re.search(rb"<head[^>]*>", body, re.IGNORECASE)
        inject = _client_shim(token) + b'<base href="' + prefix + b'">'
        if m:
            body = body[: m.end()] + inject + body[m.end():]
        else:
            body = inject + body
        return body

    if "text/css" in ct:
        return _CSS_URL_RE.sub(rb"\1" + prefix[:-1] + b"/", body)

    # leave JS/JSON/XML/binary untouched - the runtime shim handles dynamic URLs
    return body


# ---------------------------------------------------------------------------
# Main ASGI proxy view  (served by uvicorn via nginx /agentproxy/ -> daphne.sock)
# ---------------------------------------------------------------------------
async def agent_web_proxy(request, token: str, path: str = ""):
    sess = await sync_to_async(get_session)(token)
    if not sess:
        r = HttpResponse("Proxy session expired or invalid.", status=410)
        r.xframe_options_exempt = True
        return r

    from core.utils import get_core_settings
    from meshctrl.utils import get_auth_token

    core = await sync_to_async(get_core_settings)()
    auth_token = get_auth_token(core.mesh_api_superuser, core.mesh_token)

    use_tls = sess["protocol"] == "https"

    # Build upstream target (path + query)
    target = "/" + path
    qs = request.META.get("QUERY_STRING", "")
    if qs:
        target += "?" + qs

    # Build upstream headers
    host_hdr = sess["addr"]
    if (use_tls and sess["port"] != 443) or (not use_tls and sess["port"] != 80):
        host_hdr = f"{sess['addr']}:{sess['port']}"

    up_headers: list[tuple[str, str]] = [("host", host_hdr)]
    for key, val in request.headers.items():
        lk = key.lower()
        if lk in HOP_BY_HOP or lk in ("host", "accept-encoding"):
            continue
        if lk == "referer" or lk == "origin":
            continue  # avoid leaking the proxy origin to the device
        up_headers.append((lk, val))
    up_headers.append(("accept-encoding", "identity"))  # no compression -> easy rewrite
    up_headers.append(("connection", "close"))

    body = request.body or b""

    stream = None
    try:
        stream = await TunnelStream.open(
            hex_node_id=sess["hex_node_id"], addr=sess["addr"], port=sess["port"],
            use_tls=use_tls, auth_token=auth_token,
        )
        status, reason, resp_headers, resp_body = await http_request_via_tunnel(
            stream=stream, method=request.method, target=target,
            headers=up_headers, body=body,
        )
    except Exception as e:
        logger.error(f"web proxy error {sess.get('addr')}:{sess.get('port')} - {e}")
        r = HttpResponse(f"Proxy error: {e}", status=502)
        r.xframe_options_exempt = True
        return r
    finally:
        if stream:
            await stream.close()

    # Find content type
    content_type = "application/octet-stream"
    out_headers: dict[str, str] = {}
    set_cookies: list[str] = []
    for hk, hv in resp_headers:
        k = hk.decode("latin-1").lower()
        v = hv.decode("latin-1")
        if k in HOP_BY_HOP or k == "content-length":
            continue
        if k in ("x-frame-options",):
            continue  # allow iframing
        if k == "content-security-policy":
            # drop frame-ancestors restrictions
            continue
        if k == "content-type":
            content_type = v
            out_headers["Content-Type"] = v
            continue
        if k == "location":
            v = rewrite_location(v, sess, token)
            out_headers["Location"] = v
            continue
        if k == "set-cookie":
            # strip Domain (scope to our origin) and Secure-only issues
            set_cookies.append(re.sub(r";\s*[Dd]omain=[^;]+", "", v))
            continue
        out_headers[hk.decode("latin-1")] = v

    resp_body = rewrite_body(resp_body, content_type, token)

    resp = HttpResponse(resp_body, status=status, content_type=content_type)
    for hk, hv in out_headers.items():
        if hk.lower() == "content-type":
            continue
        resp[hk] = hv
    # pass through device cookies (scoped to our origin)
    if set_cookies:
        from http.cookies import SimpleCookie
        jar = SimpleCookie()
        for c in set_cookies:
            try:
                jar.load(c)
            except Exception:
                pass
        for morsel in jar.values():
            resp.cookies[morsel.key] = morsel.value
            for attr in ("path", "expires", "max-age", "secure", "httponly", "samesite"):
                if morsel[attr]:
                    resp.cookies[morsel.key][attr] = morsel[attr]
    resp["X-Robots-Tag"] = "noindex"
    resp.xframe_options_exempt = True
    return resp


# This view only forwards requests to the proxied device, which performs its own
# CSRF protection. Exempt it from Django's CsrfViewMiddleware so POSTs (e.g. the
# pfSense login form) aren't rejected with a Django 403 before reaching the device.
agent_web_proxy.csrf_exempt = True
