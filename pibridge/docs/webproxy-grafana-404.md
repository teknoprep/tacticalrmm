# Network Devices → Grafana shows Grafana's own "Page not found"

Reported 2026-08-19. `https://grafana.farmerboyag.com` via Network Devices renders Grafana's
chrome (Home / Search ctrl+k / Sign in) with **Page not found**. Every other device works.

**Nothing has been changed.** This is diagnosis plus a proposed patch, for your decision.

## It is not the tunnel — the tunnel is working perfectly

The page you are seeing is Grafana's *own* 404, rendered by Grafana's JavaScript after its
app shell loaded successfully. So the relay reached the device, the HTML came back, and
every asset (JS, CSS, fonts) loaded through the proxy. If any of that had failed you would
have a blank frame or a gateway error, not Grafana's nav bar.

What fails is the last step: Grafana's **client-side router** does not recognise the URL in
the address bar.

## Why

`web_proxy.py` serves the device under a per-session path and strips it again upstream:

```python
# urls:      /agentproxy/<token>/<path...>
target = "/" + path          # line 713 - the prefix is REMOVED before forwarding
```

So the sequence is:

1. Browser asks for `/agentproxy/<token>/`
2. Grafana receives **`/`** and returns its normal index.html — correctly
3. `rewrite_body()` rewrites root-relative *attribute* URLs, so `<base href="/">` becomes
   `<base href="/agentproxy/<token>/">` and all assets resolve. Grafana boots.
4. Grafana's index.html carries its bootstrap config:
   ```js
   window.grafanaBootData = { settings: { ..., "appSubUrl": "", ... } }
   ```
   `appSubUrl` is **`""`**, because as far as Grafana knows it is served at the root — and
   it is right, that is exactly what it received.
5. Grafana's router now takes `window.location.pathname` = `/agentproxy/<token>/`, strips
   `appSubUrl` (nothing), and tries to match `/agentproxy/<token>/` against its routes.
   No match → **Page not found**.

`rewrite_body()` deliberately leaves JS and JSON untouched ("*leave JS/JSON/XML/binary
untouched - the runtime shim handles dynamic URLs*"), and the injected shim patches
XHR / fetch / WebSocket / document.write / window.open — but nothing that affects how an
SPA interprets its own path. That is correct for everything proxied so far.

## Why every other service is fine

The devices this was built and tuned against — Proxmox/ExtJS, Supermicro/ATEN BMCs, Ricoh,
Toshiba TopAccess, firewalls — are server-rendered UIs or use relative/hash URLs. None of
them route on an absolute base path. **Grafana is the first modern history-API SPA to go
through this proxy**, so it is the first thing the prefix can confuse. This is a new class
of target, not a regression.

## Why the obvious fixes do not apply

* **Set Grafana's `root_url` / `serve_from_sub_path`.** This is exactly the mechanism the
  problem calls for, but it needs a *fixed* path, and our prefix contains a random token
  that changes every session (`SESSION_TTL = 4h`). It would also break direct access at
  `https://grafana.farmerboyag.com` for everyone not coming through the proxy.
* **Stop stripping the prefix upstream.** Grafana would then 404 server-side, and every
  other device would break. Not an option.

## Proposed fix — tell Grafana its sub-path at runtime

One guarded injection in `rewrite_body()`. It does at the proxy what `serve_from_sub_path`
does in config, which is the supported way to run Grafana under a prefix:

```python
# --- Grafana (and anything else that routes on an absolute base) -------------
# A history-API SPA decides its routes from a base path it is told at boot. Grafana is
# served "/" upstream (the token prefix is stripped at line 713), so it boots with
# appSubUrl="" while the address bar says /agentproxy/<token>/ - its router matches
# nothing and renders its own "Page not found". Telling it the prefix is precisely what
# Grafana's own serve_from_sub_path does; we do it here because the prefix contains a
# per-session token, so it cannot be baked into the device's config.
#
# GUARDED on the literal bootdata symbol: a device that is not Grafana cannot contain
# this string, so every currently-working target takes a byte-identical path.
if b"window.grafanaBootData" in body:
    m_boot = re.search(rb"window\.grafanaBootData\s*=", body)
    if m_boot:
        end = body.find(b"</script>", m_boot.end())
        if end != -1:
            patch = (
                b"<script>try{if(window.grafanaBootData&&window.grafanaBootData.settings)"
                b"{window.grafanaBootData.settings.appSubUrl=\""
                + prefix[:-1] + b"\";}}catch(e){}</script>"
            )
            body = body[: end + 9] + patch + body[end + 9 :]
```

Placed at the end of the `if "text/html" in ct and inject_shim:` block, just before
`return body`.

Why it is safe for the working devices:

* it runs only when the response body literally contains `window.grafanaBootData`;
* it appends a `<script>` **after** Grafana's own bootdata block and changes one field —
  no existing bytes are rewritten;
* no double-prefixing: the shim's `fix()` already short-circuits URLs that start with the
  prefix (`if(u.slice(0,P.length+1)===P+'/')return u;`), so the now-prefixed URLs Grafana
  generates pass through untouched;
* upstream is unaffected — Grafana still receives `/login`, `/api/...` etc. with the prefix
  stripped as today.

## What I could not verify from here

`grafana.farmerboyag.com` resolves to **<lan-host-ip>** — the customer's LAN, unreachable from
the RMM host, so I could not test the patch against the real instance. I confirmed the
bootdata mechanism against a live Grafana (`play.grafana.org`), but that is Grafana 13.2
with the new trimmed frontend; your docker1 instance is likely Grafana OSS with the full
`settings` blob. The injection above is written to be version-agnostic (it sets the field
rather than pattern-matching the JSON), but **it needs one real test against that Grafana**
before it can be called done.

Note also this is the Django RMM API, not the bridge — applying it means restarting the RMM
API service, which affects the whole RMM UI, not just AI chats.

## If it turns out not to be enough

Grafana also reads `appUrl` in some versions, and Live/WebSocket uses `/api/live/ws`. If
the router resolves but panels or live updates misbehave, the next things to check are
`window.grafanaBootData.settings.appUrl` and the WebSocket path through `fixws()`.
