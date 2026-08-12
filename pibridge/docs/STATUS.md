# Pi.dev ↔ Tactical RMM — DEPLOYED & LIVE

Date: 2026-07-07 (last appended 2026-07-12).

> **PARTIAL / DATED.** Accurate for what it covers, but it stops at 2026-07-12 and
> therefore omits most of what is now live: work ledger, AI procedures & known
> conditions, ticket review, action credits, operator-defined report schedules,
> AI Ticket Console, capability validator, ~30 migrations (`core/0068`–`0097`).
> **For the full change inventory and the upgrade/recovery procedure, read
> `docs/UPGRADE-RUNBOOK.md` (2026-07-27).**

## What works right now
Right-click a device in the portal → **Pi.dev** → popup chat window opens, scoped
to that device. Verified end-to-end: browser path (wss through nginx) → bridge →
pi SDK → Anthropic, plus device tool calls through the TRMM REST API.

## Live components

| Piece | Location | Status |
|-------|----------|--------|
| Bridge service | `/opt/pi-trmm-bridge` (systemd `pi-trmm-bridge.service`) | active, enabled on boot |
| Bridge env | `/etc/pi-trmm-bridge.env` | set |
| nginx route | `location ^~ /pi/` in `/etc/nginx/sites-enabled/rmm.conf` → `127.0.0.1:8787` | reloaded |
| Backend | migrations applied (`core.0054`, `accounts.0043`) | live |
| Frontend | rebuilt & deployed to `/var/www/rmm/dist` (backup: `dist.pre-pidev-*`) | live |
| Service API key | TRMM APIKey "pi-bridge" (user `pi-bridge-service`, role `pi-bridge-service`) | created |
| Test provider/model | Anthropic + `claude-sonnet-4-5` (default), module enabled | configured |

## How to administer

### Turn the module on/off, set approval/history
Global Settings → **Pi.dev AI** tab:
- Enable Pi.dev module (master switch)
- Require approval for device actions (default ON)
- Persist chat history per device (default ON)
- Providers table: add API keys per provider (Anthropic/OpenAI/Google/xAI/OpenRouter/custom)
- Models table: add models, set display name, thinking level, enable, mark one default

### Grant access to users (per role)
Accounts → Roles → edit a role → **Pi.dev AI** section:
- `Use Pi.dev AI Assistant` — required to open chats
- `Allow auto-approve of device actions` — lets that role toggle auto-approve in-chat
- `Allowed AI models` — multiselect; empty = global default model only
- (superusers get all enabled models automatically)

### Per-device history
Device view → **AI History** tab: lists prior chats, **Continue** (resume after a
dropped connection), **New chat**, delete.

## Model access enforcement
Enforced server-side twice: Django computes the caller's allowed models at token
mint (role ∩ enabled models, + default), and the bridge refuses any model not in
that list. The browser cannot override it.

## Managing the bridge
```bash
sudo systemctl status pi-trmm-bridge
sudo systemctl restart pi-trmm-bridge
tail -f /var/log/pi-trmm-bridge.log
curl -s http://127.0.0.1:8787/pi/health
```

## Notes / follow-ups
- Provider API keys are currently passed to the bridge inside the short-lived
  redis session blob (localhost redis, 8h TTL). DECISIONS #1 proposed a root-only
  secrets file instead; can harden later without changing the UX.
- The frontend "Pi.dev" menu item currently shows for everyone; the backend
  rejects users without `can_use_ai`. Can hide it by role later.
- pi session `.jsonl` files persist under `~/.pi/agent/sessions/...`; the bridge's
  per-agent `index.json` (under `/opt/pi-trmm-bridge/sessions/<agent_id>/`) maps
  them for the AI History tab and resume.
- Providers beyond Anthropic/OpenAI (native to pi) with custom base_url need a pi
  custom-provider mapping; wire that in when needed.

## Update-safety
**Superseded by `docs/UPGRADE-RUNBOOK.md` — follow that, not this paragraph.**
Bridge is independent of TRMM updates. Backend/frontend changes now live as commits on
`/rmm@feature/remote-proxy-v1.5.1` and `~/tacticalrmm-web@feature/remote-proxy` (plus the
fork branches `feature/pi-ai-assistant`), not as patch files; `update.sh` runs
`git clean -df` in `/rmm`, so anything left untracked there is deleted. Re-run
`quasar build` + redeploy `dist` after every upgrade.

## 2026-07-12 — Odoo helpdesk ticket injection (Phases 1+2 live)
- Bridge: new `src/odoo.js` (JSON-RPC to erp.blueuc.com, Softhealer `sh.helpdesk.ticket`);
  `create_ticket` tool in `src/tools.js` (mutating, gated; partner/team resolved from
  `/opt/pi-trmm-bridge/helpdesk-map.json` + res.partner search fallback; dedup by ref;
  team clamp worked around with create+write). Config: `ODOO_*` in `/etc/pi-trmm-bridge.env`.
- Backend: `CoreSettings.ai_helpdesk_prompt` (migration core.0064), passed as
  `helpdesk_prompt` in both chat session blobs (agents/views.py) and headless run
  payload (core/tasks.py `_run_prompt_on_agent`).
- Bridge injects it via `helpdeskSection()` in `src/server.js` (chat + scheduled).
- Frontend: "Helpdesk Ticket Policy" textarea in Global Settings -> Pi.dev AI tab
  (`AISettings.vue`), saved with main Save (serializer is `__all__`).
- Odoo service user: bluecloudapi@blueuc.com (API key), member of teams
  "BlueCloud Support" + "Alerts"; team 3 (Alerts) is the default ticket target.
- Test tickets created during validation: TICKET/58249, 58250, 58251 (safe to delete).
