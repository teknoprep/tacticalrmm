# pibridge — Pi.dev ↔ Tactical RMM bridge

Node service that backs every AI surface in this RMM: the per-device chat, the
ticket-triage runs, the `ai-decision` technician chat, unattended/report tasks and the
Odoo chat surface. It holds the model runtime, the tool belt (device shell, tickets,
email, inventory), capability gating, approval gates and the spend meter.

**This directory is the source of truth.** `setup.sh` deploys it to
`/opt/pi-trmm-bridge`; `install.sh` and `update.sh` call `setup.sh` automatically, so a
TRMM update never leaves an old bridge running against new backend code.

```
src/          bridge code (server.js + tool belt + runtimes)
test/         node test suites - `npm test` (caps, cost meter, transcript, hardware)
docs/         design, decision log, change map, upgrade runbook
setup.sh      idempotent deploy: /rmm/pibridge -> /opt/pi-trmm-bridge, deps, unit, nginx
```

## Working on it

```bash
cd /rmm/pibridge
$EDITOR src/tools.js
npm test --prefix /opt/pi-trmm-bridge   # deps live with the deployed copy
bash setup.sh                           # deploy + restart
```

Edit **here**, never in `/opt/pi-trmm-bridge` — that is a deploy target. Editing the
deployed copy is how `src/` silently drifted from production for five weeks (2026-08-12
entry in `docs/DECISIONS.md`): five modules that `server.js` imports existed only in
`/opt`, so the tracked copy could not even start.

## Docs

`docs/` holds the engineering record — design, decisions, change map, upgrade runbook.
Internal/customer-specific material (capability & outcome reports, customer-reply
standards, unsanitised issue records) lives in the **private** `teknoprep/pi-ai-helpdesk`
repo instead: this fork is public, so nothing here may contain customer content, device
serials or credentials.
