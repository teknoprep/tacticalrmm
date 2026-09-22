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

## 2026-09-09 — A window that reopens continues its conversation

**Decision: for a device chat, "no session named" means CONTINUE, not START.** A refresh, a
socket the bridge closed as idle, and a model or agent-group switch all reopen the window
with no session id. Each used to mint a new session, so the transcript came back empty and
the model came back with an empty context — while the window still looked like the same
conversation. That is the worse failure of the two available: the technician cannot see that
the assistant has forgotten. The ticket chat has always resumed the latest session for its
ticket; the device chat now does the same, keyed on the agent.

**What may be picked up unasked is narrow, because guessing wrong here shows one technician
another's work.** `history.latestResumable()` requires: the caller's own last session, the
same window shape (a multi-machine chat is not a single-machine chat), a transcript file that
still exists, and activity newer than `AUTO_RESUME_MAX_AGE_MS` — 12h by default, chosen so an
interrupted working day continues and next week's job about the same server starts clean.
Nothing about this widens access: the session blob is still minted per caller by Django, and
the conversation resumed is one that same person was already in.

**Starting fresh stays a click, and it is explicit on the wire.** "New chat" and AI Resolve
send `new_session`; the API passes it through, and the bridge skips resumption when it is set.
Making a fresh start the *default* is what caused this, so the default moved and the deliberate
case became the flag — not the other way round.

**The window says so, once.** History appearing unannounced is as confusing as history that
vanished, and the note names New chat as the way out. While adding it: the existing
"opened like this" notes (`Resumed on <model>`, restored switches, Operator availability) were
being pushed into the transcript array *before* history hydration replaced that array — built,
discarded, and never seen by anyone since they shipped. They are appended after hydration now.

Issue record: `pi-ai-helpdesk/ISSUES.md` **I38**. Tests: `test/history-resume.test.mjs`.

## 2026-09-14 — Attachments in the device chat: nothing is ever silently dropped

**Decision: the composer accepts files, and the bridge decides what a model can actually
read.** A technician's evidence arrives as a screenshot of an error dialog or a log extract,
and until now the only way to get either in front of the model was to retype or paste it —
which mangles formatting and cannot carry an image at all. The paperclip, drag-and-drop and
Ctrl+V of a clipboard image all end in the same frame: `{type:"prompt", message, attachments:
[{name, mime, data(base64)}]}`.

**Two destinations, chosen by content, not by trust in the browser's mime type.** Images
become `ImageContent` blocks on the turn (the same path a phone photo already used). Text-ish
files are inlined into the prompt between `[[pi-attachment:name|bytes]]` … `[[/pi-attachment]]`
sentinels. Chrome reports `application/octet-stream` for exactly the files techs attach (.log,
.ps1, .conf), so `src/attachments.js` sniffs the bytes (NUL / non-printable ratio) instead of
believing the header, and a file body can never forge a closing sentinel.

**A refused attachment is named, with a reason, in the transcript.** This is the whole point of
the module: a silently dropped file is indistinguishable from a model that read it and said
nothing, and the technician then argues with an answer based on evidence the model never saw.
Images on a text-only model, PDFs, binaries, oversize and over-count all come back as
`attachments_rejected` and render as a system line next to the message they belonged to.

**Vision is a property of the CURRENT model, and the operator switches models mid-chat.** The
`ready` frame carries `attachments.images_supported` and `model_changed` re-states it, so the
composer stops offering screenshots the moment the model cannot read them — and already-staged
images are dropped with a note rather than uploaded and rejected a turn later.

**Limits exist because an inlined file is re-charged on every later turn.** 5 files, 8 MB each,
20 MB per message, 200 KB of text per file (truncated with a visible notice, never dropped).
The browser also downscales images to 1600px on the long edge before sending: a 4K screenshot
of a dialog costs a multiple of the tokens and reads no better.

Tests: `test/attachments.test.mjs`. Frontend: `src/views/PiChat.vue` (composer, chips,
thumbnail preview, transcript re-hydration strips inlined bodies back into chips).

## 2026-09-14 (later) — Every dollar is recorded, and the record outlives the chat

**Decision: a surface no longer opts IN to accounting.** `AISpendEntry` was created on
2026-08-04 precisely because spend that lived only in the bridge's session `.jsonl` files was
unattributable and was DELETED with the chat — but only three surfaces were ever wired to it
(device chat, ticket chat, Odoo), each with its own copy of the same fire-and-forget POST.
Measured today across 2,634 transcripts holding $1,345: **2,307 sessions worth $527 had no
ledger row at all, and 75 more were partially recorded — a further $239.** Scheduled AI tasks,
ticket triage, auto-resolve, procedure mining, report compilation, the report summariser and
the settings assistants were all billing real money and writing nothing anywhere. Agent-group
specialists were worse than untracked: they run in a temp directory that is deleted when they
finish, so their spend left no trace even on disk. Every one of them now calls
`attachSpendLedger(session, ctx)` on the line after `createAgentSession()` (`spend-ledger.js`),
which is also the single implementation of the POST the three chats used to hand-roll.

**Delegated work is billed to the conversation that ordered it, under a derived id.** A
specialist cannot share the parent's `session_id`: rows are idempotent on
`(session_id, turn_index)` and a specialist counts turns from 1, so it would collide with the
parent's first turns and the charge would be silently swallowed as a retry. Rows are written as
`<parent>-g<n>`, and `core.models.session_scope_q()` is the one place that knows it — so "what
did this chat cost" includes the specialists it paid for, which is exactly when the figure
would otherwise understate the bill (delegation is how an expensive model gets used).

**A failed write is owed, not forgotten.** The POST was fire-and-forget: if the API was
restarting, the money was gone. Five turns were lost that way during this change, in a
90-second window. Failed rows now go to an on-disk outbox (`spend-outbox.jsonl`) and are
retried every 60s until the API takes them; retries are safe because the ledger is idempotent.
This matters most where there is no fallback: unattended sessions are in-memory, so a lost POST
there is money nothing could ever reconstruct.

**Three lines of defence, because bookkeeping that depends on nothing going wrong is not
bookkeeping.** (1) the live POST, (2) the retry outbox, (3) `manage.py backfill_ai_spend`,
run nightly by `core.tasks.reconcile_ai_spend`, which diffs every transcript against the
ledger. The diff is by MULTISET of (cost, input, output, cacheRead, cacheWrite) and never by
position: on a sample of partially-recorded sessions the recorded rows were sometimes the
leading turns and sometimes an arbitrary subset (a POST that failed mid-chat), so "take the
first n" would both double-charge and miss turns. Turns newer than 30 minutes and sessions
that billed in that window are skipped — a live turn is in the transcript before its POST
lands, and recovering it would race the live write. The one-off recovery run wrote **13,302
rows worth $766.00**; the ledger now holds $1,389.56 and a re-run finds nothing.

**Recovered rows are labelled.** `backfilled=True` marks money found in a transcript rather
than posted by the surface that spent it: it is real and belongs in every total, but its
attribution is only as good as the file allowed (no actor for unindexed sessions, surface
inferred from where the index lived). A bill may say so; it must not pretend the two are the
same fact.

**And the record is visible where the chat is.** AI History shows each conversation's cost
from the ledger — never from the transcript — and a conversation whose transcript has been
deleted still appears, marked `transcript deleted`, with what it spent. Deleting a chat used
to erase the evidence of its cost; that was the hole the ledger existed to close, and it is
now closed at both ends.

Code: `pibridge/src/spend-ledger.js`, `agent-groups.js`, `server.js`;
`core/models.py` (`session_scope_q`, `session_spend_map`, `backfilled`, new surfaces),
`core/management/commands/backfill_ai_spend.py`, `core.tasks.reconcile_ai_spend`,
`agents/views.py::AgentPiHistory`, `core/views.py::AIHistoryScope`,
`tacticalrmm-web/src/components/agents/AIHistoryTab.vue`.
Tests: `pibridge/test/spend-ledger.test.mjs`.

## 2026-09-14 (later still) — An AI task's schedule names the clock it runs on

**Decision: a wall-clock schedule belongs to the DEVICE's timezone, and the UI never shows
a time without saying whose.** "Daily at 03:00" was localised with Django's `TIME_ZONE`
(UTC on this install) while the tasks table displayed a bare `03:00` and the editor said
only "(server time)". So a maintenance window authored for a customer fired at 04:00 in
London through the summer, or 23:00 the previous evening on the US east coast — and
nothing on screen said so. That is how a disruptive check lands in the middle of a
working day.

**`AITask.schedule_timezone`, blank meaning "follow the device".** `effective_timezone`
resolves it once — explicit zone, else `agent.timezone`, else the global default — and the
SAME resolver feeds both the scheduler and the serializer, so what the operator reads is by
construction the clock the task really runs on. Blank is the default for new tasks because
a window agreed with a customer belongs to their site, not to the server that dispatches
it; pinning a zone is for work tied to a business process rather than a place.

**Existing tasks were pinned to UTC by the migration, not migrated to the new default.**
Applying "follow the device" retroactively would have moved every existing window by hours
(these devices inherit `America/New_York` from Global Settings) on schedules customers had
already agreed to. The old meaning is written down explicitly instead — nothing moved the
day this shipped, and each task can be re-pointed deliberately.

**DST is handled by keeping the LOCAL hour, not the UTC one.** `zoneinfo` arithmetic on the
target zone means 03:00 stays 03:00 across a clock change and the UTC instant moves, which
is what "overnight" means to the customer. An unknown/typo'd zone falls back to the old
behaviour rather than leaving a task that can never run again.

**Display: one picker, defaulting to the device.** The AI Tasks header has a "Times shown
in" selector — *Device timezone* (per row, so a client/site view renders each machine on its
own clock), the zones actually in use, the browser's, UTC, and the full IANA list. Next run,
last run and one-shot times are absolute instants, so they are correct in any zone; the
schedule cell carries a badge naming the zone its wall clock is authored in, and the tooltip
shows the same instant in the device zone and UTC. A "Next run" column was added — the table
previously showed when a task last ran but never when it would run again.

**And it says when the answer is a guess.** No agent on this install has a timezone set, so
"the client's timezone" is really the Global Settings default for all 1,179 of them. The
picker says so and points at where to fix it, rather than presenting an inherited default as
if it were the customer's own clock.

Code: `core/models.py` (`schedule_timezone`, `effective_timezone`), migration
`0115_aitask_schedule_timezone` (RunPython pins existing rows), `core/tasks.py`
(`_compute_schedule(tz=...)`), `core/views.py` (`_apply_once_schedule`),
`core/serializers.py`, `tacticalrmm-web/src/components/agents/AITasksTab.vue`.
Tests: `core/tests_ai_schedule.py` (5, DB-free: this venv has no test dependencies).

## 2026-09-14 (last) — "History" means every prompt, and it is fetched when it is opened

**The complaint, exactly:** a ticket conversation worked for a week
(`/ai-decision/…` on TICKET/61045) showed **13 history entries** — three queued items and
their lifecycle — while all 41 prompts the technician had actually typed were missing.

**Decision: the queue's History is the CONVERSATION's history.** `notePrompt()` records
every prompt that reaches the model — typed in the chat, sent from a paired phone, or
steered into a running turn — alongside the queue's own events, in one time-ordered list.
It is recorded in `runPrompt` *after* the window-command and `/compact` early-returns, so
the list is what the model was asked and nothing else: `/write on` never reaches it.
Queue-driven prompts are skipped because they are already recorded as `started` /
`answer_sent` against the item they belong to. Inlined attachment bodies are stripped back
out (`errors.log` is named; its 200 KB is not pasted into the record).

**Existing conversations were repaired from their transcripts, once.** Recording from now
on would have left a week-old chat still opening on its stale handful of queue events —
the complaint, unfixed. `backfillPrompts()` rebuilds from `getBranch()` on first attach and
sets a flag so a reopen cannot duplicate it. It reads the BRANCH, so prompts that
compaction later summarised away are still in the history: a chat the model no longer
remembers must still be answerable for what it was asked. TICKET/61045 now opens on **54
entries** (41 recovered prompts merged into the 13 queue events), first 08 Sep 15:10, last
today 16:34.

**The list is fetched on open, not carried on every frame.** `queue_state` is sent on every
queue change; now that the history holds every prompt of a long conversation, shipping it
each time would put hundreds of KB on the socket repeatedly — which is exactly what once
starved the heartbeat and made chats "keep disconnecting" (see `transcript-bound.js`). The
frame carries `history_count`; the window requests `queue_history` when the dialog opens
(and on its Refresh button), so what an operator reads is what the file holds at that
moment rather than a copy that arrived hours ago. Cap raised 500 → 5,000 entries, 2 KB of
text each.

Code: `pibridge/src/queue.js` (`notePrompt`, `backfillPrompts`, `sendHistory`,
`history_count`), `server.js` (`transcriptPrompts`, the four call sites),
`tacticalrmm-web/src/views/PiChat.vue`. Tests: `test/queue.test.mjs` (27, +7 new).

## 2026-09-15 — Ticket Automation Subjects: the AI may work a ticket alone, within a stated ceiling

**Brief (owner):** consolidate every procedure and make them global; auto-approve at score
≥95; add "ticket automation subjects" — kinds of ticket the AI may work automatically given a
matching procedure/KB; a daily report proposing 2–3 subjects approvable from a link in the
email; live subjects for SendPlot and spam; never work the same thing twice; never delete or
modify any file.

**Step 0 — `PI_CAPS_MODE=enforce`, and `customer` is always enforced.** The capability system
was in `warn`: six weeks of logs showed an unattended scheduled task emailing a customer and
three closing tickets — the exact acts the class system exists to stop, logged and then
allowed. Nothing acts alone while the switch says warn. Four op/surface pairs are now denied;
AI tasks that used `resolve_ticket` post a note instead.

**Procedures: 487 → 427 live, 60 retired into 38 canonical, every one rewritten global.**
`consolidate_ai_procedures` clusters per category (model), merges groups (model), cleans
singletons in batches (model), and scores. Nothing deleted: a retired row keeps its text and
points at what absorbed it (`merged_into`); the canonical row's count is the SUM and its
tickets the UNION. Deterministic rule fields are CARRIED from a source, never invented.
Customer specifics were lifted into `company_specifics` (85 items on 79 procedures) — they
belong in KB and are kept until moved. Cost: $6.98 on the default model, in the ledger.

**Score is capped by evidence, and nothing reached 95.** `score` = the model's 0–100 rating
of correctness/completeness/generality, capped 70/80/90/100 at 1/2/3–4/5+ tickets. The model
rated hard (max 86, median 55). So the owner's ≥95 auto-approve threshold approved **zero**
procedures on score alone — the 42 approved are the ones a human had already approved (kept
through merge). That is the honest result: a library mined from tickets reads as "probably
right", not "certainly right". The threshold is a one-flag change if the bar should be lower.

**A subject is permission, in data, with a mode that is a ceiling enforced in code.**
`AITicketAutomationSubject`: declarative match rules (same evaluator as procedures), the
procedures/KB it works from, which clients, and a MODE. `advise` builds NO device toolbelt —
"never touch a file" is not a rule the model follows, it is a tool it does not have.
`device_readonly` builds the decision toolbelt with every device gate refusing. `device_fix`
exists but is enabled for nothing: it needs an attached, reviewed script first. Neither mode
may close, route, or reach credentials.

**The model reports a verdict; code decides.** `report_verdict` returns kind, confidence,
findings, draft reply. CODE sends the reply only if confidence is `confident` AND there are
≥2 concrete findings AND the kind is on-subject. Anything less: internal note + needs-input
tag — what happened before, plus the evidence. The ticket is never closed by automation.

**"Is anyone already on this?" is a database lock, not a prompt.** `AITicketWorkClaim` with a
partial unique constraint on (fingerprint, active=True). Two fingerprints: condition key +
customer (+host), and normalised subject line + requester domain (Re:/Fwd:/ref-ids/digit runs
stripped). The second taker gets an IntegrityError, not a copy of the work; its ticket is
recorded as a duplicate and gets a note pointing at the one being worked. Every surface's
prompt (chats, triage, autowork) is told `ALREADY BEING WORKED: … on TICKET/x` first, before
its own instructions, via `helpdeskSection`.

**The daily report proposes; a link approves.** `automation_subjects` report kind: uncovered
human-filed tickets → model proposes ≤3 subjects with rules → saved as `proposed` with
single-use 40-char approve/reject tokens → email cards. The decide view is unauthenticated by
design (the token is the credential; it can only flip that one row). Proposals already
covered by a live subject's rules are not re-proposed — the first run re-proposed spam under
two new names; dedup-by-name was not enough.

**Two subjects live.** Spam/phishing verification (all clients, `advise`, 10 regex
alternatives for "the customer is asking", 31 exclusions; calibrated on 11 real tickets:
5/5 true asks match, 6/6 non-asks don't — including a password reset that says
"legitimate" and an ISP ticket that says "fraudulent"). SendPlot (Omega Design only,
`device_readonly`: probes port/URL/processes/DXF folder, tells the customer what it found,
leaves the tech the runbook; the restart itself needs a technician — it runs as an
interactively logged-on Administrator and no reviewed script exists yet).

**Two things went wrong and are recorded.** (1) Editing `serializers.py` to import the new
model while uwsgi still had the old `models.py` loaded took the API down 11:53–12:07 UTC (14
min; agent check-ins 502'd) until `rmm` was restarted. Lesson for `UPGRADE-RUNBOOK.md`:
restart uwsgi in the same step as any models/serializers edit. The spend outbox held 62 rows
through it and recovered all 62 — first real proof of that path. (2) `evaluate_match`
silently treated a >400-char regex as "no match"; `body_regex` now accepts a list of
alternatives and the cap is per alternative.

Code: `core/ai_workclaims.py`, `core/ai_autowork.py`, `core/ai_subjects_report.py`,
`core/management/commands/consolidate_ai_procedures.py`, models + migration 0116,
`core/views.py` (subjects API, `AutomationSubjectDecide`), `core/tasks.py` (stage after triage,
`send_automation_subjects_report`), `core/ai_conditions.py` (`body_regex` list);
`pibridge/src/server.js` (`runAutowork`, `/pi/autowork`, `helpdeskSection` dup notice),
`capabilities.js` (`advise`, `autowork_readonly`, `customer` always-enforced);
`tacticalrmm-web` `AITicketAutomationSubjects.vue`, `AIProcedures.vue`, `AIReportSchedules.vue`.
Tests: `core/tests_ai_workclaims.py` (4), plus live lock and shadow end-to-end checks.

**Addendum (same day, owner):** the Procedures page now has two proper tabs — *Procedures*
and *Ticket Automation Subjects* (with an amber count of proposals awaiting approval) — instead
of a subsection stacked above the table; `?tab=subjects` deep-links. Auto-approval is two
GLOBAL gates in Global Settings → Pi.dev AI → Procedures: **confidence score ≥ N AND times
seen ≥ M**, both required (`ai_procedure_auto_approve_score` = 95, `_seen` = 5 by default).
Applied by `AIProcedure.maybe_auto_approve()` from the miner as counts grow and from the
consolidation command, so a procedure crosses the line the day its evidence does. Why both:
score alone at 80 would approve two procedures seen twice; a fix seen once is a guess however
well it reads, and a fix seen fifty times rated 40 is fifty tickets of something we do not
understand. At the current library nothing clears any sensible pair — every draft with 5+
tickets scored under 75 — which is the honest state of a mined library.

## 2026-09-15 (evening) — The AI session lives on the server; browsers and the phone are views

**Brief (owner):** the AI runs on the server and the connection is a reflection of it; a
disconnect stops the AI only after N minutes (Global Setting, 0 = never); take-over needs a
permission; anyone else sees it read-only; an Android app listing every AI Decision and Pi
chat you may see, able to start new chats, and opening erp.blueuc.com chat links; and the
old phone "remote" feature removed.

**What already existed and was never connected.** `live-presence.js` (driver seat,
take-over rules 1–8, read-only joiners) and the `can_take_over_ai_session` role permission
were written and left unwired; `odoo-chat.js` already ran one session per conversation with
socket fan-out and a 5-minute dispose grace. The device and ticket chats were still one
session per socket, disposed in `ws.on("close")`. So this was mostly plumbing, not invention.

**`live-hub.js`: one hub per live conversation, keyed (scope, sessionId).** `hub.send` fans
out to every attached socket (all former `ws.send` calls in both chats became `hub.send`;
the three pre-hub early exits stayed on the socket). `attach()` joins a socket and presence
decides driver vs viewer; a reconnect by the same person within the 90s reclaim grace gets
the seat straight back — that is what F5 looks like. `detach()` on the last socket starts the
grace timer (`ai_chat_detach_grace_minutes`, default 5, 0 = never); the turn in flight keeps
running. Reconnect within it and you land on the LIVE session, mid-stream, not a copy opened
from disk. **Driving is enforced on the server**: `DRIVING_FRAMES` from a non-owner socket
are refused with `readonly_refused`, whatever the browser shows. Approvals go to everyone;
only the driver's answer counts.

**Proved live with three users:** B joined mid-turn (`streaming=true`), tried to prompt and
was refused by the server, asked to take over and was denied (no permission); A dropped
mid-turn and B kept receiving the stream (1234 → 1843 chars); A reconnected and reclaimed
the seat mid-stream; a superuser took over instantly and A fell to viewer; the superuser's
abort reached everyone. A 3-second grace disposed the session on schedule and a later
reconnect resumed from disk. Idle-close now closes sockets (starting the grace), never the
session; with grace 0 it does nothing.

**Remote (phone relay) removed.** `makeRemoteBinding` and the frame mirror are no longer
called in either chat; `remote_blob_fields` now returns `remote_allowed:false` plus the new
`detach_grace_minutes` / `is_superuser` / `can_take_over_ai_session` fields; the pairing
dialog, menu item and settings section are deleted from the UI. `remote-room.js` and the
`ai_remote_*` columns remain on disk, unreferenced, for a later clean-up.

**The "app" is a PWA, and that is the honest answer for today.** No Java/Android SDK on this
host, so no APK could be built or signed here. Android/Chrome installs the site as a WebAPK:
own icon, standalone window, and — because the manifest scope is `/` — **links to
rmm.blueuc.com open in the app**, which is what makes erp.blueuc.com's "Chat with me" links
land in it. `/m` is the inbox: every AI Decision and every Pi chat on permitted agents, LIVE
ones first with who is driving (bridge `/pi/live`), tap to open in-app as viewer/driver, New
chat (`?new=1`). Service worker is network-only on purpose: an AI session must never be shown
stale. nginx serves the manifest as `application/manifest+json` (Chrome refuses to install
otherwise) and the worker uncached. `history_bulk` gained a POST body: 1,177 agent ids do
not fit in a URL (431) and the inbox showed no device chats. A native/TWA wrapper around the
same URL is a follow-up if a Play-store presence is wanted.

**Known gap:** a viewer who joins mid-turn receives the stream from that moment; the part of
the current assistant message already streamed is not replayed until the turn ends (the
transcript then has it). Minor; noted rather than hidden.

Code: `pibridge/src/live-hub.js` (new), `server.js` (both chats, `/pi/live`, `history_bulk`
POST), `core/ai_remote.py`, `core/models.py` (+0118), `core/views.py::AIMobileInbox`,
`tacticalrmm-web` `PiChat.vue` (presence banner, Take over, read-only composer, remote UI
removed), `PiMobile.vue` (new), `boot/pwa.js`, `public/manifest.webmanifest`, `public/pi-sw.js`,
icons, `AISettings.vue`, `RolesForm.vue`; nginx `frontend.conf`.

## Pre-sales discovery on CRM opportunities (2026-09-16)

An IT technician is assigned a CRM opportunity and surveys what the customer actually has,
so a sales rep - who has no RMM access and will never read the chat - can quote from fact.
One durable thread per opportunity (`AIDecisionRequest.subject_kind="crm"`,
`subject_ref="LEAD/837"`), the same rule the ticket path uses: two threads for one subject
means two half-conversations and two AIs that disagree.

Surface `discovery` (capabilities.js) is the ceiling:

* `read`  - the estate, their tickets, closed work, KB articles, the opportunity chatter.
* `note`  - findings onto the opportunity.
* `sales` - a DRAFT quotation, gated by the existing `can_use_ai_sales` role permission.

Deliberately absent:

* `customer` - a discovery session never contacts the prospect. Pre-sales correspondence is
  the rep's relationship to manage; an AI emailing a prospect mid-survey could lose the deal.
* `close` / `routing` - there is no ticket here to close or re-route.
* `secret` / `secret_write` - surveying what exists needs no stored credential.
* `knowledge` / `global_knowledge` - **owner's ruling: NO KB writes from discovery.** Reads
  are class `read` and stay, because reading the KB is how the AI learns the estate. But a
  scope is a proposal about work nobody has done yet, for a deal that may never close;
  filing it as knowledge seeds the KB with unverified claims that become tomorrow's wrong
  answer. EVERYTHING goes on the opportunity, which is the whole record of the job. KB
  articles get written when a TICKET does the real work and the facts are proven. This also
  removed `save_procedure` from the surface - a procedure is knowledge for future work too.

Two things are enforced in code rather than asked for in the prompt:

* **No money from the model.** `submit_discovery_scope` states hours and materials; a
  regex refuses the submission outright if a price, rate or total appears in it, naming the
  field. A wrong number in front of a prospect becomes a promise the moment it is read.
* **Structure is required.** Missing phases, current_state, assumptions or open_questions is
  refused: a transcript is not a scope, and a rep cannot price "we had a look and it's fine".

Write mode was initially hard-coded off here and that was **reversed** the same day (owner):
device changes follow the ordinary `can_use_ai_mutate` permission plus the approval prompt,
because discovery routinely turns into "while you are in there, fix it". `schedule_action`
stays withheld - it would run a change LATER, after this session's oversight has ended.

Quotes drafted from a discovery session attach to the opportunity via
`sale.order.opportunity_id`, so Odoo's own Quotations button on the CRM record shows them;
the customer is resolved from the opportunity's partner, else its email domain, and REFUSED
rather than guessed when that is ambiguous.

## Hub state replay (2026-09-16)

A server-resident session outlives the socket that created it, so a socket attaching LATER
(refresh, second tab, phone, read-only viewer, reconnect after a drop, any bridge restart)
received only `ready` - it missed the `queue_state` and `cost_update` frames broadcast when
the session opened. Symptom on TICKET/61045: the "History" button greyed out
(`:disable="!queueHistoryCount"`) and the spend meter blank, while 109 history entries and
$56.91 across 590 ledger rows sat intact on the server.

`hub.stateProviders` + `hub.replayState(ws)`: the session registers snapshot providers (the
prompt queue and the cost meter each already exposed one) and every attaching socket is
caught up. One mechanism, not two special cases - anything else a window needs to render
its current state registers the same way.

### Where an opportunity's records live (2026-09-16, owner)

Two different kinds of thing, two different places:

* **Notes / findings -> the CHATTER.** That is where the conversation about the deal is, and
  a note is a message in that conversation. (Earlier the same day this was moved to Internal
  Notes and then moved back - the ruling is: chatter.)
* **QUOTES -> INTERNAL NOTES, always. Never the chatter.** A quote is a document the rep
  re-reads when the customer comes back weeks later; a chatter scroll is the wrong place to
  keep one. Filed automatically by the bridge whenever a quotation is created, updated or
  linked from an RMM AI session (`QUOTE_OPS` in tools.js), as branded HTML carrying the
  facts a rep needs at a glance - number, state, totals (Odoo's own, never the model's),
  validity, customer, salesperson, who raised it, and the EXACT customer-facing body that
  was issued, verbatim rather than summarised.
* **Re-issuing REPLACES the copy on file** (`section: "quote"` +
  `update_opportunity_notes`), so there is only ever one current quote to read. Everything
  outside the section markers - including anything a human wrote - is preserved.

Filing is best-effort by design: it must never fail a quotation that Odoo already created.
This applies to work driven from the RMM AI; once the work is driven from inside Odoo, Odoo's
own behaviour takes over.

Tested in `test/quote-file.test.mjs` (3 tests, no network): a created quote is filed in
Internal Notes and NOT the chatter, re-issuing targets the same section, and a read-only
sales op files nothing. The stub captures calls through `helpdesk.context`, which also
closed a real gap - `buildDecisionTools` never passed a context to the integration, so an
integration could not tell which conversation it was serving. It now does, like buildTools.

### Email from a discovery session follows the hamburger (2026-09-16, owner)

The first cut refused email on the `discovery` surface outright. That was wrong: these are
technicians, the window already has switches for exactly this decision, and "email me the
scope I just wrote" is ordinary work. Reversed - the switches govern, as they do on a ticket:

| Recipient | What it takes |
|---|---|
| Our own domain (from the brand config - `blueuc.com`) | **Write mode ON**, or the technician approves the prompt |
| Anyone else (the prospect) | **"Allow customer email" ON** *and* an approval click |

A mixed recipient list counts as external: one outside address makes the whole send external.
`allow_email` still starts OFF on a discovery window, because a stray message here reaches a
PROSPECT and the sales rep owns that conversation - but it is a switch the technician can
flip, not a wall. Internal mail never needs it.

The gate lives in send_email's execute (tools.js), not in the surface's class list, because
the decision depends on WHO the recipient is - which no capability class can express.
`attach_capture` stays off the surface: it attaches to a ticket, and there is no ticket here.

Tested in `test/discovery-email.test.mjs` (7 tests, no network), including the refusal naming
the switch that fixes it, and the prospect not receiving anything when the tech declines.

### Quotation pricing and tax (2026-09-16, owner)

Three faults found on the first real AI-built quote (S00078, Omega Design, 168 hours quoted
at a total of **$0**):

1. **Prices were never set.** `buildTemplateLines` defaulted `price_unit` to 0 when the
   caller supplied none, so every line went in at zero. The default is now the PRODUCT'S OWN
   list price from Odoo - `225-BlueCloud` = $225/hr - which is our rate card, not a number
   anyone invented. An explicit `price_unit` still wins, so a technician can discount or fix
   a price deliberately. The model is told this in the tool description: a priced quote is
   expected and correct; never invent a rate.
   (This does NOT relax the discovery scope rule: `submit_discovery_scope` still refuses
   money. Hours and materials there; prices come from Odoo's product, on the quotation.)
2. **Every line was taxed.** `225-BlueCloud` carries "Tax 6.0" in Odoo, so it applied by
   default. Lines now go in with `tax_id: [[6, 0, []]]` - no tax - unless `taxes: true` is
   passed explicitly. The subtotal note says which, instead of the old unconditional "Tax
   additional if applicable".
3. **"Engagement approach" was eight literal `[object Object]` lines**, in front of a
   customer. `asList()` did `String(item)`, and phases arrive as `{name, hours, detail}` -
   the natural shape, and the one the discovery scope produces. A `lineText()` renderer now
   handles objects ("Phase 1 - 16h - Mapping workshop and dual-run design") and falls back
   to an object's own key/values rather than to the word "object", so a malformed item shows
   what it contained instead of hiding it.

S00078 itself was repaired in place: 8 lines priced at $225 (**$37,800**, tax $0), the 8
broken notes deleted (they carried no information to preserve), and the subtotal sentence
corrected. It is still a DRAFT for a human to review and send.

## Odoo 17 -> 19 migration (2026-09-16)

erp.blueuc.com was moved to Odoo **19.0-20260504** (from 17.0). The host, the database name
(`blueuc`), the API user (`bluecloudapi@blueuc.com`, uid **35**) and the API key all came
across unchanged in the full copy, so NONE of our configuration needed editing - the audit
list of "things to point at the new host" turned out to be a list of things that did not
move. Verified on the live system:

* Softhealer helpdesk is installed on 19: `sh_all_in_one_helpdesk` **19.0.15.0.0** +
  `sh_all_in_one_helpdesk_extension` 19.0.5.5. Every model we touch exists
  (sh.helpdesk.ticket, helpdesk.stages/tags, knowledge.global.article, knowledge.entry.*,
  partner.secure.note, crm.lead/stage, sale.order/line, mail.template/message/compose).
* **Every hardcoded id is identical**: stages 1/2/5/11 (+ new 15 "Reopened", correctly
  treated as OPEN), teams 1 & 3, bot user 35, partner 1, mail.template 35, company 1,
  warehouse 1, products 372 (`225-BlueCloud`, $225) and 207 (`Misc Item`).
* Our data survived with the same keys: 7,092 tickets, TICKET/61045 still Tier - 3,
  LEAD/837 still "Send Quote", S00078 still $37,800 (and now `sent`), KB 40/44 intact.

### Three real Odoo 19 API breakages, found and fixed

1. `crm.lead.mobile` was **removed** in 19 (folded into `phone`). Asking for it failed the
   WHOLE read - `get_opportunity` returned "Invalid field 'mobile' on 'crm.lead'", so every
   discovery session was dead. Field dropped from LEAD_FIELDS.
2. `sale.order.line.product_uom` -> **`product_uom_id`**. Broke `create_quotation` outright.
3. `sale.order.line.tax_id` -> **`tax_ids`**. Broke it again, one line further on.

(2) and (3) are not pinned to a version number: `lineFields()` asks the server once via
`fields_get` and caches the answer, so the same code works on 17, on 19, and on whatever
comes next without another emergency edit. Guessing the version would have been one more
thing to remember at the next upgrade.

### Coverage of the smoke test

43 operations loaded, 0 unclassified. Read paths: 16/16 (two initial "failures" were bad
test arguments, and the guard rails refusing them correctly). Write paths exercised on
THROWAWAY records that were deleted afterwards - create_ticket, add_note, needs-input
tag on/off, claim/assign/release, set_ticket_company, attach_file, ai_close/close, and the
full sales chain (create_quotation -> update_quotation dry-run then applied ->
link_opportunity_quotation), plus CRM internal-notes write/read/remove and a global KB
article created and deleted.

NOT tested by design: `reply_to_ticket` (it emails a customer) - the mail.template it uses
(id 35, "Ticket Reply: Send by email (mod)") is present and points at Helpdesk Ticket, but
the send path is unproven on 19. **First real customer reply should be watched.**

nginx now accepts both `erp.blueuc.com` and `dev19.blueuc.com` as embed/WebSocket origins
(same box, two names) so switching hostname needs no nginx edit; `ai_erp_allowed_origins`
holds both too.

### Deploy rule, learned the hard way (2026-09-16)

Migration 0119 added `subject_kind`/`subject_ref` to AIDecisionRequest. uwsgi was restarted;
**celery was not**. Django adds a column with its default, backfills, then DROPS the database
default - so the workers, still running the old model code, omitted the column from every
INSERT and died on NOT NULL. `triage_ai_ticket` crashed on every ticket from 13:08 to 18:50:
**8 tickets untriaged, no decision threads**, and opening one 404'd ("No AIDecisionRequest
matches the given query") because the thread the link expected had never been created.

Nothing in the logs we watch said "triage is down" - it looked like a quiet afternoon.

Two changes:

* **The rule is now: a models.py change restarts `rmm daphne celery celerybeat`, in the same
  step.** Not just uwsgi (the earlier rule, from the serializers outage) - every process that
  holds the ORM.
* Migration 0120 gives those columns real DATABASE defaults, so a stale worker degrades to
  "writes a helpdesk-kind row" instead of failing outright. Verified by inserting a row the
  old way (no subject columns) and getting `subject_kind = 'helpdesk'`.

Recovery: celery restarted, the poller re-run, and the six tickets outside its window had
their state rebuilt the way the poller builds it and were triaged individually. All 8 now
have threads; 0 stuck in triaging.

### Test records against a LIVE helpdesk (2026-09-16)

A probe ticket I created while diagnosing the Odoo 19 `message_post` change outlived its
script: the script raised before its cleanup line, so TICKET/61425 ("PI.DEV NOTE FORMAT
PROBE") stayed in the New queue, the poller picked it up within a minute, triaged it, opened
a decision thread and spent **$0.04** of real model time on it.

Rule for anything that creates helpdesk records: **cleanup belongs in a `finally`, not on the
last line.** This helpdesk is live and the poller is always watching - a throwaway ticket is
not throwaway for the minute it exists. Better still, probe read-only paths and reuse an
existing record we own.

The ticket, its AITicketState and its decision thread are deleted, along with the bridge
session directory. The four ledger rows are KEPT: the money was really spent, and the ledger
is never rewritten to make a mistake disappear (same rule as the "transcript deleted" rows).

### The AI may only ever reach "AI Closed" (2026-09-16, owner)

TICKET/61424 was moved to **Closed** (stage 1) by `close_ticket`, after a technician typed
"close the ticket". Two things were wrong:

1. **Closed is the human outcome.** Every AI-finished ticket must land in **AI Closed** so a
   person can review what the AI decided. Let the AI use the same stage a human does and that
   review silently disappears.
2. **Stage 1 fires Odoo's customer "your ticket is closed" email.** So an AI close emailed
   the requester with no human seeing the message - the one thing customer-contact rules exist
   to prevent. That mail went out at 19:14 and cannot be recalled.

`close_ticket` now writes **stage 11 (AI Closed)** in code and posts a note saying why, so the
technician's instruction is still honoured - the ticket IS closed out, in the AI's own stage -
and a human promotes it to Closed if they agree. Enforced in the integration, not in a prompt,
because a rule that lives only in a prompt is a suggestion. Both the operation description and
the HELPDESK POLICY prompt were corrected to match, so the model is never told otherwise.

Audit of every stage write in the integration afterwards: `ai_close_ticket` -> 11,
`close_ticket` -> 11, `resolve_ticket` -> 11 (or 5 when cancelling), `cancel_ticket` -> 5
(the approved non-actionable-alert path). **No AI path can write stage 1 any more.**

## device_fix: the SendPlot restart (2026-09-16, owner)

"I want sendplot to be more than readonly when a start / restart of sendplot should be
enough to fix it." So `device_fix` is live for subject #2 - the first subject allowed to
change anything on a customer machine. What makes that safe is not the prompt:

* **The AI cannot compose a command.** `subject.fix_actions` is DATA a human reviewed; the
  model calls `apply_fix("restart-sendplot")` and code looks the command up. "Restart
  SendPlot" therefore cannot become "delete the SendPlot folder" through a badly-worded
  ticket or an injected instruction - the blast radius is the list, not the model's judgement.
* **The target is pinned** (`subject.fix_target` = ENG1-DEV). The model does not choose the
  machine, so a hostname mentioned in a ticket cannot redirect the action.
* **Evidence is required before acting.** `apply_fix` refuses unless the model passes the
  read-only probe output that shows the service is DOWN (port 5000 / the KB 44 URL).
  Restarting something that is working is a fault, not a fix.
* **One attempt per ticket**, and a **60-minute cooldown per subject** - a service that
  keeps dying escalates to a human instead of being restarted in a loop. Inside the cooldown
  the actions are not even sent to the bridge; the session is told why and investigates
  read-only.
* **`gate("device")` still refuses free-form device writes** in fix mode, with a message
  pointing at apply_fix. There is no second route.
* **No closing authority.** The `autowork_fix` surface holds `read`, `note`, `customer` -
  and NOT `close`, `secret` or `knowledge`. A successful restart posts a note and leaves the
  ticket for a human.

The remediation itself touches no files and deletes nothing: it stops the five
`Pi-SendPlot-*` scheduled tasks (which is what frees port 5000, per the Omega Design
specifics), waits, then starts them in the order KB 40 gives - 01-robo, 02-dwg, 03-printer,
04-masterbills, 05-web - then re-probes the port and the URL. Re-running it is harmless.

`device_fix` with no reviewed actions attached DEGRADES to read-only investigation rather
than pretending it can fix things; actions attached to a read-only subject are ignored,
because the MODE is the ceiling. Tested in `test/autowork-fix.test.mjs`.

## Instant triage: the helpdesk tells us, we stop guessing (2026-09-17, owner)

Triage used to depend entirely on a 90-second poll, so a ticket could sit for a minute and
a half before anything looked at it. Now there are two paths, and they are deliberately
different in character:

* **The trigger.** An Odoo 19 automation rule ("Pi.dev AI - triage on New", trigger
  `on_stage_set` -> stage 4 New) fires an outbound `webhook` server action at
  `/core/ai/hooks/helpdesk/<secret>/`. Native Odoo - no module, no custom Python on that
  side. It fires whenever a ticket ENTERS New, so a re-opened ticket gets the same
  treatment as a brand-new one. Measured end to end: **picked up 5.3s after creation**,
  triaged in 41s.
* **The safety net.** The poll stays, at **2 minutes**, because a webhook cannot cover our
  own downtime, somebody disabling the Odoo rule, or the re-engage loop (a customer reply on
  an existing ticket). Belt and braces, with the braces doing most of the work now.

`poll_helpdesk_tickets(only_refs=[...])` is how the webhook triages: the SAME function,
narrowed to named tickets. The ingest rules - alerts, scope, internal notices, baseline, the
re-engage loop - are subtle enough that a second implementation would diverge within a
month, and the copy nobody watches would be the one making decisions.

The endpoint is deliberately dumb, because Odoo cannot send a header and the secret
therefore lives in the URL path:

* it authenticates only by constant-time compare of `ODOO_AI_SHARED_SECRET`, and answers a
  bare 404 for both "wrong secret" and "none configured" so a prober learns nothing;
* it accepts nothing but ticket REFERENCES - no state, no instructions, nothing that could
  steer a decision. The worst a forged call achieves is making us re-read a ticket we can
  already see;
* it does no work in-request: refs go to the ordinary poller and Odoo gets an immediate 200,
  so a slow triage can never block the helpdesk UI;
* it is capped (50 rows in, 20 refs out) and idempotent - `triage_ai_ticket` already skips
  anything not in status new/error, so webhook and poll racing on the same ticket is a
  no-op, not a double triage.

If the webhook fires for a ticket the automation cannot work (already assigned to a human,
closed, out-of-team), the result says exactly that rather than failing silently.

### The poll interval lives in Global Settings (2026-09-17, owner)

`CoreSettings.ai_ticket_poll_minutes`, default **10**. Beat still ticks every 60s and the
TASK decides whether the poll is due (marker in the cache, set BEFORE the work so a slow
poll cannot stack behind itself). Two reasons it is done that way rather than by editing the
beat schedule:

* changing an interval should not need a deploy, and it certainly should not need a
  celerybeat restart - a restart is exactly the step that gets forgotten (proven today:
  migration 0119 without restarting celery took triage down for six hours);
* the value is now visible where the person who cares about it works.

`0` disables the poll entirely and relies on the webhook alone - a choice the owner is
allowed to make. A webhook-driven run (`only_refs`) is NEVER throttled; that is its purpose.

### Does an instant triage make the scheduled one skip? Yes.

`triage_ai_ticket` refuses anything whose state is not `new` or `error`
("skip status=triaged"), so a poll landing on a ticket the webhook already handled is a
no-op. The one case that deliberately DOES re-run is the re-engage loop: a new message from
a human (not from us) sets the state back to `new` and calls triage with `force=True`. That
is not double work - it is the ticket having changed.

## Duplicates: hold, then resolve and AI-close all of them (2026-09-17, owner)

Observed live. TICKET/61474 "Sendplot is down" arrived 12:05:36 and was fixed and answered
by 12:10:36. TICKET/61475 "SendPlot" arrived 12:08:54 - WHILE the first was being worked -
but by the time its autowork stage ran, the first ticket's claim had already been released,
so it was worked from scratch: a second model session about a service that had just been
restarted. Two more faults showed up in the same incident:

* the bridge ran the restart (its log proves it) but Django recorded **nothing** -
  `fixes_applied` stayed 0 and `last_fix_at` stayed null, so the 60-minute cooldown could
  never engage. The guard existed on paper only;
* `find_recent()` filtered claims on `outcome="done"`, but a successful autowork releases
  with the ACTION as the outcome ("replied"). It would have matched nothing - every late
  duplicate worked from scratch. Caught by the test, not in production.

What happens now:

1. **While the first ticket is being worked**, a second ticket for the same thing is put
   `on_hold` (`duplicate_of`, `held_fingerprint`) and told so on the ticket. It is not
   worked, not replied to, and not closed - it waits.
2. **When the first ticket finishes successfully** (confident verdict, customer replied),
   the primary goes to **AI Closed**, and every held duplicate gets: a note explaining
   which ticket resolved it, **the same answer sent to its own requester**, then **AI
   Closed**. Each person who wrote in gets told; closing a ticket without answering the
   person who raised it is the silent outcome we never allow, duplicate or not.
3. **If the first ticket did NOT resolve** (unsure, reply failed, error), nothing is closed.
   The duplicates keep the needs-input tag and a note saying a human has it.
4. **A duplicate arriving just AFTER** the work finished is caught by `find_recent()` within
   the cooldown window and held against that ticket instead of redoing the work.
5. **AI Closed, never Closed** - the automation's closes land in the review stage, which is
   the whole point of that stage existing.

Proven end to end with the helpdesk stubbed: primary -> `ai_close_ticket`; duplicate ->
`add_note`, `reply_to_ticket`, `ai_close_ticket`; states `auto_closed` and
`auto_closed_duplicate`; and with a fix recorded, `_subject_payload` withholds the actions
with "the reviewed fix was already applied at 12:17 UTC; it is withheld for another 60
minute(s)".

### One session handles the whole incident (2026-09-17, owner)

Rather than Django sweeping duplicates afterwards with a copied paragraph, the session
working the primary ticket handles them itself: "why not just inform the AI that is working
on the PRIMARY ticket that it also needs to handle the tickets that are duplicates... this
way we can have one AI do all the work as tickets come in, and it will respond to everything
correctly once done."

* `list_duplicate_tickets` asks Django which tickets are held behind this one. Called at the
  END of the run on purpose: a duplicate usually arrives WHILE the first ticket is being
  worked (TICKET/61475 landed three minutes into TICKET/61474), so the list at session start
  is never the final list.
* The session replies to each in **that requester's own context** - they asked separately
  and a copied answer reads like one.
* `allowedTickets` is the boundary: this ticket plus its held duplicates, refused BY NAME
  for anything else, so "handle your duplicates" can never become "touch any ticket" even
  if a ticket body asks for it.

**The customer-email rule, bypassed where the owner says it may be** - "if the ticket auto
group allows for this ticket type to be auto done, then that rule may be bypassed since it's
an auto resolvable ticket". An APPROVED SUBJECT is now the authority for customer contact on
its own incident: a person decided this ticket type may be answered without them. So the
session may reply directly on `device_readonly`/`device_fix` subjects. Still bounded, in
code: `allowedTickets`, the subject's own `reply_allowed` switch, and `advise` mode keeps the
verdict-driven path (no device evidence to stand on). Device changes are unchanged - apply_fix
or nothing. Closing stays code-driven from the verdict.

### Replies to a ticket the automation closed (2026-09-17, owner)

Decided in code, before any model call, because these two cases need no judgement:

* **"this didn't fix it" / "it's still down"** -> the automation STANDS DOWN on that ticket
  for good: needs-input tag, released from the bot, and a note explaining that a second
  automated attempt on someone already unhappy is not what they asked for. A human takes it.
* **"thank you" / "all sorted"** -> re-closed to AI Closed with a note, no reply sent (they
  were thanking us, not asking), no spend.
* **anything else** -> the ordinary triage path, where judgement belongs.

Order matters: the still-broken test runs FIRST, so "Thanks but it is still down" is read as
still down. 11 phrasings verified, including that one.

### Chat links open in a new tab, and are actually links (2026-09-17, owner)

Asked for: "IS there a way to have it auto open a new tab? instead of replace the window".
Yes - `target="_blank" rel="noopener noreferrer"`, verified to survive Odoo 19's HTML
sanitiser (it keeps both attributes). A technician clicking from the helpdesk now keeps the
ticket they were reading.

Found while testing, and worse than the original ask: **Odoo does not auto-linkify bare URLs
in a message body**. Three of our automation notes pasted the chat URL as plain text, so
those links were not clickable AT ALL - copy-and-paste only. They are now real anchors
(`_chat_anchor()` in ai_autowork.py, `chatAnchor()` in server.js), which is why the fix is
worth more than the tab behaviour that prompted it.

### The chat history says WHO sent each line (2026-09-22, owner)

Asked for: "in the ai chat windows i want a way to look at the history and see who was the
person that sent each chat... that way as an admin i can see what's going on".

The queue history already recorded every prompt of a conversation; it did not record who
sent it, and the window labelled everything "You asked" - which is wrong the moment a
session is shared, and a session is shared by design (one driver, any number of watchers,
a seat that is handed over, a paired phone as another socket). So a two-person job read as
one person's work, and an admin reading the history could not tell them apart.

Decisions:

* **Presence is the authority on identity, not the token the session was opened with.**
  `actorOn(hub, sock, blob)` reads the person off the socket the frame arrived on - the same
  map the driving check uses. A frame sent by a watcher who took over is theirs.
* **Both halves are stored**: `user` (the login, stable, what a filter compares) and `by`
  (their display name, what a human reads). Two technicians sharing a first name must not
  merge into one line of an audit.
* **A queued item carries its owner**, so the rows it generates when it runs an hour later
  (`started`, `done`, `failed`) name whoever queued it - not whoever happens to be watching
  when it fires. An answer, a stop or an edit is attributed to the person who did THAT.
* **The AI's own rows are attributed to nobody** (`actor: false` defeats the item-owner
  fallback). A question from the model is not the watching technician's.
* **Unknown stays unknown.** Rows written before this change, and prompts recovered from a
  transcript by `backfillPrompts`, have no sender and say "unknown" in the window. A guess
  in an audit trail is worse than a blank.
* **Clearing the history leaves one row saying who cleared it.** Otherwise a wiped history
  is indistinguishable from a quiet conversation, which is the one thing an admin must not
  be shown. (The chat transcript was never touched by that button anyway.)

In the window (PiChat.vue) the History dialog gains a who column - "You" for your own rows,
the person's name for everyone else's, the login in the tooltip - and a "who" filter that
appears only when more than one person is in the list. Event labels are now person-neutral
("Asked", not "You asked"), since the column carries the person.

### Auto-clear is on by default, off only where someone said so (2026-09-22, owner)

Asked for: "auto clear should always be selected by default unless that chat window turned
it off which should be persistent".

Auto-clear only decides whether a FINISHED queue item leaves the list, so tidy is the right
default and OFF is the deliberate choice. Three things follow:

* **The stored value is not enough to go on.** Every queue file written before today says
  `auto_clear_done: false`, because that was the default - not because anyone chose it.
  `auto_clear_set` now records that a PERSON flipped the switch; without it the window's
  default applies. So existing conversations come back ON, and nobody's real choice is
  invented for them.
* **The choice belongs to the WINDOW, not the session.** It goes into window-memory.js
  (`recallSwitch`/`rememberSwitch`, alongside Write mode and Auto-approve), keyed on the
  conversation - the agent for a device chat, the ticket for a decision chat. New chat, F5,
  a dropped socket and a bridge restart all keep it. Unlike the other switches it carries no
  permission, so it is recalled directly rather than through `chooseSwitches`.
* **Flipping it is in the history, with the name of whoever flipped it** (`auto_clear` row),
  since the same day's work made the history answer "who did that".

The window toggle now starts at ON rather than OFF, so it does not flash the wrong state in
the moment before the first `queue_state` frame arrives.

**Follow-up, same day: "auto clear is on, but it doesn't auto clear"** (owner, seen on
`/ai-decision/...` for TICKET 61666). Two causes, both fixed:

* A done item that carried a **question-and-answer** was held back on purpose, so its trail
  stayed on screen. Since every typed prompt is now an item, and the assistant asks
  something during most real work, most finished items had a thread - so with the switch ON
  they stayed, which is indistinguishable from the switch being broken. Worse, the two paths
  disagreed: *enabling* Auto-clear swept those same items (`status !== "done"` filter) while
  *finishing* one kept it. A finished item now always clears. Nothing is lost - the question,
  the answer, the time and who gave it are in the history, one click away.
* **Reopening** a window did not sweep. Items that finished under the old rule (or before
  the switch was turned on) sat there for good. `attach()` now clears plain `done` items when
  Auto-clear is on, recording an `auto_cleared` row for each. Failed, skipped and waiting
  items are never touched by any of this: they still need a human.

### One tool result must not be able to wedge a conversation (2026-09-22, owner)

Reported: "not sure what to do here... but i can't summarize and compact... i can't
continue" on a live device chat (agent fNcWNYbz..., session 01a0c8cd).

What happened, from the session file: a single `helpdesk_call` -
`list_closed_tickets(since=2026-08-01)` with full message bodies - returned **2.96 MB**
(~740,000 tokens) into a conversation on a 500,000-token model. From that entry onwards:

* every prompt was rejected by the provider with `input_too_large` before the model saw a
  word of it (871,750 tokens > 500,000), and
* **"Summarise & clear" refused**: `Nothing to compact (session too small)`. Compaction
  summarises whole turns up to a cut point and keeps the recent tail; the only thing after
  the last cut point was that one tool result, so the harness had nothing it was willing to
  cut. The one tool built for this situation declined to act, and said the conversation was
  *too small* - on 871k tokens.

So the window was a dead end: too big to talk to, too "small" to compact. Auto-compaction
broke the deadlock five minutes later by cutting a second time, which is luck, not design.

Three fixes, in order of importance:

1. **The device chat's `helpdesk_call` was returning `JSON.stringify(result)` with no cap.**
   Every other tool on that surface caps its output, and the ticket surface's copy of this
   very tool was capped on 2026-08-19 after the same failure (2,289 KB, 2026-08-11) - the
   device-chat path was missed. Now capped with `capJson` (element-wise, so the model still
   gets valid JSON, "showing X of Y", and an instruction not to re-run the broad call).
   `attach_capture`'s `Result: ${JSON.stringify(res)}` is capped too. The regression test
   now asserts on the SOURCE that no `hd.operations[op](...)` return path is uncapped -
   there is no point catching this a third time in a fourth function.
2. **`context-trim.js`**: drop an oversized tool result out of the model's CONTEXT (never
   out of the transcript) using the harness's own `context_edit` mechanism, replacing it
   with a one-line marker saying what was removed and what not to do about it. Tool results
   only - never a person's words, never the model's own messages - biggest first, only when
   actually oversized, idempotent, and never throwing, because it runs when the chat is
   already broken. Wired in two places:
   * **before** every manual compaction, so the summariser has something it can cut, and
   * **automatically** when a turn dies with a context-overflow error, followed by one
     sentence in the chat telling the technician they can carry on.
3. **An honest refusal.** When the harness says "too small" and the context is at/over the
   window, the window no longer repeats that; it says how many tokens are in play against
   the window, that there is nothing for the summariser to cut, and what just happened
   about it.

### A scrolled-up transcript stays where it is (2026-09-22, owner)

Asked for: "when i scroll up in any of the AI windows... i need it to PAUSE where I am when
new info shows up at the bottom of the screen.. i am usually reviewing or trying to copy /
paste ... it should only keep updating with the most recent data when i am at the bottom of
the screen within 1% of the entire scrolled area".

Every window used to call `scrollToBottom()` unconditionally on every frame - and a
streaming answer produces those many times a second - so reading anything above the fold
was impossible and a drag-selection was pulled out from under the mouse mid-copy.

* **The rule is one function**, `web/src/utils/scrollFollow.js` (`isFollowingBottom`): follow
  the bottom only while the view is within **1% of `scrollHeight`** - the entire scrolled
  area, as specified - so the band scales with the conversation (a page or two on a long
  chat, a few pixels on a short one). There is a **24px floor**, because 1% of a transcript
  one line taller than its window is ~7px: without it a single wheel click would pause the
  window and that reads as a frozen chat, not a deliberate hold.
* **Used by all three streaming surfaces**: PiChat.vue (the device chat AND the AI decision
  chat), CommandStream.vue (live command output - where people go to copy an error), and
  the Odoo-embedded panel (`ai-integration/index.html`, its own small implementation because
  that page has no build step).
* **The pause is visible.** A sticky "Paused - N new below" button appears over the newest
  text while the view is held; clicking it, or scrolling back into the 1% band, resumes
  following. A paused transcript with nothing saying so is indistinguishable from a broken
  one.
* **Your own actions still take you back to live**: sending a message, and the phone's
  keyboard resize only re-pins when it was already following.
* Tested in `web/src/utils/scrollFollow.test.mjs` (`node --test`) - the app has no component
  test harness, which is exactly why the rule is a pure module.
