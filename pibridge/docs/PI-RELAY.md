# pi relay — use the RMM's agent groups from any pi

Built 2026-09-27 (owner: chris). Change log + rollback: `CONTEXT-TRIM-ROLLBACK.md` §8.

```
pi on a laptop / server ── HTTPS, Basic(username, relay key) ──► nginx api.blueuc.com /pi/relay/v1/
   (rmm-relay extension)                                             │  rate limit 10 r/s/IP, 32 MB body
                                                                     ▼
                                          bridge src/relay.js ── verify ──► Django core/relay.py
                                             │   (cached 30s)      (bridge API key + 512-bit internal secret)
                                             ▼
                          bridge pi runtime (RMM provider keys) ──► DeepSeek / Anthropic / OpenAI / …
                                             │
                                             └──► spend ledger (surface "relay", actor = RMM user)
```

- **The client** is a pi extension. It registers provider `rmm` with one model per group role: `rmm/<group>` = the orchestrator, `rmm/<group>/<role>` = a specialist. Its `streamSimple` sends pi's own request (transcript + options) to the relay and replays pi's own events back. Because pi runs on both ends, nothing is translated: DeepSeek reasoning, Anthropic caching and thinking levels behave exactly as in the RMM's chats.
- **Tools run on the client.** `read`, `bash`, `edit` and so on execute on the user's machine. The relay only runs model calls.
- **Delegation runs on the client too.** The extension's `delegate` tool starts a separate `pi` process for a specialist on `rmm/<group>/<role>`, with read-only tools (plus `edit`/`write`/`bash` for `coder`) and the RMM role definition as extra system prompt. Its cost is reported back to the parent chat.
- **Group config lives in the RMM.** Change a role's model in Settings → AI → Agent Groups and every relay client follows on its next `/rmm-status` or restart (the server side changes immediately).

## Credentials

- **One key = one RMM user + one or more agent groups** (2026-09-27). A technician signs in once and switches groups with `/group <slug>`. A user can also hold several keys.
- **Sign-in is HTTP Basic:** RMM username **or** email, plus the key (`pirk_<12-char id>_<48-char secret>`, about 290 bits of randomness).
- **Stored as HMAC-SHA256 only**, peppered with `PI_RELAY_KEY_PEPPER`. The full key is shown once, at creation.
- **A key stops working within 30s** (the verify cache) when it is revoked or expires, the user is disabled or loses **Use AI**, the AI module or ALL of its groups are disabled, the caller's IP isn't in the key's allowlist (if one is set), or the key's daily/monthly USD budget is used up. **The budget is per key, across all its groups.** Budgets are computed from the spend ledger (session ids `relay-<key_id>-…`) in the RMM's time zone. A single disabled group is dropped from the key while its other groups keep working.
- **Failed sign-ins all get the same 401**, so there's no clue which part was wrong. An IP with 20 failures in 15 minutes is locked out for 15 minutes (bridge). nginx rate-limits every IP to 10 requests/second (burst 40).
- **The client controls none of these:** provider keys, headers, base URLs, or which model a role uses. Thinking level is capped at the role's setting in the RMM; the client may ask for less, never more.
- **Per-key concurrency cap:** 6 streams at once (`PI_RELAY_MAX_CONCURRENT`).

### Secrets (both 512-bit, generated 2026-09-27)
| name | where | what breaks if it leaks | rotate |
|---|---|---|---|
| `PI_RELAY_INTERNAL_SECRET` | `/rmm/api/tacticalrmm/tacticalrmm/local_settings.py` (chmod 640) **and** `/etc/pi-trmm-bridge.env` (root 600) | half of the lock on `/core/ai/relay/verify/` (the other half is the bridge's TRMM API key) — that endpoint returns provider keys | new value in both files → `systemctl restart rmm pi-trmm-bridge` (check no chat is mid-task first: see "Restarting") |
| `PI_RELAY_KEY_PEPPER` | `local_settings.py` | nothing on its own (stored hashes are useless without it) | changing it **invalidates every relay key** |

## Managing keys
- **UI:** Settings → AI → **pi Relay Keys**. **New key** (user, **one or more groups**, label, budget or **Unlimited**, expiry, IPs, and "email the key + instructions now"), **Edit** (label, groups, budget/Unlimited, expiry, IPs), **Send Pi RMM install** (emails a NEW key plus setup instructions - it ROTATES the secret, so a machine already signed in must run `/rmm-login` again), **Revoke**, and **Delete** on a revoked row (permanent). A **Show revoked** toggle reveals revoked keys.
- **Who can do what:** anyone with *Use AI* can issue their own key **with a budget** and edit its label/IPs. Only *Edit Core Settings* (admins) can issue keys for other users, set **Unlimited**, change budget/expiry/**groups**, or delete a key permanently, so a user can't lift their own cap or widen their own access. Not ticking Unlimited requires a daily and/or monthly budget.
- **Shell:**
  ```bash
  cd /rmm/api/tacticalrmm
  /rmm/api/env/bin/python manage.py relay_keys create --user <technician>@<your-domain> --group coding --label "Sean laptop" --daily 10 --monthly 100 [--expires-days 90] [--ips 1.2.3.4]
  /rmm/api/env/bin/python manage.py relay_keys create --user <technician>@<your-domain> --groups coding,it --unlimited
  /rmm/api/env/bin/python manage.py relay_keys set <key_id> --daily 20 --monthly none   # or --unlimited, --expires-days 90|never, --ips ...|none, --label ..., --groups coding,it
  /rmm/api/env/bin/python manage.py relay_keys delete <key_id>       # permanent (revoke first, or --force)
  /rmm/api/env/bin/python manage.py relay_keys list
  /rmm/api/env/bin/python manage.py relay_keys revoke <key_id>
  ```
- **API** (logged-in RMM session): `GET/POST /core/ai/relay/keys/` (create takes `group_ids: []`), `PATCH /core/ai/relay/keys/<pk>/` (label, allowed_ips, budgets, expiry, groups), `DELETE /core/ai/relay/keys/<pk>/` (revoke), `DELETE …?purge=1` (permanent; admin; revoked only), `POST /core/ai/relay/keys/<pk>/send-install/` (email a new secret + instructions).

### Revoked keys
A revoked key is **kept**: it is the record of who had access and its spend history points at it. Nothing is deleted automatically. To remove one for good, use **Delete** on its row (revoke first), `relay_keys delete <key_id>`, or `DELETE ?purge=1`. The spend rows stay, attributed by username.

## Installing the client
Linux / macOS:
```bash
curl -fsSL https://api.blueuc.com/pi/relay/v1/client/install.sh | bash
```
Windows (PowerShell): `irm https://api.blueuc.com/pi/relay/v1/client/install.ps1 | iex` (pi on Windows also needs Git for Windows).

Then in pi:
```
/rmm-login            RMM username or email + the key (the relay URL is only asked for as /rmm-login <url>)
/group coding         this chat now runs on the group's orchestrator
/rmm-status           groups, roles, today's and this month's spend
/rmm-logout [group]
```
The config lives in `~/.pi/agent/rmm-relay.json` (mode 600). For headless use, set `PI_RMM_RELAY_URL`, `PI_RMM_RELAY_USER` and `PI_RMM_RELAY_KEY` instead. The machine needs **no provider API keys**.

On this server: `~/.pi/agent/extensions/rmm-relay/index.ts` is a symlink to `/opt/pi-trmm-bridge/relay-client/index.ts`, with key `pirk_oEvT3TFewQ3r` (chris, Coding, **unlimited** since 2026-09-27 11:5x - the $5/$50 test cap was removed at the owner's request). Installed with install.sh, so it is a copy: re-run the installer after changing `relay-client/index.ts`.

## When an admin edits a group, who finds out?

| surface | when it picks up the change |
|---|---|
| **pi via `/rmm-login`** (the relay) | **Within a minute of the next turn**, and the chat is told: *"RMM agent group \"IT\" was changed in the RMM: scout thinking low → high. That applies from now on."* The client re-reads the roster before a turn when what it holds is older than 60s (one HTTP call per minute at most), re-registers the models and the `delegate` roster, and injects that note so the model stops using the old roster. Failures are ignored - an unreachable relay never blocks work, the cached roster still works. |
| pi at startup / `/new` | `session_start` refreshes, and reports any pending change notice. |
| `/rmm-status` or `/rmm-login` | Refreshes immediately. |
| the RMM's OWN chat windows (bridge) | On reconnect: the window re-attaches and the blob's roster is refreshed. An ALREADY-OPEN window keeps the roster it started with until it reconnects or the group is re-picked in the window's picker. |

The first version of the relay client only refreshed at session start, so an open chat kept
delegating to a role that had moved model (or been removed) for as long as the session lived.
Client **1.1.1** fixed that. Two traps found while testing it: a cache written by 1.1.0 has no
roster signature to compare against (the in-memory roster is used as the baseline instead), and a
note queued by the STARTUP refresh was being swallowed when the next turn found a fresh cache (the
drain now happens regardless).

## Protocol (v2)
- `GET  /pi/relay/v1/health`: public, returns `{ok, protocol}`
- `GET  /pi/relay/v1/client/index.ts`, `/client/install.sh`: public (no secrets in them)
- `GET  /pi/relay/v1/whoami`: auth. Returns the user, the key (budgets + spend) and **`groups: [...]`** - every group the key reaches, each with its roles, each role's model metadata (context, output limit, cost, thinking map) and its specialist instructions. Provider keys are never included.
- `POST /pi/relay/v1/stream`: auth. Body: `{protocol: 2, group, role, context: {messages}, options: {reasoning, maxTokens, temperature, cacheRetention, toolChoice, sessionId}}`. `group` is the slug; a key reaching exactly one group may omit it. A v1 client (extension 1.0.x) gets a 400 telling the user to re-run the installer. The response is NDJSON: `relay_start`, then pi `AssistantMessageEvent`s (`text_delta` and `thinking_delta` without `partial`; the client rebuilds it), `relay_ping` every 15s of silence, and finally `relay_end` (or `relay_error`).
- A protocol mismatch returns 400 telling the user to update the extension. pi 0.86 (client) ↔ 0.87 (bridge) is verified compatible: only model metadata differs between them.

## Tests
- `test/relay.test.mjs`: 12 tests with a real HTTP server, the real handler, pi's faux provider, and an injected verify/ledger. Covers auth, lockout, whoami, streaming, tool calls, role routing, the thinking cap, option whitelisting, budget messages and caching. It's part of `npm test`.
- Django `verify()`: 11 checks were run at build time (valid, email-as-user, wrong user, tampered key, malformed, hash-only storage, IP allowlist, budget, expired, revoked).
- Live, 2026-09-27, from this server's pi 0.86.1 through the public URL: plain reply, a tool round-trip with DeepSeek reasoning, delegation to scout (Claude Haiku), and ONE key reaching both groups (`/group coding`, `/group it`). Every call landed in the ledger as `relay`/`chris`.
- Django: 14 checks on multi-group create/edit, narrowing groups, admin-only group/budget changes, revoke-then-purge, and verify() dropping a disabled group.

## Restarting (lesson from the build)
`/pi/busy` and `/pi/live` can say a chat is idle **between tool steps**. On 2026-09-27 a restart caught TICKET/60427 mid-task. Before restarting the bridge, also check the log for recent activity:
```bash
sudo awk -v t="$(date -u -d '-3 min' +%Y-%m-%dT%H:%M)" '$1 >= t' /var/log/pi-trmm-bridge.log | grep -E "tool>|tool<|judge" | tail
```

## Source drift
The relay was written in `/opt/pi-trmm-bridge` (live), like everything else since `/rmm/pibridge` went stale on 2026-09-22 (see the READ FIRST section in `CONTEXT-TRIM-ROLLBACK.md`). New files: `src/relay.js`, `relay-client/index.ts`, `relay-client/install.sh`, `test/relay.test.mjs`, this doc.
