# DRAFT: work-ledger completion credit (NOT YET DEPLOYED)

Target: `CoreSettings.ai_helpdesk_code` → `daily_activity`. Live snapshot backup:
`~/helpdesk_code.pre-secrets.bak`. **Do not apply until Chris approves.**

## The bug being replaced

```js
const closedIn = !!terminal[r.stage_id && r.stage_id[0]];   // CURRENT stage is terminal
if (closedIn && r.write_uid) {
  if (closerIsBot && driver) bump(clean(driver.name), "staff", "closed");
  else bump(clean(r.write_uid[1]), "staff", "closed");       // last writer, not the worker
}
```

Credit fires on "current stage is terminal + touched in window" and lands on the **last
writer**. So `Done → Closed` review moves credit the reviewer, notes on already-closed
tickets fire a phantom completion, and only ever one person can be credited.

## What replaces it: a ledger, no "credited assignee"

Per the review, credit is **not** assigned to the assignee (or any single person). Every
person who worked the ticket is on its ledger with a proportional share.

**Effort units** (the contribution score, one line to retune):
| Work | Units |
|---|---|
| customer-visible reply | 3 (+1 per 400 chars, max +3) |
| internal note | 1 (+1 per 400 chars, max +2) |
| AI message a person directed | 2 |

Share = person's units ÷ all units on the ticket. On completion, that **one** completion is
split by share (20/40/40 → 0.2/0.4/0.4). Shares total 1.00 per ticket — verified: **0 balance
violations across 344 completions**.

Two credit views are produced, because the AI carries most raw volume:
* **humans-only** (recommended headline): renormalised across people; AI shown separately as
  "AI carried X%".
* **AI-in-split**: the AI dilutes human percentages.

## Completion detection — REVISED

The first draft read stage changes from `mail.tracking.value`. **That does not work:** the
API user (uid 35) is denied `mail.message.tracking_value_ids` ("allowed for groups
Administration / Settings"). Do not use it.

**Use the helpdesk's own stage history instead:** `sh.helpdesk.ticket.stage.info`
(`stage_task_id`, `stage_name`, `date_in`, `date_in_by`) — readable by the API user and a
cleaner source anyway.

```js
// Read the FULL history per ticket (not just the window): deciding whether a move was a
// real completion needs the stage it came FROM, which may predate the window.
const hist = await kw("sh.helpdesk.ticket.stage.info", "search_read",
  [[["stage_task_id", "in", chunk]]],
  { fields: ["stage_task_id","stage_name","date_in","date_in_by"], order: "date_in asc, id asc" });
```

A **completion** = the first history line in the window where `stage_name` is terminal and the
*previous* line's stage was **not**. `Done → Closed` is terminal→terminal, so it yields
nothing. Reopen-then-reclose is detected and counted (30 seen in 7 days).

Terminal test is unchanged: `/clos|cancel|done|billing/i` on the stage NAME.

## Verified against 7 days of live data (read-only)

412 tickets touched · 366 genuine completions · 85 with human work · 259 AI-only ·
11 shared-credit · **38 completions re-attributed** vs the old rule · ledger balances exactly.

| Person | Tickets | Completions (humans-only) | (AI in split) |
|---|---|---|---|
| Cosmus Melly | 26 | 23.26 | 16.16 |
| Chris Rawlings | 29 | 21.52 | 13.25 |
| Zohaib Farooq | 23 | 18.66 | 15.56 |
| Fred Ortiz | 30 | 18.52 | 14.01 |
| Sean Miller | 7 | 3.05 | 1.69 (tagged *thin — do not rank*) |

## Files

| File | Purpose |
|---|---|
| `ledger.mjs` | reads Odoo read-only, builds the ledger → JSON |
| `render_report.mjs` | renders the report (inline styles — Outlook/O365 target) |
| `run.sh` | exports creds from CoreSettings, runs both |
| `send_report.py` | emails the HTML to one recipient |
| `attribution.mjs` + `test.mjs` | **superseded.** The single-assignee model from the first draft; kept because its 4 fixture tests still document the Done→Closed bug. The ledger replaces its credit rule. |

## Deploy (after approval)

1. Dump live `ai_helpdesk_code` to a timestamped `.bak`.
2. Port the stage-history detector + ledger scoring into `daily_activity`; replace the
   `closed` bump with per-contributor fractional credit.
3. Point `closed_without_reply` at a real completion event, not `closedIn`.
4. Decide which credit column is the official one (recommend humans-only).
5. Run one report and compare against `/tmp/work_ledger.json`.
