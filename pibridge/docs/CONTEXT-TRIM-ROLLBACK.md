# Context trim + IT group rename — change log & rollback

Started 2026-09-27 (UTC). Owner: chris. Status: **IN PROGRESS** (this file is updated as each change lands).

## ⚠️ READ FIRST — bridge source drift (found 2026-09-27, predates these changes)

The runbook says edit the bridge in `/rmm/pibridge/src` and deploy with `setup.sh`. **That tree is
stale** (last commit 2026-09-22): 16 files differ from what is live in `/opt/pi-trmm-bridge/src`
and 7 live modules do not exist there at all (`judge.js`, `auto-compact.js`, `authorizer.js`,
`credential-command.js`, `run-cost.js`, `stall-continue.js`, ...). `setup.sh` does
`cp -r src` into `/opt`, so **running it (or a TRMM `update.sh`, which calls it) would silently
roll production back ~5 days.** Every change in this file was made in `/opt` and deployed with
`sudo systemctl restart pi-trmm-bridge`, NOT `setup.sh`. Sync `/opt/pi-trmm-bridge/src` →
`/rmm/pibridge/src` and commit before anyone runs `setup.sh` again.

## Why

A decision (ticket) chat opened at **18,573 tokens before the model did anything**
(TICKET/61871, 2026-09-27 10:37, gpt-6-luna). ~95% of that was injected boilerplate:
system prompt 10,736 tok + 15 tool schemas ~5,500 tok. Compaction cannot shrink it —
the system prompt and tool schemas are re-sent verbatim on every turn. Goal: ~8k floor.

## Backups

Everything is in **`/home/tactical/backups/context-trim-20260927T104508Z/`**
(path also stored in `/home/tactical/.last-context-trim-backup`).

| backup | what it is |
|---|---|
| `bridge-src/` | full copy of `/opt/pi-trmm-bridge/src/` **before any change** (bridge is not a git repo) |
| `coresettings-prompts.json` | `CoreSettings` prompt fields before any change: `ai_ticket_decision_prompt`, `ai_helpdesk_prompt`, `ai_ticket_triage_prompt`, `ai_sales_prompt`, `ai_discovery_prompt` |
| `django/views.py` | `/rmm/api/tacticalrmm/core/views.py` before any change |
| `django/agents-views.py` | `/rmm/api/tacticalrmm/agents/views.py` before any change |
| `django/agent_groups.py.after-rename` | `core/agent_groups.py` **after** the rename (see change 0 — the only pre-rename difference is one line) |

`/rmm` is a git repo, so Django files can also be restored with `git -C /rmm diff` / `git checkout`.
**Careful:** `/rmm` has other uncommitted work in progress — restore single files, never `git checkout .`.

## Changes

### 0. Agent group rename (done)
- DB: `core.AIAgentGroup` pk=6 `name` `'IT (Luna)'` → `'IT (low-cost)'`. Slug stays `it-luna` (the seed and migration 0126 match on slug).
- Code: `/rmm/api/tacticalrmm/core/agent_groups.py` seed spec `"name": "IT (Luna)"` → `"IT (low-cost)"`.
- Revert:
  ```bash
  cd /rmm/api/tacticalrmm && /rmm/api/env/bin/python -c "import os,django;os.environ.setdefault('DJANGO_SETTINGS_MODULE','tacticalrmm.settings');django.setup();from core.models import AIAgentGroup as G;G.objects.filter(slug='it-luna').update(name='IT (Luna)')"
  sed -i 's/"name": "IT (low-cost)",/"name": "IT (Luna)",/' /rmm/api/tacticalrmm/core/agent_groups.py
  ```

### 1. Lazy capabilities in the ticket (AI Decision) chat — bridge code
Tools/rules a ticket rarely needs are OFF until the job needs them. One new tool, `load_capability`,
turns one on for the rest of the chat; its rules arrive as the tool result (the cached system prompt
never changes). Capabilities: `desktop` (16 `operator_*` tools + Operator instructions), `totp`
(TOTP policy + the 4 TOTP helpdesk ops; also loads desktop; **auto-loads** the first time a TOTP op
is used, rules prepended to that result), `procedure` (`save_procedure`), `sales` (`sales_call` +
sales policy). A resumed chat that already used a capability gets it back automatically.
Authority is unchanged (capabilities.js classes, Write mode, approvals, judge, credential gate).
- New: `/opt/pi-trmm-bridge/src/lazy-capabilities.js`, `/opt/pi-trmm-bridge/test/lazy-capabilities.test.mjs` (9 tests, real pi agent loop via the faux provider; added to `npm test`).
- `src/tools.js` `buildDecisionTools`: new `unadvertised` + `desktopLoadHint` options; returns `unadvertisedOpLines`. Desktop refusals in `run_device_command` mention `load_capability`.
- `src/server.js` `startDecisionChat`: builds the capabilities; drops the Operator section, `TOTP_POLICY` and the sales policy from the system prompt **only when that capability exists** (otherwise old text is kept).
- Measured tool payload a ticket chat sends on turn 1: **40,345 → 21,576 chars (−47%)**, 32 → 16 tools (`backups/.../measure-before.txt`, `measure-after-tools.txt`; scripts in `/home/tactical/scheduled/context_trim/`).
- If the AI "can't find" desktop/TOTP/sales/procedure tools: it should call `load_capability`. To revert just this change, restore `server.js`, `tools.js` from the backup and delete `src/lazy-capabilities.js` + the test (and its entry in `package.json`).

### 2. helpdesk_call catalog trimmed in ticket chats — bridge code
CRM/opportunity ops and TOTP ops are no longer LISTED in the ticket chat's `helpdesk_call`
description (`TICKET_CHAT_UNADVERTISED` in `lazy-capabilities.js`). They stay callable; TOTP ops
are listed when `totp` loads. ~1.8k chars.

### 3. Hardcoded prose compressed — `src/server.js`
`TECH_AUTHORITY_POLICY` (1,219 → ~800 chars), `HANDOFF_FLOOR` (551 → ~330), the reply-format note in
`helpdeskSection` (370 → ~150). Same rules, fewer words. Originals are in `bridge-src/server.js`.

### 4. Native pi providers + DeepSeek
- Cause of `Model not found: custom/deepseek-flash`: pi files DeepSeek under provider **`deepseek`**; `custom` is not a provider the bridge can run.
- Bridge: new `GET /pi/providers` (every provider the installed pi supports natively) in `src/server.js`; `src/models-catalog.js` discovery falls back to pi's own endpoint when a provider row has no base_url.
- Django: `AIProvider.name` no longer a closed choices list (migration `core/0128_aiprovider_native_provider_names`, SQL no-op); `AIProviderSerializer.validate_name` checks the id against the bridge; new `native_pi_providers()` helper (`core/serializers.py`), view `AINativeProviders` (`core/views.py`), route `ai/native-providers/` (`core/urls.py`).
- Frontend: `src/api/core.ts` `fetchNativeAIProviders`; `AISettings.vue` provider dropdown built from pi (searchable; OAuth-only providers disabled); Base URL optional with pi's default shown. Rebuilt with `quasar build`, deployed to `/var/www/rmm/dist`.
- DB: provider pk=7 `custom` → `deepseek`; model pk=18 `deepseek-flash` thinking `medium` → `low` (DeepSeek supports low/high/max only).
- Backups: `backups/.../deepseek/` → `models.py`, `AISettings.vue`, `db-rows-before.json`, `var-www-rmm-dist/` (the whole live UI before the rebuild).
- Revert UI: `sudo rm -rf /var/www/rmm/dist && sudo cp -a $B/deepseek/var-www-rmm-dist /var/www/rmm/dist`
- Revert DB rows: set provider 7 name back to `custom`, model 18 thinking back to `medium` (values in `db-rows-before.json`). Revert Django code with `git -C /rmm diff` on the files above (single files only) and `migrate core 0127` before deleting `0128`.

### 5. DeepSeek is the IT + Coding orchestrator; group members fixed
- You had already set `deepseek-flash` as orchestrator of IT and Coding (provider `custom`). Members pk=9 (IT) and pk=23 (Coding) → provider `deepseek`; Coding thinking `medium` → `high` (DeepSeek has no medium; pi was already clamping it up to high). Before: `backups/.../deepseek/group-members-before.json`.
- IT was re-saved from a Settings page opened before the rename and wrote `custom` back once — **reload Settings before saving a group.**
- Verified live: tool call + second turn with thinking through the bridge's pi runtime, $0.00036.

### 6. Luna groups deleted; IT/Coding descriptions + seed specs updated
- Deleted `Coding (Luna)` (pk 5) and `IT (low-cost)` / slug `it-luna` (pk 6) with their 19 member rows. **Full backup: `backups/.../luna-groups-deleted.json`** (every field of both groups and all members). Windows that remembered them fall back to the default group (IT).
- IT is the default group. New descriptions for IT and Coding (old ones: `backups/.../group-descriptions-before.json`). The description is sent to the orchestrator on every turn, so it is short and current; the reasons moved into comments in the seed.
- `/rmm/api/tacticalrmm/core/agent_groups.py` `SEED_GROUPS`: Luna specs removed (Seed can no longer recreate them); IT spec renamed `IT (Sonnet 5)` → `IT`, `is_default: True`; IT + Coding members/descriptions now match the live DB exactly. `Coding+` untouched (it already differed from the DB: live grok-4.7 vs seed grok-4.6).
- Restore a Luna group: recreate from the JSON (AIAgentGroup fields + AIAgentGroupMember rows), or re-add its old spec from `git -C /rmm diff api/tacticalrmm/core/agent_groups.py` and press Seed.

### 7. IT coder → DeepSeek V4.1 Flash (owner request)
- IT group member `coder`: `anthropic/claude-opus-5-5` (high) → `deepseek/deepseek-flash` (high). Role definition (IT coder instructions) unchanged. IT description updated to match; seed spec in `core/agent_groups.py` updated (seed = live verified).
- Backup: `backups/.../it-coder-before.json` (member row + old description).
- Watch for: scripts/code quality on IT tickets. History: Sonnet produced unusable FusionPBX scripts on TICKET/61820, which is why the coder had been moved to Opus. Revert = set the IT coder back to Anthropic / claude-opus-5-5 / high in Settings > AI > Agent Groups (reload the page first).

### 8. pi relay (remote pi → bridge → providers) — see `docs/PI-RELAY.md`
**Backup set: `/home/tactical/backups/pi-relay-20260927T112652Z/`** (path also in `~/.last-pi-relay-backup`): `bridge-src/`, `package.json`, `django/` (models, views, urls, serializers, local_settings — mode 600), `etc/` (bridge env file, nginx rmm.conf), `var-www-rmm-dist/` (UI before the Relay Keys panel).
- Bridge: new `src/relay.js`, `relay-client/{index.ts,install.sh}`, `test/relay.test.mjs` (in `npm test`); `src/server.js` routes `/pi/relay/` to it (2 lines + import).
- Django: model `AIRelayKey` + `relay` spend surface (migration `core/0129_ai_relay_keys`), `core/relay.py` (verify + key API), routes `ai/relay/verify|keys`, command `manage.py relay_keys`. Secrets `PI_RELAY_INTERNAL_SECRET`, `PI_RELAY_KEY_PEPPER` appended to `local_settings.py` (now chmod 640); `PI_RELAY_INTERNAL_SECRET` appended to `/etc/pi-trmm-bridge.env`.
- nginx: `/etc/nginx/conf.d/pi-relay.conf` (rate-limit zone) + `location ^~ /pi/relay/` in `sites-enabled/rmm.conf` (copy of the old file also at `/etc/nginx/backups/rmm.conf.bak-pre-relay-*`).
- Frontend: `AIRelayKeys.vue` + 3 API calls, mounted in `AISettings.vue`; rebuilt + deployed.
- This server's pi: `~/.pi/agent/extensions/rmm-relay/index.ts` (symlink) + `~/.pi/agent/rmm-relay.json` (key `pirk_oEvT3TFewQ3r`, chris / Coding, $5 day / $50 month).
- **Kill switch (fastest, no restart):** revoke keys in Settings → AI → pi Relay Keys (≤30s), or close the public door: delete the `location ^~ /pi/relay/` block from `/etc/nginx/sites-enabled/rmm.conf` → `sudo nginx -t && sudo systemctl reload nginx`.
- Full revert: restore `rmm.conf` from `etc/`, `rm /etc/nginx/conf.d/pi-relay.conf`, reload nginx; restore bridge `src/server.js` from `bridge-src/` and delete `src/relay.js`, `relay-client/`, `test/relay.test.mjs` (+ its `package.json` entry), restart the bridge (check the log for a running chat first — see PI-RELAY.md "Restarting"); `migrate core 0128`, delete `0129` and `core/relay.py`, the command, and the 3 routes / model / surface lines (`git -C /rmm diff`), restart rmm; UI from `var-www-rmm-dist/`; remove the two `PI_RELAY_*` lines from `local_settings.py` and the env file; `rm -r ~/.pi/agent/extensions/rmm-relay ~/.pi/agent/rmm-relay.json`.
- ⚠️ During deployment the bridge restart interrupted TICKET/60427 between two steps (its last device command had completed). Its queued prompt is paused as *Interrupted* — resume it from that window.

### 9. Relay keys: Edit + Unlimited (owner request)
- Test key `pirk_oEvT3TFewQ3r` (chris/Coding): $5 day / $50 month cap **removed** → unlimited.
- Django `core/relay.py`: `PATCH /core/ai/relay/keys/<pk>/`; `unlimited` flag; budgets validated ($0-100000), IPs validated; budget/expiry/unlimited admin-only; create requires a budget or Unlimited. `manage.py relay_keys set …` / `create --unlimited`.
- UI `AIRelayKeys.vue`: Edit dialog, Unlimited toggle, Unlimited badge; new keys pre-fill $10/day, $100/month. UI before this change: `backups/pi-relay-…/var-www-rmm-dist-before-edit/`.
- Client 1.0.1: `/rmm-login` no longer asks for the URL (`/rmm-login <url>` to override); Enter keeps the saved username.

### 10. Relay: one key -> many groups, and permanent delete (owner request)
- `AIRelayKey.group` (FK) -> `groups` (M2M). Migration `core/0131_relay_key_multi_group` copies the old value into the new list, so existing keys kept their group.
- Protocol **2**: `whoami` returns `groups: [...]`; `/stream` takes `group` + `role`. Changed: bridge `src/relay.js`, client `relay-client/index.ts` **1.1.0** (its startup now refreshes when the cache is >5 min old, so a group added in the RMM appears without starting a chat).
- Revoked keys can be deleted for good: `DELETE /core/ai/relay/keys/<pk>/?purge=1` (admin, revoked only), UI **Delete** on a revoked row, `manage.py relay_keys delete <key_id>`. Otherwise revoked rows are kept forever; the new **Show revoked** toggle hides them by default. UI rebuilt + deployed (`backups/pi-relay-20260927T112652Z/var-www-rmm-dist-before-edit/` is the previous one).
- Also: `resolve_groups()` accepts `group_ids` / `group_id` / `group` (slug, comma list, or list); `AIRelayKey.issue()` no longer takes `group`; `AIRelayKeySendInstall` and the key list no longer use `.group`.
- chris's key `pirk_oEvT3TFewQ3r` now reaches **coding + it** (was coding only), still unlimited.
- ⚠️ While this was being built the API ran for ~4 minutes against a migrated schema (relay auth answered 500: `relay_denied … verify HTTP 500` in the bridge log). Nothing else was affected; the fix was finishing the code and restarting `rmm`.

### 11. Headless surfaces can use a group (owner request)
- **What:** ticket triage and autowork run on an agent group instead of the starred default model. Resolution: explicit per-run group → Settings > AI > **Preferred agent group** → starred default (old behaviour). New doc: `docs/AGENT-GROUPS.md`.
- **Django:** `CoreSettings.ai_preferred_agent_group` (FK, null) + `AITicketAutomationSubject.agent_group` (FK, null) — migration `core/0132_headless_agent_group`, whose data step sets the preferred group to **IT**. Helper `core/agent_groups.py: headless_group_blob()`. Blob changes in `core/tasks.py` (triage) and `core/ai_autowork.py` (autowork): they now send `agent_group`, `agent_group_keys`, `group_orchestrator`, and put the orchestrator in `provider`/`model_id`/`api_key`/`thinking_level`. Triage no longer requires an `AIModel` row when a group is set.
- **Bridge:** `applyHeadlessGroup()` in `src/agent-groups.js`; `runTicketTriage` + `runAutowork` use it, merge group provider keys, attach `attachGroupToLoader` (roster + `delegate`), and call `routeCodeToCoder`/`routeWebToResearcher`. Authority unchanged; no judge attached (see AGENT-GROUPS.md for why).
- **UI:** picker in Settings > AI (preferred group) and in the Ticket Automation Subject dialog (per-subject). Rebuilt + deployed.
- **Verified:** synthetic `TICKET/000000` state run through the real celery task → triage rows in the ledger on `deepseek/deepseek-flash` (was grok-4.7). Services restarted: rmm, celery, celerybeat (celery had no in-flight task).
- Revert: restore those 5 files from the backup, `migrate core 0131`, delete `0132`, restart rmm/celery/celerybeat.

### 12. Restart guard + two findings (2026-09-27)
- **New `tools/bridge-restart.sh`** (symlinked to `/usr/local/bin/bridge-restart`): refuses to restart when `/pi/busy` says a run is in flight OR the log shows tool/judge activity in the last 5 minutes, and prints what it saw. `--force` overrides; `--window N` changes the look-back. **Use this instead of `systemctl restart pi-trmm-bridge`.**
  Why: `/pi/busy` and `/pi/live` read as idle *between tool steps* of a live run. That cost two interruptions today — TICKET/60427 (11:35) and **TICKET/61884 (12:21:06)**, where a PowerShell `Find-Module ExchangeOnlineManagement` check was cut off 3 seconds in and its result was never recorded. 61884 was resumed by the owner afterwards.
- **Bridge memory leak:** the bridge process OOM'd at ~10:01 today (`Ineffective mark-compacts near heap limit`, PID that had run 11.5 h and grown to a 3.8 GB heap). systemd restarted it. Pre-existing, not caused by today's changes; worth investigating (candidates: retained sessions/hubs in `live-hub.js`, per-session transcript copies).

### 13. Coding coder → V4.1 Flash (owner request)
- `coder` in the **Coding** group: `deepseek-v4-pro` (max) → `deepseek-flash` (high). IT's coder was already flash. Seed spec in `core/agent_groups.py` updated (Coding + IT now match the DB exactly; Coding+ still differs).
- Reason: owner prefers the V4.1 cost and considers it the newer/better generation; measured coder spend is tiny ($1.70/30 days), so this is a quality bet, not a big saving. Watch patch quality on the first few real changes. Backup: `backups/pi-relay-20260927T112652Z/coding-coder-before.json`.

### 14. CLI before desktop, and the MFA handshake (owner requests, live 2026-09-27)
Both were prompted by TICKET/61884 (grant mailbox access): ~12 minutes of GUI clicking for a job
that is two cmdlets, and a phone-prompt risk that only stayed safe by luck.
- **Cloud admin portals are refused** on the desktop tool (`CLOUD_ADMIN_PORTAL` + `cloudPortalMessage` in `src/tools.js`), naming the CLI recipe (agent + `run_script_with_credential` + `Connect-ExchangeOnline`/`Connect-MgGraph`). `mysignins.microsoft.com` stays allowed (TOTP enrolment reads a secret off that page). Test: `test/cloud-portal-guard.test.mjs` (5).
- **Route order stated in the prompt**: `PREFER_CLI_POLICY` (CLI/API first, desktop last) + the desktop capability now reads "LAST RESORT" in `load_capability`.
- **MFA handshake, ENFORCED**: `mfaPhoneGate()` in `src/tools.js` holds the buttons that contact the technician ("Call me", "Text me", "Send notification", "Verify", "Use another method", "Send a request"…) until the technician's most recent turn is an affirmative. The refusal tells the model to ask with `pause_queue` and end its turn; the click happens in the NEXT turn. Typing a code is not gated (stored TOTP needs nobody), ordinary clicks are untouched. Policy text: `MFA_HANDSHAKE_POLICY` in `src/server.js`; TOTP_POLICY's "click and wait" line now says ask first. Test: `test/mfa-handshake.test.mjs` (8).
- **"Report what the tool said, not what you think happened"** added to the desktop instructions: an inconclusive result (e.g. a brokered password change returning `OUTCOME UNKNOWN`) must be reported as unknown. TICKET/61884's chat reported a definite password change from an UNKNOWN result.
- **Wording fixed** in the credential-store refusal: `operator_desktop_*` are separate TOOLS, not `helpdesk_call` operations (the model called `helpdesk_call {"operation":"operator_desktop_open_url"}` - a guaranteed failure - because our list ran them together).
- **Operator coordinator (separate repo)**: `DESTRUCTIVE_COMMANDS` in `/opt/pi-ai-operator/coordinator/src/policy/constants.js` matched the bare word `format`, so `Format-Table` was refused as a "delete/format command". Now allows Format-Table/List/Wide/Hex/Custom and still blocks Format-Volume/`format C:`/diskpart. **Takes effect on the next `pi-ai-operator` restart** (that restart drops any live desktop session, so do it when nothing is mid-flow).
- All bridge changes above are live (restart 2026-09-27 ~12:50). Open item from this ticket: the GEI Group `Office365 Admin` credential is dead (rotated by a brokered change whose outcome was UNKNOWN; the stored value now returns AADSTS50126) and needs a human reset; and this tenant's admin rows are MFA-bound, so unattended Exchange work needs the app-only (certificate) setup.

### 15. Desktop operations priced in every chat (owner request)
Provider bills nothing separately for the Operator desktop, and its screenshots never enter the
model's context (`operator_desktop_*` return TEXT - the image goes to the technician's window).
The cost IS the turns it consumes: each desktop action is a model call that re-reads the whole
conversation, and the flaky ones retry. So the meter attributes every model call that REQUESTED an
`operator_*` tool, with that turn's own billed cost.
- `src/cost-meter.js`: desktop bucket (calls, turns, cost, tokens) + `desktop` in `snapshot()`;
  `seedDesktopFromBranch()` seeds it from the transcript a session resumed (the meter is rebuilt
  with the session, so without this a resumed chat reported $0.00 - TICKET/61884 had ~15 actions).
  Seeding does NOT touch session cost, and the desktop figure is NOT added as a `by_role` row
  (the same turn is also a chat turn; a second row would make the roles sum past the total - a
  test asserts they still sum exactly).
- `src/run-cost.js`: every run line gains `· 🖥️ desktop N actions $X (desktop so far $Y — those
  turns keep being re-read)`.
- UI (`PiChat.vue`): the cost popover gains "Desktop actions: N · $X — M turns driving the screen".
  Deployed.
- Tests: `test/cost-meter.test.mjs` now 34 assertions (counting, no double-count, zero case,
  transcript seeding, empty-branch no-op).
- **Measured, all 38 desktop-using chats in `/home/tactical/.pi/agent/sessions`: $155.58 of
  $753.67 = 21% of chat spend went to driving the screen**, worst cases 82%, 75%, 70%, 64% and
  54% of a single chat; the largest single chat spent $72.03 across 651 desktop actions.
- Caveat: after a compaction the dropped turns are no longer in the branch, so the backfill
  cannot see them (they are also no longer re-read, so their cost is historical anyway).

### 16. Per-session chat capability grants (owner request)
The hamburger switches (Write mode, Auto-approve, Auto-credential, Auto-TOTP, customer email) were
gated only by the user's ROLE, with no middle ground: a technician whose role lacked a switch could
not have it for the ONE ticket where an admin decides it is warranted. Now an admin can grant it
for one ticket/device, or everywhere.
- **Django:** model `AISessionCapability` (migration `0133_ai_session_capabilities`) + `core/session_caps.py`
  (`CAPABILITIES`, `active_caps`, `resolve_perms`, `apply_caps`, `grant`, `revoke`); admin-only API
  `ai/session-caps/` (GET/POST/DELETE) in `core/relay.py`; both chat blobs OR the grants in
  (`_apply_session_caps` in core/views.py, `_apply_device_caps` in agents/views.py); `can_grant_caps`
  + `caps_granted` now reach the window. A grant can only ever ADD.
- **Auto-TOTP decoupled** from Auto-credential: the API sends `autototp_allowed`, and the bridge
  honours it (`blob.autototp_allowed`, falling back to auto-credential when absent). So "use the
  stored authenticator code" can be granted without "read any stored password".
- **Bridge:** `POST /pi/grants` (internal) applies a resolved permission set to LIVE sessions
  matching the scope; `hub.applyCaps` updates the `*Allowed` flags and sends a `perms` frame, so the
  technician's hamburger gains the switch without reopening the window. The chat builders' flags
  became `let` for this.
- **UI:** hamburger > **Capabilities (admin)** (admins only): target user (defaults to the current
  driver), the five switches, expiry (1h/4h/24h/until revoked), Apply / Withdraw all. A `perms`
  frame also posts a system note ("An admin enabled X for this session").
- **Verified:** non-admin grant -> 403; grant scoped to one ticket leaves another untouched; a
  `write`+`autototp` grant adds exactly those two flags; revoke removes them. Full bridge suite green.
- Afternoon status: API + UI live; the live-push needs one bridge restart (the guard refused while
  TICKET/61884 was mid-work). Without it, a grant still applies the next time the window opens.

### 17. Global Settings layout + relay roster freshness (owner requests)
- **No more sideways scrolling in Global Settings.** The wide tables in the Pi.dev AI tab were
  stretching the settings pane past the window: `wrap-cells` now folds the text and the secondary
  columns drop away below `xl` (`providerVisible`/`modelVisible` in AISettings.vue,
  `visibleColumns` in AIRelayKeys.vue and AIAgentGroups.vue). Deployed; the browser needs a reload
  to pick up the new bundle.
- **Relay client 1.1.1**: a running pi chat now notices an admin's edit to a group within a minute
  of the next turn, re-registers the roster, and says so in the chat (see PI-RELAY.md). Two bugs
  found by testing it: a 1.1.0 cache had no roster signature (baseline now falls back to the
  in-memory roster), and a note queued by the startup refresh was swallowed when the first turn
  found a fresh cache (the drain now always runs). Verified by asking the model to repeat the note.
- A group's DESCRIPTION change is NOT announced: the relay client does not use descriptions (only
  roles/models/definitions), so there was nothing for it to apply.

### 18. Backup model per agent-group role (owner request)
- **Why:** xAI refused every request for two days (403 credits/monthly-limit, 30 times in the log), and each turn died mid-flight. Retrying the same provider is pure cost.
- **Django:** `AIAgentGroupMember.fallback_provider` / `fallback_model_id` / `fallback_thinking_level` (migration `0134_member_fallback_model`); carried in `public_group`, included in `group_provider_keys`, written by the group serializer, and settable in Settings > AI > Agent Groups ("Backup model if the provider refuses"). Seed specs carry the backup as an optional 6th tuple element.
- **Bridge:** `fallbackMember()` (agent-groups.js); `couldBeAnotherProvider()` + a `fallback` arm in `llm-recovery.js` (`consider()` prefers the backup over a pointless retry, `run()` switches and continues, once per turn via `beginTurn()`); `useFallbackModel()` in server.js wired into both chats' recovery.
- **Configured:** IT + Coding orchestrator -> anthropic/claude-sonnet-5; Coding+ orchestrator -> deepseek/deepseek-flash. Backup: `backups/pi-relay-20260927T112652Z/fallbacks-before.json`.
- **Tests:** `test/agent-fallback.test.mjs` (8). Full suite green.
- **Live:** rmm restarted + UI deployed; the bridge restart was refused by the guard (TICKET/60427 was working) and is PENDING.
- Also: the xAI account has $174.83 remaining, so the 403s were the **monthly spending limit**, not credits — raise that limit in the xAI console or it will trip again.

### 19. The queue hides what is still in flight when the assistant asks something (owner report)
- **Symptom:** a prompt was running, the assistant asked a question (`pause_queue`), and the window stopped showing which prompt it was working on.
- **Cause (UI, not the queue):** the queue panel's status strip is an `if / else-if` chain - `queueQuestions` -> `queuePaused` -> `queueRunningId` - so **"Paused" replaced "Running a queued prompt"**. The data was all in the frame (`running_id` plus the items); the window just stopped showing it. The question card also named the prompt only when the question carried an `item_id`, which a standalone question does not.
- **Fix (PiChat.vue, deployed):** `queueRunningItem` (by `running_id`, falling back to any item with status `running`); the Paused strip now shows *"paused during: <prompt>"*; the question card falls back to the running item for its "about:" line. Verified: the item does stay `running` while paused (queue.js `pause()` does not clear it), so "paused during" is the exact wording - the model has stopped to ask, it is not still working.
- Reload the window to pick up the new bundle.

### 20. xAI removed from everything (owner request)
- **Why:** grok hit its monthly spending limit; every turn on it died mid-flight with a 403. The owner does not want that exposure.
- **Done:** `xai` provider row disabled; grok-4.7 `AIModel` row disabled and un-starred; the starred default is now `deepseek/deepseek-flash` (a row that already existed, pk 18; a headless surface resolves it — `_resolve_ai_model(None)` verified); Coding+ orchestrator+planner moved to deepseek-flash (high/medium) with an Anthropic backup; 14 windows' remembered grok cleared in `sessions/*/*/last-model.json`; `pickCompactionModel` no longer names grok-4.3; seed specs updated (no `xai` members remain).
- **Verified:** `xai` provider disabled · 0 enabled xai model rows · 0 xai group members · every group's key set is anthropic/deepseek/openai · default resolves to deepseek/deepseek-flash · full bridge suite green.
- **Backups:** `backups/pi-relay-20260927T112652Z/xai-removal-before.json` (all model + provider rows) and `xai-window-memory/` (the 14 original last-model.json files).
- **To re-enable grok later:** set the provider row enabled, re-enable the grok-4.7 model row, and point a group member back at it.

### 21. Premature "done" ding, and the queue not naming the work in flight (owner reports)
- **The ding fired on `agent_end`**, which is the end of one model RUN, not of the technician's turn - the bridge continues it (recovery re-run, stall-continue, the authorizer, a queued prompt). So the window rang "finished" while the assistant kept working, and the code even said so in a comment.
  **Fix:** `makeTurnSettler` (server.js) - after `agent_end`, if nothing has started within 2.5s it sends `{type:"turn_settled", waiting_for_you}`; `settler.cancel()` runs on every new prompt. The window now dings on `turn_settled`, and when the settle is a QUESTION it plays the approval bong with "AI Decision needs you" instead of "finished".
- **The queue could not name what was being worked on.** It listed only QUEUED prompts (tracked by `running_id`), so a prompt typed or answered in the CHAT had no item and the panel showed nothing; and the running line said "Running a queued prompt" without naming it.
  **Fix:** `queue.noteRun(text, origin)` records every run in flight (called from `runPrompt`, either chat) and publishes `working_on` when no item owns it; the status strip now reads `Working on: <the prompt>` in both cases.
- UI deployed. **Bridge restart PENDING** (the guard refused repeatedly - TICKET/60427 was working); both halves above need it.

<!-- CHANGES-BELOW -->

## Full rollback (everything in this file)

```bash
B=/home/tactical/backups/context-trim-20260927T104508Z
# 1. bridge code
sudo systemctl stop pi-trmm-bridge
rm -rf /opt/pi-trmm-bridge/src && cp -a $B/bridge-src /opt/pi-trmm-bridge/src
sudo systemctl start pi-trmm-bridge
# 2. admin prompts
cd /rmm/api/tacticalrmm && /rmm/api/env/bin/python -c "
import os,django,json;os.environ.setdefault('DJANGO_SETTINGS_MODULE','tacticalrmm.settings');django.setup()
from core.models import CoreSettings;c=CoreSettings.objects.first()
for k,v in json.load(open('$B/coresettings-prompts.json')).items(): setattr(c,k,v)
c.save()"
# 3. group rename: see change 0
```
Restarting the bridge drops live chat sockets (windows reconnect and resume from their session file).
