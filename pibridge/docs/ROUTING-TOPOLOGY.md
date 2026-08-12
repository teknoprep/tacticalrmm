# Pi.dev AI — Ticket Routing Topology

Purpose: one fixed pipeline that new behaviour plugs into as **rules**, not new code paths.

---

## PART 1 — How tickets get created

Every path ends in the helpdesk, which is the single source of truth. Nothing keeps
ticket state anywhere else.

| # | Surface | Trigger | Bridge endpoint | Tool set | Ticket op | Dedup | Who approves |
|---|---------|---------|-----------------|----------|-----------|-------|--------------|
| 1 | **AI Task** (per device) | `dispatch_due_ai_tasks` (beat) → `run_ai_task` | `/pi/run` | `buildTools` | `create_ticket` | `dedup_key` | nobody — `gate: () => true` |
| 2 | **Bulk AI Command** (fleet) | `dispatch_due_bulk_ai_commands` → `run_bulk_ai_command` → fan-out `run_bulk_ai_agent`, chord → `finalize_bulk_report` | `/pi/run` per device, then `/pi/report` | `buildTools`, then `buildReportTools` | `submit_report` (ONE combined ticket) | idempotent by subject+customer | nobody |
| 3 | **Human** | customer emails / portal | — | — | created in helpdesk directly | helpdesk's own | n/a |
| 4 | **Scheduled Action** | `dispatch_due_ai_scheduled_actions` → `run_ai_scheduled_action` | `/pi/run` | `buildTools` | full op list | — | human created the action |

Notes:
- 1, 2 and 4 are **machine-authored**: an LLM decides to file, using ops defined in
  `helpdesk.js`. 3 is **human-authored** and only ever *observed*.
- Bulk deliberately collapses N devices into ONE ticket (`submit_report`), where AI
  Tasks file per-device (`create_ticket` + `dedup_key`). That difference is intentional.

---

## PART 2 — The single handling pipeline

```
        ┌─────────── SOURCES ───────────┐
        │ AI Task   Bulk   Human   Sched│
        └───────────────┬───────────────┘
                        ▼
              HELPDESK (source of truth)
                        ▼
   INTAKE   poll_helpdesk_tickets (~90s) → /pi/tickets/poll
            • is_alert?  (subject prefix / from-domain)
            • in scope?  (look_at_all / alerts_always / look_domains)
            • upsert AITicketState (unique by ticket_ref)
            • re-engage? (last_message_id, assignee_seen, last_change_seen)
                        ▼
   VERIFY   /pi/verify-alert — CODE + device evidence, before any LLM
            • rule match → prove host ownership → read-only evidence → verdict
            • noise + live      → CANCEL, stop here (no LLM call at all)
            • actionable/human  → set forbid_cancel, pass verified_fact forward
                        ▼
   CLASSIFY /pi/ticket-triage — the LLM, holding NO mutating tools
            • submit_triage only → alert_clean | alert_actionable | regular | unknown
                        ▼
   DECIDE   deterministic, in Django/bridge code — never the model
            ├─ alert_clean + act_enabled + !forbid_cancel → CANCEL (stage 5)
            ├─ alert_actionable                          → CLAIM / flag + note
            ├─ regular | unknown                         → shadow note + chat link
            └─ needs_input                               → Johnny 5 tag
            + attribution (set_ticket_company), one-time, automation-only
                        ▼
   ESCALATE decision chat (stateful WebSocket, human present)
            • Write mode OFF by default, per-turn approvals
            • privileged (identity/access) ops require an approved Support Contact
            • assigns the ticket to the tech on their first message
                        ▼
   ASSIST   auto-resolve (console, opt-in per ticket) — read-only
            • blockOps: resolve/close/cancel/ai_close/claim; no customer email
                        ▼
   LEARN    mine_ticket_procedures (~30m) — closed tickets + decision transcripts
            → AI Procedures + per-company KB → feeds VERIFY and CLASSIFY
```

---

## PART 3 — Routing decision points

Three independent axes. Understanding these three explains every routing outcome.

1. **LOOK scope** — which tickets we triage at all
   `look_at_all_unassigned`, `always_look_at_alerts`, `look_domains`
2. **ACT scope** — which tickets we may take action on
   `auto_action_domains`, `auto_action_clients` (`*` = everything)
3. **Per-operation gates** — what may be done once we are acting
   verifier verdict · `forbid_cancel` · privileged-contact authz · Write mode /
   approval · `blockOps` · never-close-person-filed · never-reattribute-bot-created

Only clean alerts bypass axis 2 (auto-cancel is allowed for every client, because it
touches no device and contacts no customer).

---

## PART 4 — What is automatic, and what is not

### Automatic today
| Behaviour | Mechanism | Risk basis |
|---|---|---|
| Clean alerts → Cancelled | DECIDE, all clients | touches nothing |
| Verified backup noise → Cancelled | VERIFY rule + device evidence | proven on-box (currently dry-run) |
| Company/contact attribution | one-time, automation tickets only | reversible metadata |
| Internal note + chat link on everything triaged | DECIDE | staff-only |
| Add followers, assign to working tech | deterministic ops | reversible |
| Procedure + KB capture | LEARN | write-only to our own stores |
| **Customer replies** (conditions below) | ACT, per-task declared register | reversible during a hold window; voided the moment a human engages |

**Conditions on automatic customer replies** (policy changed 2026-07-26; see DECISIONS.md). All are
code-enforced, none require per-message human approval:

1. **Declared register.** Each task declares `technical` \| `general` \| `none`; **default `none`**.
   How technical a reply is, is the task author's call.
2. **Proven ownership.** No reply where customer/device ownership is unproven (§4.5, §4.7).
3. **Deferred send.** The reply is queued, not sent immediately, and is **voided** by any non-bot
   message or by assignment to a human — re-checked at send time, not only by the poller.
4. **One per ticket per window**, content-hash deduplicated.
5. **Full body recorded** before sending (§4.9).
6. **Floor at every register:** never disclose credential locations, secret paths, permission modes
   or access mechanics.
7. **Never** for identity/access, billing, contractual or legal content — those stay with a human
   and an approved Support Contact (§4.6).

### Deliberately NOT automatic
| Not automatic | Why |
|---|---|
| Customer replies where ownership is **unproven** | §4.5/§4.7 — a hostname match is not proof; unproven routes to a human |
| Customer replies on identity/access, billing, contractual or legal matters | §4.6 — must come from an approved Support Contact |
| Device changes | Write mode + approval; disruptive by nature |
| Identity/access actions | must come from an approved Support Contact |
| Closing person-filed tickets | never without a customer reply |
| Actionable alerts beyond claiming | the remaining step is a human decision → Johnny 5 |
| Anything for non-act-scope clients | look-only until piloted |
| Alerts whose host is not in RMM | cannot verify, so cannot conclude |

---

## PART 5 — Consolidation: where the topology is currently inconsistent

These are real defects found by reading the code, not hypotheticals.

### F1 — Creation surfaces hold unrestricted ticket power
`buildTools` (AI Tasks, bulk per-device, scheduled actions, device chat) exposes the
**entire** `helpdesk.js` op list, and headless runs pass `gate: () => true`. So a
scheduled task could in principle `cancel_ticket` / `ai_close_ticket` /
`reply_to_ticket` on any ticket — restrained only by prompt text. Meanwhile the
handling surfaces have hard code gates (`blockOps`, `gate`). Governance is
inconsistent across surfaces.

**Fix:** one capability table, enforced in code:
- CREATE surfaces → `create_ticket`, `submit_report`, `add_note`, `upsert_ai_kb_article`, read ops
- HANDLE surfaces → `+ reply_to_ticket`, `resolve_ticket`, `claim_ticket`, tag ops
- VERIFY → `cancel_ticket`, `add_note` only
- MINE → read ops + KB write

### F2 — Two cancel paths in triage
`alert_clean` is cancelled in two separate branches (act-enabled path and fallback
path). Adding `forbid_cancel` required patching both — classic drift risk.

**Fix:** `decideAction(verdict, flags) → {action, note}` computed once, executed once.

### F3 — Two different "is this alert type X" mechanisms
INTAKE decides `is_alert` from `subject_starts_with` prefixes; VERIFY decides ownership
from a rule's own `match()`. Two places to teach about a new alert type.

**Fix:** verifier rules become the single alert-classification layer.
`is_alert = (a verifier claims it) OR (prefix fallback)`.

### F4 — Customer↔client↔device resolution is duplicated
`auto_action_domains`, `auto_action_clients`, `client_map.by_domain`, plus the
company-name variants and the FQDN probe. A company filed as "Company, Contact Person" needed
comma-stripping; a ticket filed by a generic monitoring contact needed the FQDN probe. Each surface resolves slightly differently.

**Fix:** one resolution service used by every surface, returning
`{client, device, ownership_proven}`. Never trust a hostname without proof.

### F5 — Seven bridge endpoints, each with its own tool set and prompt
`/pi/run`, `/pi/report`, `/pi/ticket-triage`, `/pi/ticket-resolve`, `/pi/verify-alert`,
`/pi/tickets/poll`, `/pi/mine-procedures`.

They are really only four *kinds*: OBSERVE, DECIDE, ACT, LEARN.

**Fix:** keep the endpoints, but build tool sets from one
`capabilityProfile(kind)` so a new endpoint cannot invent its own permission model.

---

## PART 6 — The fixed topology, and the five ways to extend it

```
SOURCES → HELPDESK → INTAKE → VERIFY → CLASSIFY → DECIDE ─┬─ CLOSE
                                                          ├─ ESCALATE
                                                          └─ OBSERVE
                                    LEARN ────────────────┘
                                      └── feeds VERIFY + CLASSIFY
```

This shape does not change. New behaviour is added as data:

| To add… | Change | Code change? |
|---|---|---|
| auto-handling for a new alert type | a rule in `verifiers.js` | no |
| a known fix the AI can apply | an AI Procedure | no |
| who gets acted on | scope lists | no |
| judgment/policy | prompt boxes | no |
| a new helpdesk capability | an op in `helpdesk.js` | no |

Anything that does not fit one of those five is a signal the topology needs a
deliberate change — not another branch.
