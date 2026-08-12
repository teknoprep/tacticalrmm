# TRMM Upgrade Runbook — what we've customized & what an upstream update destroys

Written 2026-07-27. **Read this before running `~/update.sh`.**

Pinned state at time of writing:

| Thing | Value |
|-------|-------|
| TRMM backend | `1.5.1` (`/rmm` describes as `v1.5.1-12-gcc3374b7`) |
| Web version (upstream) | `0.101.64` (our source tree `package.json` says `0.101.59`) |
| Agent | `2.11.0` |
| update.sh | `SCRIPT_VERSION="159"` |
| Bridge | `/opt/pi-trmm-bridge` v0.1.0, `@earendil-works/pi-coding-agent ^0.82.1` |
| Backend branch | `/rmm` on `feature/remote-proxy-v1.5.1` (12 commits ahead of `origin/master`) + uncommitted work |
| Web branch | `~/tacticalrmm-web` on `feature/remote-proxy` + uncommitted work |
| Fork PR heads | `teknoprep/tacticalrmm-web@8d5fc0b`, `teknoprep/tacticalrmm@d695e0a` (branch `feature/pi-ai-assistant`) |

---

## 1. Inventory — everything we've changed, by layer

### Layer 1 — Pre-AI custom features (v1.5.1 re-applied)
Origin commits `4ac7a889` (re-apply on v1.5.1), `96ebdd27`; patch `~/trmm-features-v1.5.1.patch`, `~/prepared-v1.5.1/`.

- **Remote Proxy / Terminal**: in-browser HTTP/HTTPS/SSH/Telnet/VNC to LAN devices through the agent — `api/tacticalrmm/agents/web_proxy.py` (+150 lines), single unified window in the UI.
- **Network Devices**: standalone Django app `api/tacticalrmm/netdevices/` (364 lines: models, serializers, views, urls, permissions, `0001_initial`), registered as `path("netdevices/", ...)` in `tacticalrmm/urls.py`.
  - `NetworkDevice`: FK→`clients.Site`, `name`, `protocol` (https/http/ssh/telnet), `ip_address`, `port`, `description`, `preferred_agents` (ordered ArrayField of `agent_id`), timestamps.
  - Endpoints: list/add, get/update/delete, `<pk>/connect/` (picks an online agent at that site, preferred first, then hands off to the Remote Proxy path).
  - Permissions reuse existing roles: `can_list_sites` (read), `can_manage_sites` (write), `can_use_mesh` (connect). No new role flags.
  - UI: `src/components/netdevices/NetworkDevicesTable.vue`, `NetworkDeviceForm.vue` (+ scope-default and `/agents/`-query fixes).
- **SSO**: provider callback route kept in the custom build — `~/sso-route.patch`, and see `~/SSO-REBUILD-ROLLBACK.md`.

### Layer 2 — Backend AI platform (`/rmm`, ~6.2k added lines: 13 modified + 42 new files)
- Modified: `core/models.py`, `core/tasks.py` (+3032), `core/views.py` (+1181), `core/urls.py`, `core/serializers.py`, `accounts/models.py`, `accounts/serializers.py`, `agents/models.py`, `agents/views.py`, `agents/web_proxy.py`, `logs/models.py`, `tacticalrmm/celery.py`, `tacticalrmm/constants.py`.
- New: `core/ai_conditions.py`, `core/ai_match.py`, `core/work_ledger.py`, `core/ticket_review.py`, 5 management commands (`rebuild_work_ledger`, `backfill_ai_credits`, `derive_baselines`, `link_ledger_users`, `merge_ledger_actors`).
- Features: `AIProvider`/`AIModel` + CoreSettings toggles; role perms (`can_use_ai`, `can_use_ai_mutate`, autoapprove, allowed models, `can_manage_all_ai_tasks`); redis-minted per-session tokens; scheduled AI tasks; bulk commands + chord finalizer combined report; AI history incl. client/site-scoped; helpdesk ticketing driven by settings-defined `helpdesk.js` + policy prompt; `/pi/assist` setup interview; device deep-links; deterministic ticket handling; AI procedures + known conditions; **work ledger**; action credits; ticket review; operator-defined report schedules; capability-tag validator.
- **Migrations: `core/0068`–`0097`, `accounts/0045`–`0046`, `agents/0063`** (~30). `netdevices/0001` is in its own app.

### Layer 3 — Frontend (`~/tacticalrmm-web`, ~5k+ lines)
`src/views/PiChat.vue`, `AIProcedures.vue`, `AITicketConsole.vue`; `src/components/agents/AIHistoryTab.vue`, `AIHistoryScope.vue`, `AITasksTab.vue`, `AITasksOverview.vue`, `BulkAICommands.vue`; `src/components/modals/coresettings/AISettings.vue`, `AIReportSchedules.vue`; `src/components/ui/{InfoTip,SettingsSection}.vue`; `src/utils/markdown.ts`; edits to `AgentActionMenu.vue`, `SubTableTabs.vue`, `RolesForm.vue`, `EditCoreSettings.vue`, `AuditManager.vue`, `FileBar.vue`, `DashboardView.vue`, `AgentView.vue`, `router/routes.js`, `api/agents.js`, `api/core.ts`.

### Layer 4 — Runtime glue, OUTSIDE the TRMM tree (survives updates)
- `/opt/pi-trmm-bridge` (Node + pi SDK): `server.js`, `tools.js`, `trmm.js`, `helpdesk-runtime.js`, `verifier-runtime.js`, `models-catalog.js`, `pi-runtime.js`, `history.js`, `capabilities.js`, `config.js`; `helpdesk-map.json`, `models.json`, `sessions/`.
- `/etc/pi-trmm-bridge.env`, systemd `pi-trmm-bridge.service`.
- nginx: `location ^~ /pi/ { proxy_pass http://127.0.0.1:8787; }` in `/etc/nginx/sites-enabled/rmm.conf` (~line 76).
- `~/pi-trmm-integration/` (docs, `tools/ticket_report.py`) — **not under git**.
- Prompts/policies/`helpdesk.js` live in the **database** (`CoreSettings`), not on disk. Backups in `docs/policy-backups/`.

---

## 2. What `~/update.sh` actually destroys

| # | update.sh | Effect on us |
|---|-----------|--------------|
| 1 | L428-435: `cd /rmm; git fetch; git checkout master; git reset --hard FETCH_HEAD; git clean -df; git pull` | **`git clean -df` deletes all 42 untracked files** (work_ledger, ticket_review, ai_conditions, ai_match, mgmt commands, ~30 AI migrations). `reset --hard` reverts the 13 modified files. `checkout master` also removes tracked-on-branch dirs like `netdevices/` from the working tree. Branch refs survive → recovery is re-checkout + rebase, not rewrite. |
| 2 | migrations | Our `core/0068`–`0097` collide with upstream's next `0068+` → **two leaf nodes, `migrate` refuses to run** until renumbered onto the new upstream leaf. Applied-migration names in the DB must keep matching. Biggest landmine. |
| 3 | L675-689: `rm -rf /var/www/rmm/dist` + upstream `trmm-web-v<ver>.tar.gz` | **All custom UI wiped** (all of Layer 3, Remote Proxy, Network Devices, SSO route). Must `quasar build` from our branch and redeploy. |
| 4 | L554+: replaces `rmm.conf` only `if ! grep -q "location /assets/"` | Safe *today* (ours has it). Whenever that condition trips, the `/pi/` block silently disappears → bridge unreachable. Backup goes to `~/rmm.conf.nginx.bak`. |
| 5 | L496: `rm -rf /rmm/api/env` when pip version changes | Only upstream `requirements.txt` is reinstalled. We currently add **no** extra pip deps (`Markdown`, `requests` are upstream), so nothing to re-add — recheck if that changes. |
| 6 | MeshCentral section | Rewrites `/meshcentral/package.json` + `npm install`. Our mesh config edits are backed up as `~/meshcfg*.bak`; `frontend.conf` / `meshcentral.conf` are not rewritten by the script. |
| 7 | community-scripts repo | `reset --hard` + `clean -df` — see `~/prepared-v1.5.1/scripts-features.patch` if we ever customize there. |

**Untouched:** the whole of Layer 4, and all DB-resident prompts/policies/settings.

---

## 3. Upgrade procedure

**Before**
1. `pg_dump` the TRMM database; note the current TRMM/web versions.
2. `cp -a /var/www/rmm/dist /var/www/rmm/dist.pre-<date>`.
3. In `/rmm`: `git add -A && git commit` on `feature/remote-proxy-v1.5.1` — **do not** leave the AI work untracked, `git clean -df` eats it.
4. Same in `~/tacticalrmm-web` (12 modified + 6 untracked as of writing).
5. Push both to the fork (`teknoprep/tacticalrmm{,-web}`) so a second copy exists off-box.
6. `tar czf ~/bridge-pre-<date>.tar.gz /opt/pi-trmm-bridge /etc/pi-trmm-bridge.env`, and back up `/etc/nginx/sites-enabled/*.conf`.
7. Export DB-held policy/prompt/`helpdesk.js` values into `docs/policy-backups/`.

**Run**
8. `./update.sh` (it self-updates first). Expect it to complain about the dirty tree.

**After**
9. `cd /rmm && git checkout feature/remote-proxy-v1.5.1 && git rebase <new-tag>` → conflicts land in `core/models.py`, `core/tasks.py`, `core/views.py`, `agents/views.py`, `agents/web_proxy.py`.
10. Renumber AI migrations onto the new upstream leaf (or `makemigrations --merge`), keeping DB names consistent → `python manage.py migrate`.
11. Confirm `netdevices/` is back and `path("netdevices/", ...)` is still in `tacticalrmm/urls.py`.
12. If `rmm.conf` was replaced: re-add the `/pi/` block → `sudo nginx -t && sudo systemctl reload nginx`.
13. Rebuild UI: `cd ~/tacticalrmm-web && quasar build` → deploy to `/var/www/rmm/dist` → `sudo chown -R www-data:www-data /var/www/rmm/dist` → restore `env-config.js`.
14. `sudo systemctl restart rmm daphne celery celerybeat pi-trmm-bridge`.
15. Verify: `curl -s http://127.0.0.1:8787/pi/health`; open a device → Pi.dev chat; AI History tab; Network Devices tab + connect; Remote Proxy; SSO login; a scheduled AI task; a helpdesk ticket write.

---

## 4. Known gaps / risks

- **Upstreaming**: PR amidaware/tacticalrmm-web#56 + its backend twin carry **only the AI work**. Remote Proxy, Network Devices and SSO are unsubmitted, and Remote Proxy is a dependency of the Network Devices connect flow — they need their own PR pair. Until upstream takes any of it, every upgrade repeats this runbook.
- **`~/pi-trmm-integration/` is not a git repo.** Docs and `tools/ticket_report.py` have no history and no off-box copy.
- **Fork clones live in `/tmp`** (`/tmp/pr-web`, `/tmp/pr-backend`) — gone on reboot. They also store a **GitHub PAT in plaintext** in `.git/config`; rotate it and move to SSH.
- `STATUS.md` (2026-07-12) and `docs/CHANGE-MAP.md` predate most of Layer 2/3 — trust the inventory above over those two.
