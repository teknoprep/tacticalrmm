# Agent groups: what each role is for, and which surfaces use them

Written 2026-09-27. Rollback/change log: `CONTEXT-TRIM-ROLLBACK.md`.

A group is a team of models for one job. The **orchestrator** is what the user (or the surface)
talks to; the other roles are handed narrow jobs so a long conversation does not keep re-sending
everything through one expensive model.

## Which roles the bridge uses BY ITSELF (no delegation needed)

| role | how it is reached | why it exists |
|---|---|---|
| `orchestrator` | it *is* the chat | the only model that sees the whole conversation |
| `judge` | automatically, before every device change / ticket action / email | the independent check on destructive actions. **The one role that must never be the same model as the actor** |
| `coder` | every code-authoring request is routed here (`routeCodeToCoder`) | the orchestrator applies the patch; the coder runs in a fresh context with the code-focused instructions |
| `researcher` | every `web_search` / `web_fetch` is routed here (`routeWebToResearcher`) | pages are read in a throwaway context and only the digest enters the chat |
| `summarizer` | compaction (`pickCompactionModel`) | keeps long chats cheap. Used only when it can hold the transcript, else the largest chat model is used |

Everything else — `scout`, `files`, `grep`, `planner`, `operator`, `reviewer` — happens **only if
the orchestrator calls `delegate`**. If the model never delegates to a role, that role costs
nothing and does nothing.

## Where the money is (last 30 days, measured)

Specialist spend by role: `coder` $1.70 (20 calls), `judge` $0.46 (13), `scout` $0.14 (24),
`grep`/`planner`/`operator`/`researcher`/`reviewer` under $0.10 each, **`files` never called once**.

So: the **orchestrator** is where the cost is (it re-reads the whole conversation every turn —
that is why its cache-read rate matters more than anything else), and a stronger **coder** is cheap
in absolute terms. `files` is dead weight: `read` and `grep` cover it.

## Which surfaces use a group

| surface | group | notes |
|---|---|---|
| AI Decision (ticket chat), Pi Chat (device chat) | the window's group, chosen per window | full support: judge, delegate, routing, compaction |
| **ticket triage** | **preferred group** (Settings > AI) | headless |
| **autowork** (a subject working a ticket) | **the subject's own group**, else the preferred group | headless |
| `pi` on a laptop/server (the relay) | the groups on the relay key | see `PI-RELAY.md` |
| mining / analyze / report / resolve / Odoo | the starred default AIModel | **not** group-aware yet |

### How a headless surface picks its group

1. An explicit group for that run — today: the subject's own group (`Ticket Automation Subjects`).
2. **Settings > AI > "Preferred agent group"** — the default for anything with no group of its own.
   Set to **IT** on 2026-09-27, so triage and autowork run on IT's orchestrator (DeepSeek V4.1
   Flash) instead of the starred default model (grok-4.7).
3. Nothing configured → the starred default `AIModel`, exactly as before (no specialists).

`core/agent_groups.py: headless_group_blob()` implements that order and returns the fields the
bridge needs (`agent_group`, `agent_group_keys`, `group_orchestrator`); the caller also puts the
orchestrator in the blob's own `provider`/`model_id` so logs and the spend ledger agree with what
actually ran.

### On the bridge side

`applyHeadlessGroup(blob, rt, log)` (agent-groups.js) applies it: the group's orchestrator is the
model, `ensureGroupModels` registers any roster model the runtime does not know, the roster is
appended to the prompt so the orchestrator can `delegate`, and `routeCodeToCoder` /
`routeWebToResearcher` are applied. **Authority is unchanged** — the surface's own gate still
decides what may happen. No judge is attached to triage/autowork: triage holds no mutating tool at
all, and autowork's gate refuses every device change and leaves customer contact to code after the
verdict, so a judge would have nothing to review.

Verified 2026-09-27: a synthetic ticket run through the real celery task used
`deepseek/deepseek-flash` for triage (5 ledger rows), where the same run previously used grok-4.7.

## Cost consequence

The headless surfaces spent **$156.61 last month**, all on grok-4.7 ($0.50/M cached re-read):
unattended $104.36, triage $22.77, mining $13.54, analyze $12.12, rest ~$3.83. On DeepSeek Flash
the same work is roughly 1–2% of that. `mining` / `analyze` / `report` / `resolve` / Odoo still run
on the starred default, so the same change is available for them when wanted.

## Current rosters (2026-09-27)

**IT** (default, 9 roles) — orchestrator `deepseek-flash` high, coder `deepseek-flash` high,
judge `claude-opus-5` high, planner/operator/reviewer `claude-sonnet-5`, scout `claude-haiku-4-5`,
researcher/summarizer `gpt-6-luna`.
Note: IT's coder is now the same model as its orchestrator, so that role buys context isolation,
not capability.

**Coding** (10 roles) — orchestrator `deepseek-flash` high, coder `deepseek-flash` high (was
`deepseek-v4-pro` max until 2026-09-27), planner/judge `claude-opus-5-5`, reviewer
`claude-sonnet-5`, scout/files/grep `claude-haiku-4-5`, researcher/summarizer `gpt-6-luna`.

**Coding+** — orchestrator `grok-4.7` (the expensive one), coder `claude-opus-5-5`, **no judge**.
Duplicates Coding at ~80× the per-turn cost with no safety review; recommended for deletion, and
its seed spec is the only one that no longer matches the database.

Suggested cleanup (not applied): drop `files` everywhere (never used), drop IT's
`planner`/`operator`/`reviewer` (0–3 calls each in a month), delete `Coding+`.

## MFA: ask before a phone rings (2026-09-27)

An MFA prompt nobody is ready for is a failed sign-in that counts against the account — four of
them locked a tenant admin out on TICKET/60427 (`AADSTS50053` x4). So:

1. **A stored TOTP code needs nobody.** `helpdesk_call list_totp` → `get_totp_code` → type the
   digits. No desktop, no question.
2. **Anything else** (phone call, SMS, push): the AI must ask in the chat first with
   `pause_queue` — naming the account, the client and (if shown) the number about to ring — state
   it in its reply, and **end its turn**. It clicks the option in the **next** turn, after the yes.
3. **Enforced in code**, not by convention: `mfaPhoneGate()` holds the contact-the-technician
   buttons until the technician's most recent turn is affirmative. An old "yes" from before a new
   prompt does not count; "no"/"wait"/a question blocks it; ordinary clicks and code entry are
   untouched.

This makes the *interactive* MFA path safe and smooth. It does **not** remove the human: for a
tenant whose admin accounts are MFA-bound with no stored TOTP, unattended Exchange work still
needs app-only certificate auth (Entra app + `Exchange.ManageAsApp` + admin consent) — see the
recommendation in this file's history.

## Backup model per role (2026-09-27)

A provider refusing outright — quota, billing, auth, a retired model — is not something the model
can work around, and retrying the same provider is pure cost. xAI did exactly that for two days
(`403 "has either used all available credits or reached its monthly spending limit"`, 30 times), and
every affected turn died mid-flight with nothing to fall back to.

So a role may name a **backup model**, and the bridge uses it:

1. The failure must be one a *different provider* could survive: quota, credits, billing, auth
   (401/403), rate limit (429), model-not-found, or an overloaded/unavailable endpoint (503).
   A stall, a timeout, a bad request or a Stop keeps its existing handling — a backup would not help.
2. The bridge switches the live session's model, says so in the window
   (*"xai is refusing requests, so this chat carried on with its backup model: Claude Sonnet 5"*),
   and continues the **same** conversation. The failed assistant turn stays in the session file but
   leaves the live state.
3. **Once per turn** (`beginTurn()` resets it), so a refusal cannot make it bounce between models.
4. Blank backup = today's behaviour exactly: the turn fails and the technician is told.
5. A backup equal to the primary model is refused, so a misconfiguration cannot "fall back" to itself.
6. The backup's provider key is included in the group's provider keys, and the model is checked
   against the bridge's runtime when used — an unresolvable backup logs `llm_fallback_missing`
   instead of silently doing nothing.

Configured today (only the orchestrator, which is the chat model — set others in
Settings > AI > Agent Groups, "Backup model if the provider refuses"):

| group | primary | backup |
|---|---|---|
| IT | deepseek/deepseek-flash | anthropic/claude-sonnet-5 |
| Coding | deepseek/deepseek-flash | anthropic/claude-sonnet-5 |
| Coding+ | xai/grok-4.7 | deepseek/deepseek-flash |

Specialists (coder, judge, scout…) run in their own sessions, so a backup there needs the same
treatment inside `runSpecialist` — not wired yet; today the orchestrator's backup is what keeps a
chat alive.

## xAI removed entirely (owner, 2026-09-27)

grok hit its monthly spending limit and every turn on it died mid-flight with
`403 "has either used all available credits or reached its monthly spending limit"`. Rather than
raise the limit and keep the exposure, xAI is switched off:

| where | was | now |
|---|---|---|
| Provider row `xai` | enabled | **disabled** — no key is sent to the bridge, so no chat can call it |
| `AIModel` grok-4.7 | **the starred default** (all headless work: unattended tasks, mining, report summary, Odoo, resolve) | disabled; the default is now a `deepseek/deepseek-flash` row |
| Coding+ orchestrator + planner | xai/grok-4.7 | deepseek/deepseek-flash (high / medium) |
| Coding+ orchestrator backup | deepseek (now the primary) | anthropic/claude-sonnet-5 |
| 14 chat windows that remembered grok | would reopen on grok and fail (pi resolves a built-in model with no key) | memory cleared; they fall back to their group orchestrator |
| `pickCompactionModel`'s 1M-token choice | named grok-4.3 | asks for the largest context that fits, naming no provider |

Re-enabling is one field (Provider row `xai` -> enabled) plus a model row and a group member.
Backups: `backups/pi-relay-20260927T112652Z/xai-removal-before.json` and `xai-window-memory/`.
