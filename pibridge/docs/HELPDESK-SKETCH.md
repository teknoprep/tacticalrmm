# SKETCH: Odoo Helpdesk ticket injection + admin "Helpdesk Prompt"

Status: **SKETCH / PROPOSAL — nothing here is wired in or deployed.**
Purpose: show *exactly* what the pieces look like so we can agree before building.

The design principle repeated throughout:

> **Prompt = judgment. Tool = guarantees.**
> The admin-editable prompt tells the model *when/how* to open a ticket.
> The `create_ticket` tool does the Odoo mechanics and enforces the hard rules
> (which partner, which team, dedup, allowed priorities). A wrong or manipulated
> prompt can never send a ticket to the wrong company, because the model never
> supplies `partner_id` — the tool resolves it from a trusted mapping.

---

## Piece 1 — Global Settings (Django `CoreSettings`)

Two kinds of fields. Keep them separate.

### 1a. Connection (structured — NOT prose)
```python
# core/models.py  (added next to the existing ai_* fields on CoreSettings)
odoo_url            = models.CharField(max_length=255, blank=True)   # https://erp.blueuc.com
odoo_db             = models.CharField(max_length=120, blank=True)   # odoo database name
odoo_api_user       = models.CharField(max_length=120, blank=True)   # e.g. "rmm-bot"
odoo_api_key        = models.CharField(max_length=255, blank=True)   # Odoo API key (encrypted at rest)
odoo_ticket_model   = models.CharField(max_length=120, blank=True)   # e.g. "helpdesk.ticket" (Softhealer model)
odoo_default_team_id= models.IntegerField(null=True, blank=True)     # fallback helpdesk team
helpdesk_enabled    = models.BooleanField(default=False)             # master switch for ticket injection
```

### 1b. Behavior (the "Helpdesk Prompt" — prose, admin-editable)
```python
helpdesk_prompt = models.TextField(blank=True, default="")           # injected into the AI system prompt
```

Surfaced as a big textarea in the existing **"AI / Pi.dev" tab** of
`EditCoreSettings.vue`, gated by `can_edit_core_settings` — same place the
provider keys and model catalog already live.

---

## Piece 2 — Client → Partner mapping (the thing that fixes wrong contacts)

The model must never choose the customer. We resolve it from the TRMM client the
task is already scoped to. Simplest reliable store: a TRMM **custom field** on the
client, or a small JSON the bridge reads. Sketch as JSON:

```jsonc
// /etc/pi-trmm-bridge/helpdesk-map.json   (root-only, synced from admin UI later)
{
  // TRMM client name  ->  Odoo res.partner id (+ optional team override)
  "Acme Corp":        { "partner_id": 412, "team_id": 3 },
  "BlueCloud":        { "partner_id": 87,  "team_id": 1 },
  "Contoso Ltd":      { "partner_id": 553 }
}
```

Lookup order in the tool: exact client match → (optional) site match → if none,
`res.partner.search([name ilike client])` as a **last-resort** and log a warning
so you can fill the gap. No match + no fallback = tool returns an error and the
run falls back to SMTP (never silently lost).

---

## Piece 3 — What Django sends to the bridge (added to the run `blob`)

Django already builds the `blob` for `POST /pi/run`. We add:

```jsonc
{
  // ...existing fields (agent_id, device_facts, provider, model_id, prompt, ...)
  "helpdesk": {
    "enabled": true,
    "prompt":  "<CoreSettings.helpdesk_prompt text>",
    "odoo": {
      "url": "https://erp.blueuc.com",
      "db": "blueuc",
      "user": "rmm-bot",
      "api_key": "***",              // decrypted server-side, localhost redis, short TTL
      "ticket_model": "helpdesk.ticket",
      "default_team_id": 1
    }
  }
}
```

`device_facts.client` / `device_facts.site` are already in the blob — that's what
drives partner resolution.

---

## Piece 4 — System-prompt injection (bridge, `server.js`)

Today the headless run builds the prompt at `server.js:337`. We append the admin
helpdesk prompt only when helpdesk is enabled:

```js
// bridge/src/server.js  (inside runHeadless, systemPromptOverride)
systemPromptOverride: () =>
  systemPrompt(facts) +
  `\n\nSCHEDULED CHECK MODE:\n- You are running unattended...` +   // (unchanged)
  (blob.helpdesk?.enabled
    ? `\n\nHELPDESK POLICY:\n${blob.helpdesk.prompt}\n` +
      `To open a ticket, call the create_ticket tool. Do NOT include customer, ` +
      `partner, or team details — those are set automatically for the client this ` +
      `check belongs to (${facts.client}${facts.site ? " / " + facts.site : ""}).`
    : ""),
```

Same one-line append can be added to the interactive path at `server.js:101` if
you ever want techs to open tickets from a live chat.

---

## Piece 5 — The `create_ticket` tool (bridge, `tools.js`)

Same shape as the existing `report_result` tool. The model supplies only free-text
and a priority; everything routing-related is resolved by the tool.

```js
// bridge/src/tools.js  (added when opts.helpdesk?.enabled)
const create_ticket = defineTool({
  name: "create_ticket",
  label: "Open helpdesk ticket",
  description:
    "Open a ticket in the helpdesk for a technician to act on. Use ONLY per the " +
    "HELPDESK POLICY. You provide subject, body and priority; the customer/contact, " +
    "team and dedup are set automatically. Returns the ticket reference.",
  parameters: Type.Object({
    subject:  Type.String({ description: "Short one-line ticket title" }),
    body:     Type.String({ description: "What was observed, evidence, recommended action" }),
    priority: Type.String({ description: "'low' | 'normal' | 'high' | 'urgent'" }),
  }),
  execute: async (_id, p) => {
    const pri = ["low", "normal", "high", "urgent"].includes((p.priority || "").toLowerCase())
      ? p.priority.toLowerCase() : "normal";

    // Trusted resolution — model input is NOT used to pick the customer.
    const target = resolvePartner(facts.client, facts.site);   // Piece 2 lookup
    if (!target) {
      return text(`No Odoo partner mapping for client "${facts.client}". ` +
                  `Ticket NOT created (will fall back to email).`);
    }

    // Idempotency: don't spawn duplicates on recurring checks.
    const ref = `RMM:${facts.client}:${opts.checkName || "check"}:${todayStamp()}`;
    const existing = await odoo.findTicketByRef(ref);
    if (existing) {
      await odoo.logNote(existing.id, `Recurring: ${p.subject}\n\n${p.body}`);
      return text(`Existing ticket #${existing.id} updated (ref ${ref}).`);
    }

    const ticket = await odoo.createTicket({
      subject: p.subject,
      body: p.body,
      priority: pri,
      partner_id: target.partner_id,
      team_id: target.team_id ?? opts.helpdesk.odoo.default_team_id,
      ref,
    });
    return text(`Ticket #${ticket.id} opened for ${facts.client} (ref ${ref}).`);
  },
});

// pushed into the toolset only when helpdesk is enabled for this run
if (opts.helpdesk?.enabled) tools.push(create_ticket);
```

---

## Piece 6 — The Odoo client (bridge, new `odoo.js`)

Thin XML-RPC client, same spirit as `trmm.js`. Two round-trips: `authenticate`
then `execute_kw`. (Exact model/field names get confirmed by the read-only
discovery script before this is real.)

```js
// bridge/src/odoo.js  (SKETCH)
import xmlrpc from "xmlrpc";   // small, or hand-roll the two XML-RPC calls

export function makeOdoo(cfg) {          // cfg = blob.helpdesk.odoo
  const common = xmlrpc.createSecureClient({ url: `${cfg.url}/xmlrpc/2/common` });
  const models = xmlrpc.createSecureClient({ url: `${cfg.url}/xmlrpc/2/object` });
  let uid;

  const login = () => new Promise((res, rej) =>
    common.methodCall("authenticate", [cfg.db, cfg.user, cfg.api_key, {}],
      (e, id) => e ? rej(e) : (uid = id, res(id))));

  const call = (model, method, args, kw = {}) => new Promise((res, rej) =>
    models.methodCall("execute_kw", [cfg.db, uid, cfg.api_key, model, method, args, kw],
      (e, v) => e ? rej(e) : res(v)));

  return {
    async createTicket({ subject, body, priority, partner_id, team_id, ref }) {
      if (!uid) await login();
      const vals = {
        name: subject,                 // <- field names TBD from discovery
        description: body,
        priority: mapPriority(priority),
        partner_id,
        team_id,
        // x_rmm_ref: ref,             // a dedup field (custom field or existing ref)
      };
      const id = await call(cfg.ticket_model, "create", [vals]);
      return { id };
    },
    async findTicketByRef(ref) {
      if (!uid) await login();
      const ids = await call(cfg.ticket_model, "search",
        [[["x_rmm_ref", "=", ref], ["stage_id.is_closed", "=", false]]], { limit: 1 });
      return ids.length ? { id: ids[0] } : null;
    },
    async logNote(id, msg) {
      if (!uid) await login();
      return call(cfg.ticket_model, "message_post", [[id]], { body: msg });
    },
  };
}
```

---

## Flow end to end

```
Scheduled "Unifi Checkup" fires (celery)
   → Django reads CoreSettings (helpdesk_enabled, helpdesk_prompt, odoo_* )
   → POST /pi/run  with blob.helpdesk = {enabled, prompt, odoo:{...}}
        → bridge runHeadless():
             system prompt = deviceFacts + SCHEDULED MODE + HELPDESK POLICY(prompt)
             tools = [ ...device tools, report_result, create_ticket ]
             model investigates UniFi...
               decides it's ticket-worthy per the policy prompt
               calls create_ticket({subject, body, priority})
                  → resolvePartner(client) -> partner_id (TRUSTED mapping)
                  → dedup check by ref
                  → odoo.createTicket(...)  -> ticket #1234 opened to correct contact
               calls report_result({status:'alert', summary, details})
   → verdict returned to Django (as today)
   → if create_ticket failed/no mapping: Django falls back to the current SMTP path
```

No more `randomstring@blueuc.com`: the ticket is created directly on the correct
`res.partner`, with a clean subject/body the tech can act on, and duplicates are
suppressed on recurring runs.

---

## Open items to confirm before building (unchanged from prior discussion)
1. Exact Softhealer model name + required fields (run read-only discovery script).
2. Where the client→partner map lives (TRMM custom field vs. JSON file vs. admin UI table).
3. Dedup field: reuse an existing ref field or add a custom field `x_rmm_ref` in Odoo.
4. Whether to also allow `create_ticket` in interactive tech chats (server.js:101).
