# File-by-file change map (what gets added/touched)

> **STALE — historical plan only (written before implementation).** The "nothing is
> implemented yet" note below is no longer true: all of it shipped, plus a great deal
> more (work ledger, AI procedures, ticket console, report schedules, ~30 migrations).
> For the current, accurate list of what we've changed and what an upstream update
> breaks, read **`UPGRADE-RUNBOOK.md`**. Keep this file only as the original design map.

## Backend (Django, `/rmm/api/tacticalrmm`) — kept as re-appliable patch
| File | Change |
|------|--------|
| `core/models.py` | Add `AIProvider`, `AIModel` models; add `ai_module_enabled`, `ai_persist_history`, `ai_require_approval` to `CoreSettings` |
| `core/migrations/` | New migration for the above |
| `core/serializers.py` | Serializers for `AIProvider`, `AIModel`, new CoreSettings fields |
| `core/views.py` + `core/urls.py` | CRUD `GET/POST /core/ai/providers/`, `/core/ai/models/` (perm `can_edit_core_settings`) |
| `accounts/models.py` | Add `Role.can_use_ai`, `Role.can_use_ai_autoapprove`, M2M `Role.ai_allowed_models` |
| `accounts/migrations/` | New migration |
| `accounts/serializers.py` | Expose new role fields |
| `agents/permissions.py` | Add `PiPerms` (module enabled + `can_use_ai` + agent scope) |
| `agents/views.py` | Add `AgentPiSession` APIView (mint redis token, compute allowed models, audit) |
| `agents/pi_session.py` (new) | `create_pi_session()/get_pi_session()` redis helpers (mirrors `web_proxy.create_session`) |
| `agents/urls.py` | `path("<agent:agent_id>/pi/session/", views.AgentPiSession.as_view())`; `pi/history/` proxy |
| (optional) secrets sync | On `AIProvider` save, write root-only `/etc/pi-trmm-bridge/keys.json` for the bridge |

## Reverse proxy (nginx) — self-contained block
| File | Change |
|------|--------|
| `/etc/nginx/sites-enabled/rmm.conf` | Add `location ^~ /pi/ { proxy_pass http://127.0.0.1:8787; ... ws upgrade, buffering off, long timeout }` (reuse existing `map $connection_upgrade`) |

## Bridge (new, `/opt/pi-trmm-bridge`) — update-proof
| File | Purpose |
|------|---------|
| `src/server.ts` | HTTP/WS server on 127.0.0.1:8787; `/pi/ws/<token>/`, `/pi/health`, `/pi/history/<agent_id>` |
| `src/redis.ts` | Read `pisession:<token>` from the same redis django uses |
| `src/session.ts` | `createAgentSession()` per window; model enforcement vs allowed list; system-prompt seeding |
| `src/tools/*.ts` | Custom tools → TRMM REST, hard-bound to agent_id; read-only vs mutating classification for approval |
| `src/trmm-client.ts` | TRMM REST client (service API key) |
| `package.json`, `tsconfig.json` | Build with pi's bundled Node |

## Frontend (Quasar, `/home/tactical/tacticalrmm-web`) — re-appliable patch
| File | Change |
|------|--------|
| `src/components/agents/AgentActionMenu.vue` | Add "Pi.dev" `<q-item>` (robot icon) → `launchPiChat(agent.agent_id)`; show only if `can_use_ai` |
| `src/api/agents.js` (or new `src/api/pi.js`) | `runPiChat(agent_id)` opens popup to `/pichat/:agent_id`; `createPiSession(agent_id, {model})` POST; `fetchPiHistory(agent_id)` |
| `src/router/routes.js` | `path:"/pichat/:agent_id"` → `views/PiChat.vue` (`requireAuth`) |
| `src/views/PiChat.vue` (new) | Popup chat view: toolbar (device + model picker), streaming messages (markdown), tool-call cards w/ approve/deny, input+abort+steer, auto-approve toggle (if permitted), connects WS to `/pi/ws/<token>/` |
| `src/components/modals/coresettings/EditCoreSettings.vue` | New "AI / Pi.dev" tab: providers table, models table, default model, global toggles |
| `src/components/modals/coresettings/AIProvidersTable.vue` (new) etc. | CRUD UI |
| `src/components/accounts/RolesForm.vue` | "Pi.dev / AI" section: `can_use_ai`, `can_use_ai_autoapprove`, allowed-models multiselect |
| `src/components/SubTableTabs.vue` | New device tab "AI History" (gated `can_use_ai`) |
| `src/components/agents/AIHistoryTab.vue` (new) | Lists prior chats for the agent; Continue / New chat / delete |

## Deploy
| File | Purpose |
|------|---------|
| `deploy/pi-trmm-bridge.service` | systemd unit (User=tactical, EnvironmentFile, Restart=always) |
| `deploy/pi.location.nginx` | the `/pi/` nginx block to include |
| `deploy/pi-trmm-bridge.env.example` | TRMM_API_URL, TRMM_API_KEY, redis url, provider keys path, PORT |
| `deploy/install.md` | build bridge, install unit, add nginx block, reload, rebuild frontend |
