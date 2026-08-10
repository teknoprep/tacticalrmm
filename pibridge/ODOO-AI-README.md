# Odoo AI integration — RMM side

The Odoo addon `ai_pi_bridge` (repo `blueuc/odoo-bluecloud`) talks to this server.
Division of labour, which matters for reviewing anything here:

- **Odoo executes.** Every read and write happens inside Odoo as the logged-in Odoo
  user, subject to Odoo ACLs and record rules.
- **This side only reasons.** It holds no Odoo credentials and cannot write to Odoo.
  Compromising it does not grant Odoo access.

## Files

| Path | Purpose |
|---|---|
| `api/tacticalrmm/core/odoo_ai.py` | `/core/ai/odoo/{health,identity,session,ui-config,brand,decision,work}` |
| `pibridge/src/odoo-chat.js` | WebSocket runtime; shared live sessions with fan-out |
| `pibridge/ai-integration/index.html` | the embedded chat page |
| `pibridge/deploy/nginx-*.conf` | nginx snippets (static page + WS origin map) |

Authentication is a shared secret, stored outside the repo
(`/home/tactical/.odoo-ai-secret` on the current host).

`CoreSettings.ai_erp_integration_enabled` is the master switch, **off by default** and
checked on every request, so the integration can be closed without touching nginx or
Odoo.

## KNOWN GAP — read before running migrations

This branch does **not** migrate cleanly on its own, and that is not fixable from
here.

Live has core migrations `0098`–`0108`. This repo's committed history stops at `0097`.
Eight of the missing eleven are **not** part of the Odoo work — they belong to the
`pi-ai-assistant` changes that are still uncommitted on the live server. `AISpendEntry`
does not exist in this repo at all; it arrives in `0104`.

Mine are `0106`, `0107`, `0108`, and they declare `0105` as a dependency because that
is the truth of the live database. Renumbering them to sit on `0097` was rejected
deliberately: migration names are recorded in `django_migrations`, so renaming them
would corrupt the history of the running system.

Two model edits are therefore **not** applied here and are listed for whoever closes
the gap:

- `AISpendEntry` surface choices — add `("odoo", "Odoo AI panel (CRM / quotations)")`.
  Without it the report still groups correctly (it groups by data, not by declared
  choices) but renders the raw string `odoo` as the label.
- `TicketWorkEntry` surface choices — add `("odoo_ai", "Odoo AI panel (CRM / quotations)")`.

Also uncommitted on the live server and not included here, because it is not mine:
`accounts/models.py`, `agents/views.py`, `core/serializers.py`, `core/tasks.py`,
`core/views.py`, and `pibridge/src/server.js` (which differs from this repo by ~251
lines). Five live bridge modules exist in no repository at all: `brand.js`,
`cost-meter.js`, `operator-tools.js`, `sales-runtime.js`.
