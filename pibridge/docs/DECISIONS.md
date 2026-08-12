# Open questions to decide before building

Updated after studying the Remote Proxy feature + your requirements. Your prior
answers are recorded; remaining items need a call.

## Already decided (from you)
- **Approval**: my call → **ON by default**, with a per-session "auto-approve"
  toggle available only to roles granted `can_use_ai_autoapprove`. (§7 of DESIGN)
- **Sending device data / logs to the LLM provider**: accepted and expected.
- **Chat history**: persist **per device**, shown under a new device
  **"AI History"** tab, resumable (continue after dropped connection). (§8)
- **API keys / models in settings**: global settings hold provider API keys +
  a model catalog; a default model; and which models are accessible — with model
  access **dependent on role/group** on top of the `can_use_ai` module permission.
  (§4)
- **Reverse proxy**: mirror the Remote Proxy nginx pattern (token path + async
  upstream), pointing `/pi/` at the Node bridge. (§1c)

## Still to decide
1. **Where the bridge gets provider API keys.** Options:
   - (a) Bridge reads a root-only secrets file that Django writes when an admin
     saves `AIProvider` keys (keys never touch the browser or redis token). **[suggested]**
   - (b) Django puts the needed key (encrypted) into the redis session blob; bridge decrypts with a shared secret.
   Pick one. (a) is cleaner/safer.

2. **Providers to support at launch** — Anthropic + OpenAI first? Add Google/xAI/
   OpenRouter/custom-base-url later? (Catalog model supports all; just scope UI.)
   **[suggested: Anthropic + OpenAI + custom base_url]**

3. **Do we reuse the existing `CoreSettings.open_ai_token`** (currently powering
   the script-writer AI) or leave it alone and add the new `AIProvider` table
   independently? **[suggested: leave open_ai_token as-is, add new tables]**

4. **Default when a role has `can_use_ai` but no models selected** — allow only the
   global default model, or deny until admin assigns models? **[suggested: allow global default only]**

5. **AI History exposure** — Django proxies the bridge's session index (auth
   enforced by Django), or bridge writes an index Django reads directly from
   `~/.pi-trmm/sessions/`? **[suggested: bridge exposes /pi/history, Django proxies with PiPerms]**

6. **Model picker in the chat window** — let the operator switch among their
   allowed models mid-session, or fix the model at window open? **[suggested: picker limited to allowed models]**

7. **History retention** — keep chats forever, or auto-purge after N days? Who can
   delete a device's AI history (needs `can_use_ai` or a manage perm)? **[suggested: keep 90 days, delete needs can_edit_agent]**

8. **Concurrency / cost** — max simultaneous chats (suggested 5), idle timeout
   (suggested 30 min), optional monthly spend cap per provider shown in settings?

9. **Access exposure path** — reuse `api.blueuc.com/pi/` (suggested, reuses cert +
   server block like `/agentproxy/`) vs a new subdomain.

10. **Server read tool** — give pi a read-only `read` limited to its per-device
    scratch dir (for analyzing large saved outputs)? **[suggested: yes, scratch only]**

## 2026-08-04 — Tool-result caps, no-silent-stop, and the AI cost meter

**Trigger.** Pi Chat on agent `AVgiDUib…` (session `019fcc9e…`) "randomly stopped" with no
error. It did not crash: the model fired 7 tools in one parallel batch which returned
**1.76 MB of JSON** (2× 7-day `get_event_logs` = 750 KB + 694 KB; `get_device_details` =
247 KB, of which `services` 124 KB + `wmi_detail` 62 KB + `all_timezones` 10 KB were 80%).
That pushed **~609k tokens into a 200k context window**, so the assistant message ended on
`stopReason:"length"` after 16 output tokens — **$7.52 for one message**, no answer.
Nothing reached the browser because `server.js` only surfaced `stopReason === "error"`.

**Decisions.**

1. **Tool output is capped, not trusted.** `capString`/`capJson` in `tools.js`
   (`PI_MAX_TOOL_RESULT_BYTES`, default 60 KB). Arrays truncate element-wise so the model
   always gets valid JSON plus "showing X of Y". Applied to `get_device_details`
   (bulk `services`/`wmi_detail`/`all_timezones` replaced with `services_summary` +
   `_omitted_for_context`), `get_event_logs` (ERROR/CRITICAL/WARNING by default —
   `include_info` to opt in — plus `source_contains`, `max_entries`, per-message trim),
   `list_processes` (ranked by CPU then memory, top 40), `list_software` (name/version/
   publisher, `name_contains`), `get_checks`, `get_tasks`, and `run_command_on_device`.
   Measured on the real turn: **1.76 MB → 101 KB (94% less; ~440k → ~25k tokens)**.
2. **A turn that produces no answer must say so.** `silentStopMessage()` in the new
   `cost-meter.js`: `length` explains the cause and the fix, unknown stop reasons are
   reported rather than swallowed, operator aborts stay silent. Wired into both the device
   and decision surfaces.
3. **Spend is visible while it happens.** `makeCostMeter()` accumulates cost/tokens per
   turn and pushes `cost_update`; warns at `PI_TURN_COST_WARN` ($1/turn),
   `PI_SESSION_COST_WARN` ($5/session, once per band) and `PI_CONTEXT_WARN_FRACTION`
   (80% of context — the early signal for `length`). Warnings are **always logged**
   server-side and only pushed to operators allowed to see cost.
4. **Cost visibility is its own permission.** New `Role.can_view_ai_cost`
   (migration `accounts/0047`), default **False**, superusers always. Resolved in the RMM
   and passed as `cost_visible` in the session blob; the bridge sends no cost frames at all
   when it is false, so spend cannot be inferred from traffic. It is a *visibility*
   permission — it grants no AI capability.

**Note on trees.** `/rmm` (live) and `/home/tactical/tacticalrmm` (source) had already
diverged in `agents/views.py` / `core/views.py`; the same edits were applied to both rather
than copying files over.

**Tests.** `bridge/test/tool-caps.test.mjs` replays the actual 1.76 MB turn from the session
`.jsonl`; `bridge/test/cost-meter.test.mjs` drives the meter with the real `$7.51763 /
608,918-token` usage block. `npm test` in the bridge runs both.

---

## 2026-08-12 — Hardware/asset facts for offline devices (`get_device_hardware`)

**The gap.** A helpdesk/report run could not state a device's **serial number**, and had no
make/model for anything it could not log into. Every hardware-bearing path required
something the surface did not have:

| path | why it failed |
|---|---|
| `run_command_on_device` (WMI/`Get-CimInstance`) | needs the device **ONLINE** — 564 of 1182 agents are not |
| `get_device_details` (`GET /agents/<id>/`) | device sessions only, **and** TRMM's `AgentSerializer` omits `serial_number` (it declares `make_model` but not `serial_number`) |
| `find_devices` (`POST /core/ai/resolve-devices/`) | `_agent_dict()` returns identity only — no hardware — and caps candidates at 50 |
| RMM UI *Hardware* tab | a human, not an API |

**The finding.** TRMM already has the data, stored: `Agent.wmi_detail` (JSONField) with
`serial_number` / `make_model` properties on top, exposed on the **agent LIST** endpoint via
`AgentTableSerializer`. Measured 2026-08-12: `GET /agents/` → **1182 rows, 1.31 MB, 1.44 s**,
**1085 with a serial**, including agents last seen in **2024**. The bridge's existing service
key already has permission (`/clients/` is 403 for it; `/agents/` and `/agents/?client=` are not).

**Decision: no backend patch.** The fix is bridge-only — `trmm.listAgents()` plus one
read-only tool, `get_device_hardware`, registered on the **device**, **triage** and
**decision-chat (ai-decision)** surfaces. Rejected: fattening `_agent_dict` in
`core/views.py::AIResolveDevices`, because (a) `find_devices` output enters the model context
on *every* ticket, and (b) its queryset uses `.only(...)` without `wmi_detail`, so reading a
serial there costs one deferred query **per agent** and ~45 KB/agent of hidden I/O
(fleet-wide ≈ 53 MB).

**Design points.**
1. **Filters, not dumps**: `client_name` (case-insensitive substring), `hostname_contains`,
   `agent_ids`, `only_missing_serial` — the last one isolates the devices that genuinely need
   a live query (164 fleet-wide), which is the only case where WMI is still the answer.
2. **Rows slimmed in the bridge**: the 1.3 MB fleet payload never reaches a model; ~12 fields
   per device survive (~180–380 B/row).
3. **Paged, never truncated**: the page is fitted to `MAX_TOOL_RESULT_BYTES` by dropping whole
   **rows**, measured exactly as `capJson` will serialise it, and reports `showing` +
   `next_offset`. A 603-device client returns 121 valid rows and a cursor.
4. **Placeholders are `null`**: `unknown`, `error getting make/model`, `To Be Filled By
   O.E.M.`, `Default string`, `System Serial Number`, all-zeros. A model must never hand a
   customer OEM filler as an asset tag.
5. **`source` is stated in the payload** (“stored hardware details; may be as old as
   `last_seen`”) so stale inventory is never presented as a live read.
6. **60 s fleet cache** — a chat asking several inventory questions costs one HTTP call.

**Also fixed here.** `find_devices` returned `JSON.stringify(out).slice(0, 20000)` on both the
triage and decision surfaces — a raw byte slice that cut JSON **mid-token** and handed the
model unparseable text with no indication anything was missing. Now `capJson`.

**Serializer gap closed (same day).** `serial_number = serializers.ReadOnlyField()` added to
`agents/serializers.py::AgentSerializer` in **both trees** (`/rmm` live and
`/home/tactical/tacticalrmm` source — they are byte-identical for this file). It was declared
on `AgentTableSerializer` but not here, which is why the agent DETAIL endpoint — and therefore
`get_device_details` — could report a machine's make and model but never its serial.
`rmm.service` restarted; verified live: `GET /agents/<id>/` → `serial: 'PF4V…' (redacted)`,
`make_model: 'LENOVO ThinkPad X1 Yoga Gen 8'`. `shapeAgentDetails()` in the bridge now applies
the same placeholder rule to `serial_number`/`make_model`, so a device session sees `null`
rather than the literal `unknown` a QEMU/Linux guest reports.

**Tests.** `bridge/test/device-hardware.test.mjs` stubs `fetch` with a 605-agent fleet and
pins: registration on decision + triage, serial for an **offline** device, placeholder→null,
`only_missing_serial`, clean paging under the cap with a non-overlapping `next_offset`,
`known_clients` on a miss, and the cache (1 HTTP call for 9 queries). Added to `npm test`.

**Deploy.** `src/tools.js` + `src/trmm.js` copied to `/opt/pi-trmm-bridge` and the service
restarted; backup `deploy-backups/pi-trmm-bridge-pre-device-hardware-20260812T142220.tar.gz`.

**Repo drift back-ported (same day).** `bridge/src` in this repo was not merely behind on
`server.js` — it was **not runnable**: five modules that `server.js` imports existed only in
`/opt/pi-trmm-bridge` (`odoo-chat.js`, `pi-runtime.js`, `models-catalog.js`,
`live-presence.js`, `verifier-runtime.js`), and `config.js`, `helpdesk-runtime.js`
(`opClasses`) and `operator-tools.js` (Mesh Take-Control desktop path replacing the Edge-only
prompt) were all older than production. Anyone deploying the repo copy would have crashed on
import or silently reverted the `opClasses` capability tags, the spend-ledger error logging and
the `kind === "odoo"` surface route.

Production was authoritative in **every** differing file, so the repo was synced *from*
`/opt/pi-trmm-bridge` (backup `deploy-backups/pi-trmm-integration-repo-src-pre-backport-20260812T142535.tar.gz`),
excluding `*.bak` and keeping `sales.js.example` (repo-only). `package.json` now pins the
installed `@earendil-works/pi-coding-agent ^0.84.1` (was `^0.83.0`). Verified: every `src/*.js`
is byte-identical to production, all files parse, and every relative import resolves inside
`src/`. `npm test` = 44 assertions green in both trees.

**Rule going forward:** `/opt/pi-trmm-bridge` is the deploy target, **not** the place to edit.
Change `bridge/src`, run `npm test`, then copy forward — otherwise the next drift is silent.

---

## 2026-08-12 (later) — One git home per artefact, and the drift that hid in the gaps

Asked to "make sure everything is pushed to GitHub so we are in sync". What that turned up
was not a push backlog but **four different ways for code to exist without git**:

| where it lived | what was wrong |
|---|---|
| `/opt/pi-trmm-bridge` | de-facto source of truth; five modules `server.js` imports existed **only** here |
| `~/pi-trmm-integration/` | **no git at all** — the bridge, the docs, `tools/ticket_report.py` |
| `~/tacticalrmm` | second checkout, 78 commits behind live, 27 uncommitted files incl. a **renumbered duplicate migration** (`0098` here = `0099` live) |
| `~/pi-ai-operator` | 21 commits, **no remote** — the whole history existed on one disk |
| `~/tacticalrmm-web` | 13 commits never pushed (branding + AI UI) |
| `~/pi-ai-helpdesk` | 8 commits + 4 modified docs never pushed |

**Decision: the branch that runs is the branch that is tracked.** `/rmm` on
`feature/remote-proxy-v1.5.2` is what serves production, so `pibridge/` now lives *there*,
byte-identical to `/opt/pi-trmm-bridge`, with `install.sh`/`update.sh` calling
`pibridge/setup.sh`. Rejected: pushing the bridge to `feature/pi-ai-assistant`, where it
already existed — that branch is 78 commits behind, so the newest bridge would have sat
next to five-week-old backend code.

**Decision: visibility decides the home, per file.** `teknoprep/tacticalrmm` is a **public**
fork (verified via the API, not assumed), so it takes only code and sanitised engineering
docs. Six documents moved to the **private** `teknoprep/pi-ai-helpdesk` under `internal/`:
the capability and outcome reports, the customer-reply standard plus the verbatim customer
reply it was drawn from (named customer server, Sage 100 / MAS_FBI), and two deliberately
unsanitised issue records. `tools/ticket_report.example.json` went with them — it names
staff and a departing employee. One real device serial was scrubbed out of this file before
it was published.

**Decision: a superseded tree gets a snapshot, not a merge.** `~/tacticalrmm`'s 27
uncommitted files are an older duplicate of work already committed in `/rmm`; committing
them onto the fork branch would have forked the migration graph. They are preserved on
`snapshot/secondary-tree-2026-08-12` — off-box, honest about being stale.

`~/pi-ai-operator` got a **private** remote (desktop control code); 21 commits and both
branches pushed. Everything on the host is now committed, pushed, and tracking an upstream.

**Left as a risk, not fixed here:** the GitHub PAT sits in plaintext in
`/tmp/pr-backend/.git/config` and `/tmp/pr-web/.git/config` (scope `repo, workflow,
read:org`) — the `UPGRADE-RUNBOOK.md` gap list already flagged it. It was the only push
credential on the box. **Rotate it and move these clones to SSH.**
