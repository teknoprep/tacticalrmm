# Design: Pi.dev integration for Tactical RMM

Date: 2026-07-07 · Status: **PROPOSAL (updated to match Remote Proxy pattern)**

---

## 1. How the existing "Remote Proxy" feature was built (the pattern we copy)

Verified on this server. This is the template for our implementation.

### 1a. Frontend — popup window, not a dialog
- `AgentActionMenu.vue` has a `<q-item>` "Remote Proxy" → `launchRemoteProxy(agent_id)`.
- That calls `runRemoteProxy(agent_id)` in `src/api/agents.js`, which does
  `router.resolve({ path: '/remoteproxy/:agent_id' })` then `openURL(url, null, {popup:true, width:1400, height:950,...})` — i.e. it opens a **real detached browser popup window** pointed at a dedicated route.
- Route registered in `src/router/routes.js`: `path:"/remoteproxy/:agent_id"` → `views/RemoteProxy.vue` (`meta:{requireAuth:true}`).
- `RemoteProxy.vue` is a full-page view (toolbar + content) that first POSTs to create a session, then connects.

### 1b. Backend — short-lived redis-token session
- Endpoint: `POST /agents/<agent_id>/webproxy/` → `AgentWebProxy` APIView.
- `permission_classes = [IsAuthenticated, MeshPerms]` — `MeshPerms` checks the
  role flag **and** that the user has access to that specific agent
  (`_has_perm(r,"can_use_mesh") and _has_perm_on_agent(user, agent_id)`).
- Creates a session in **redis via django cache**: `create_session()` stores
  `webproxy:<token>` → `{agent_id, hex_node_id, protocol, addr, port, username, hostname}` with a TTL (`secrets.token_urlsafe(32)`).
- Writes an **audit log** entry (`AuditLog.audit_mesh_session(...)`).
- Returns `{url:"/agentproxy/<token>/", token, hostname, client, site, target}`.

### 1c. Reverse proxy — nginx routes a token path to an async server
- `/etc/nginx/sites-enabled/rmm.conf` (the `api.blueuc.com` server block) has:
  ```nginx
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }

  location ^~ /agentproxy/ {
      proxy_pass http://unix:/rmm/daphne.sock;   # ASGI (uvicorn/daphne)
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-Host $server_name;
      proxy_buffering off;
      proxy_request_buffering off;
      proxy_read_timeout 120s;
      proxy_send_timeout 120s;
  }
  ```
- HTTP requests on `/agentproxy/<token>/<path>` are routed by Django `urls.py`
  (`re_path(r"^agentproxy/(?P<token>...)/(?P<path>.*)$", agent_web_proxy)`), and
  WebSockets by the ASGI `ws_urlpatterns` (`ProxyWebSocketConsumer`).

**Our version keeps 1a and 1b almost identical, and mirrors 1c** — the only
difference is the nginx `location /pi/` proxies to the Node **pi-trmm-bridge**
(`127.0.0.1:8787`) instead of the daphne socket, because pi's SDK is Node, not
Python. Same headers, same `map $connection_upgrade`, same long timeouts, same
token-in-redis handshake.

---

## 2. Current environment (verified)

| Component | Detail |
|-----------|--------|
| TRMM | v1.5.1 custom build, Django at `/rmm/api/tacticalrmm` |
| Frontend | Quasar/Vue 3 at `/home/tactical/tacticalrmm-web` → `/var/www/rmm/dist`, `https://rmm.blueuc.com` |
| API | `https://api.blueuc.com` (uwsgi `rmm.service` + ASGI `daphne.service` on `/rmm/daphne.sock`) |
| Agent comms | NATS; device actions already exposed via REST (`/agents/<id>/cmd/`, `/runscript/`, procs, eventlog, software, checks, tasks) |
| pi.dev | v0.80.3 for user `tactical`, SDK `@earendil-works/pi-coding-agent`; multi-provider capable (Anthropic/OpenAI/Google/etc.) |
| Existing AI fields | `CoreSettings.open_ai_token`, `CoreSettings.open_ai_model` (used for the script-writer AI helper) — we extend this area |
| Role perms | `accounts.Role` has ~40 `can_*` boolean flags (`can_use_mesh`, `can_send_cmd`, `can_run_scripts`, …). We add AI ones here. |
| Session store | redis via django cache (used by web_proxy tokens) |

---

## 3. Target architecture

```
Browser (portal)
  AgentActionMenu → "Pi.dev" → runPiChat(agent_id)
      → POST /agents/<id>/pi/session/   (Knox auth + PiPerms; returns token + allowed models)
      → openURL popup → route /pichat/:agent_id  → views/PiChat.vue
      → WebSocket  wss://api.blueuc.com/pi/ws/<token>/
                                   │
  nginx (api.blueuc.com):  location ^~ /pi/  → proxy_pass 127.0.0.1:8787  (ws upgrade, buffering off, long timeout)
                                   │
  pi-trmm-bridge (Node, systemd, user=tactical, 127.0.0.1:8787)
      • Reads redis  pisession:<token>  → {agent_id, user, provider, model, allowed_models, ...}   (written by Django)
      • createAgentSession(): model = requested (must be in allowed_models), provider key from settings
      • System prompt seeded with device facts
      • Built-in bash/edit/write DISABLED; custom tools call TRMM REST bound to agent_id
      • Streams events → WS → PiChat.vue
      • Persists session jsonl under ~/.pi-trmm/sessions/<agent_id>/  → powers "AI History" tab
                     │TRMM REST (service key)        │provider API (key from settings)
                Django (/rmm) → NATS → device        LLM provider
```

---

## 4. NEW: AI settings & model access control (admin-configurable)

This is the core of the new requirements. Two layers: **global config** (keys +
model catalog) and **per-role access** (who can use AI, and which models).

### 4.1 Global settings — provider keys + model catalog
`CoreSettings` already carries `open_ai_token`. We generalize to multi-provider.
Proposed new Django models (in a small `ee/ai` or `core` addition):

- **`AIProvider`** — one row per provider the admin enables:
  - `name` (choices: `anthropic`, `openai`, `google`, `xai`, `openrouter`, `custom`, …)
  - `api_key` (stored encrypted — reuse TRMM's Fernet field pattern like `mesh_token`)
  - `base_url` (optional, for custom/self-hosted/openrouter)
  - `enabled` (bool)
- **`AIModel`** — the catalog of models the admin exposes (maps to pi's `provider/id`):
  - `provider` (FK → AIProvider)
  - `model_id` (e.g. `claude-sonnet-4-20250514`, `gpt-4o`)
  - `display_name` (e.g. "Claude Sonnet 4")
  - `thinking_level` default (`off`/`low`/`medium`/`high`) for models that support it
  - `enabled` (bool)
  - `is_default` (exactly one global default)
- Global toggle on `CoreSettings`: `ai_module_enabled` (bool),
  `ai_persist_history` (bool), `ai_require_approval` (bool default True).

Frontend: a new tab **"AI / Pi.dev"** in `EditCoreSettings.vue` (next to where
`open_ai_token` already lives), gated by `can_edit_core_settings`:
  - table of providers (add/edit key/base_url/enable)
  - table of models (add from provider, set display name, enable, mark default)
  - global toggles (module enabled, persist history, require approval)

API: `GET/POST /core/ai/providers/`, `/core/ai/models/`, all requiring
`can_edit_core_settings` (view) — mirrors the existing keystore/URL-actions CRUD.

### 4.2 Per-role access — module permission + allowed models
Add to `accounts.Role` (same style as `can_use_mesh`):
- `can_use_ai` (bool) — can this role open Pi.dev chats at all.
- `can_use_ai_autoapprove` (bool) — may this role toggle auto-approve of device actions (see §7).
- `ai_allowed_models` — **M2M → AIModel** (which enabled models this role may pick).
  Empty M2M + `can_use_ai=True` → falls back to global default model only.

`RolesForm.vue` gets a "Pi.dev / AI" section: the `can_use_ai` checkbox and a
multi-select of models (populated from enabled `AIModel`s). This gives you exactly
what you asked: *permission to use the module* **and** *permission to use specific
models*, both admin-controlled, both dependent on the group/role.

### 4.3 Permission class (backend)
```python
class PiPerms(BasePermission):
    def has_permission(self, r, view):
        return (
            core_settings.ai_module_enabled
            and _has_perm(r, "can_use_ai")
            and _has_perm_on_agent(r.user, view.kwargs["agent_id"])
        )
```
When minting the session token, Django computes the caller's **effective allowed
models** = intersection(role.ai_allowed_models, enabled AIModels) (+ default),
and stores that list in the redis session. The bridge will **refuse any model not
in that list** — so model access is enforced server-side, not trustable from the
client.

---

## 5. Session creation endpoint (mirrors AgentWebProxy)

`POST /agents/<agent_id>/pi/session/` → `AgentPiSession` APIView,
`permission_classes=[IsAuthenticated, PiPerms]`:
1. Resolve agent, gather device facts (hostname, client/site, os/plat, IPs, logged-on user, agent version, custom fields).
2. Determine allowed models + default for this user's role.
3. Validate requested model (body `model`) ∈ allowed (default if none given).
4. `create_pi_session()` → redis `pisession:<token>` (TTL e.g. 8h) =
   `{agent_id, username, provider, model, thinking, allowed_models, device_facts, require_approval}`.
5. `AuditLog.audit_mesh_session(..., feature="pi_ai")`.
6. Return `{ url:"/pichat/<agent_id>?token=<token>", token, hostname, client, site, model, allowed_models }`.

Token is single-window, short-lived, bound to user+agent+model set. Browser never
sees any provider key or TRMM service key.

---

## 6. pi-trmm-bridge (Node service)

- Runtime: pi's bundled Node 22. Location `/opt/pi-trmm-bridge`. Listens `127.0.0.1:8787`. systemd `User=tactical`.
- `GET /pi/ws/<token>/` (WebSocket): look up redis `pisession:<token>` (reads same
  redis as django cache — key prefix + json). Reject if missing/expired.
- Build session:
  - `AuthStorage` seeded with provider keys from settings (or Django passes the
    needed key in the redis blob, encrypted-at-rest, decrypted by a shared secret —
    **decision in DECISIONS.md #3**). Preferred: bridge reads keys from a
    root-only env/secrets file synced from `AIProvider`, never from the browser.
  - `createAgentSession({ model: <provider/model from token>, tools: [], customTools:[...], sessionManager: SessionManager.create('~/.pi-trmm/sessions/<agent_id>/'), systemPromptOverride })`.
  - **Enforce**: requested model must be in `allowed_models` from the token, else close.
- Tools (bash/edit/write disabled). Custom tools, each hard-bound to `agent_id`
  from the token, calling TRMM REST with a service API key:
  `get_device_details`, `run_command_on_device`, `run_script_on_device`,
  `list_scripts`, `list_processes`, `kill_process`(gated), `get_event_logs`,
  `list_software`, `get_checks`, `get_tasks`, `get_pending_actions`,
  `reboot_device`(gated), `send_wol`(gated).
- Relay events over WS (text deltas, thinking collapsed, tool start/update/end as
  cards, agent_end, cost). Client → bridge: `prompt`, `steer`, `abort`,
  `new_session`, `resume_session:<file>`, `approve_tool`/`deny_tool`.
- Idle dispose after socket close (~30 min), max concurrent sessions cap.

---

## 7. Approval of device actions (my call, per your delegation)

**Default: approval ON, per-session auto-approve allowed only for permitted roles.**
- Read-only tools (`get_*`, `list_*`) run freely.
- Mutating tools (`run_command_on_device`, `run_script_on_device`, `kill_process`,
  `reboot_device`, `send_wol`) → the tool's `execute()` awaits an in-window
  approval. `PiChat.vue` shows a card: *"Pi wants to run on HOSTNAME: `ipconfig
  /all` — [Approve] [Deny]"*. Approve → WS `approve_tool` resolves it; Deny →
  tool returns "operator denied" to the model.
- If the role has `can_use_ai_autoapprove`, the window shows an "Auto-approve this
  session" toggle; when on, mutating tools run without prompting (still fully
  logged + visible live). Off by default each new window.
- Rationale: matches TRMM's existing safety posture (commands are a privileged
  action) while letting trusted operators move fast. Everything is audited
  regardless.

---

## 8. AI History (per-device tab, resumable)

You asked for history under the device's tabs as **"AI History"**, resumable after
a dropped connection.

- The bridge persists each chat as a pi session `.jsonl` under
  `~/.pi-trmm/sessions/<agent_id>/<session-id>.jsonl` (SDK `SessionManager`).
- New device sub-tab **"AI History"** in `SubTableTabs.vue` (gated by
  `can_use_ai`): lists prior chats for that agent (name, started, last message,
  model, operator), via `GET /agents/<agent_id>/pi/history/` (Django reads the
  bridge's session index, or the bridge exposes `GET /pi/history/<agent_id>` that
  Django proxies with auth).
- Each row → **[Continue]** opens the Pi.dev popup with `?resume=<session-id>`;
  the bridge does `SessionManager.open(<file>)` so the full context is restored —
  covering "continue in case you lost connection." A **[New chat]** button starts
  fresh. Because the jsonl is written continuously, a mid-conversation disconnect
  loses nothing; reopening resumes exactly where it left off.
- Retention/purge policy configurable (DECISIONS #7).

---

## 9. Security model
1. Access gated by `ai_module_enabled` (global) + `can_use_ai` (role) + agent-scope, enforced at token mint.
2. Model choice enforced server-side against role's allowed list (client can't override).
3. No shell on the RMM server for pi (bash/edit/write off); only agent-scoped TRMM-API tools.
4. Mutating actions gated by approval (§7); all tool runs live-visible + audited.
5. Provider/TRMM keys are server-side only; browser gets a short-lived redis token.
6. Device data + command output + logs are sent to the configured LLM provider —
   **accepted and expected** (it's inherent to using AI on device data). Documented
   so admins know before enabling; per your direction this is fine.
7. Prompt-injection from device output mitigated by approval gating + system-prompt warning to treat device output as untrusted data.

---

## 10. Build plan
| Phase | Deliverable |
|-------|-------------|
| 0 | This review; resolve DECISIONS.md |
| 1 | Backend: `AIProvider`/`AIModel` models + migrations, CoreSettings toggles, CRUD endpoints |
| 2 | Backend: Role `can_use_ai`/`ai_allowed_models` + `PiPerms` + `POST /agents/<id>/pi/session/` (redis token, audit) |
| 3 | Bridge skeleton: WS + redis token verify + pi session with `get_device_details` + `run_command_on_device`, model enforcement, plain streaming (test with wscat) |
| 4 | nginx `/pi/` block; frontend menu item + `PiChat.vue` popup route + streaming UI + tool cards + approval |
| 5 | Settings UI (providers/models tabs in EditCoreSettings) + RolesForm AI section |
| 6 | AI History tab + resume; full tool set; abort/steer; cost display |
| 7 | Hardening: limits, retention, audit enrichment, update/backup integration |

## 11. Update-safety
Bridge in `/opt/pi-trmm-bridge` (update-proof). Frontend/backend changes kept as
re-appliable patches in `frontend-patch/`, `trmm-backend-patch/` alongside the
existing v1.5.1 feature patch set. nginx = one self-contained `location` block +
the `map` (guard against duplicate if already present from agentproxy).
