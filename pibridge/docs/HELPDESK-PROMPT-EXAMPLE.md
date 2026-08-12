# Example: Helpdesk Ticket Policy prompt (Odoo 17 + Softhealer helpdesk)

Sanitized example of the admin-defined prompt stored in
**Global Settings → Pi.dev AI → Helpdesk Ticket Policy**. This text fully defines
the ticketing integration — *when* to open tickets and *how* (the exact API calls)
— executed by the AI through the generic `helpdesk_api_request` tool.

Companion settings (same screen):
- **Ticketing API base URL** — e.g. `https://erp.example.com`
- **Ticketing API key** — stored server-side; the AI writes the literal
  placeholder `{{HELPDESK_API_KEY}}` in request bodies and the bridge substitutes
  the real key. The key is never placed in the AI's context, and responses are
  scrubbed before the AI sees them. Requests can only go to the base URL host.

Replace ALL-CAPS placeholders with your values.

---

```
== WHEN to open a ticket ==
Open a helpdesk ticket when a finding requires a technician to act: a scheduled
check returns warning/alert, or the operator asks for a ticket. Do NOT open
tickets for 'ok' results or transient conditions that self-recovered. Never
invent device names, IPs or customer details; only use what your tools returned.

== HOW to open a ticket (Odoo 17 JSON-RPC at the configured base URL) ==
All calls: POST path /jsonrpc with Content-Type application/json. Write the
literal placeholder {{HELPDESK_API_KEY}} where the API key belongs; it is
substituted server-side.

1) Authenticate once per session to get uid:
{"jsonrpc":"2.0","method":"call","params":{"service":"common","method":"authenticate","args":["YOUR_DB_NAME","YOUR_API_USER_LOGIN","{{HELPDESK_API_KEY}}",{}]},"id":1}
All later calls use:
{"jsonrpc":"2.0","method":"call","params":{"service":"object","method":"execute_kw","args":["YOUR_DB_NAME",<uid>,"{{HELPDESK_API_KEY}}","<model>","<method>",[<args>],{<kwargs>}]},"id":2}

2) Resolve the customer (res.partner) - CLOSEST-MATCH LADDER. Start from the
customer name in play (this session's client, or the site/customer the task or
operator specifies). All searches: model res.partner, method search_read,
kwargs {"fields":["id","name"],"limit":10}.
   a. Near-exact: args [[["is_company","=",true],["name","=ilike","<name>"]]].
   b. If none: substring: args [[["is_company","=",true],["name","ilike","<name>"]]].
   c. If none: strip legal suffixes (LLC, Inc, Corp, Co, Ltd) and punctuation,
      then search the 1-2 most DISTINCTIVE words of the name separately.
   d. Judge the candidates: pick the ONE that is clearly the same company
      despite spelling/punctuation/abbreviation/suffix differences. If exactly
      one candidate is clearly right, use it.
   e. If there are NO candidates, or multiple plausible ones you cannot
      confidently separate: in an interactive chat, list the candidates and ask
      the operator; in a scheduled run, use the DEFAULT partner_id
      FALLBACK_INTERNAL_PARTNER_ID (your own company's partner, so nothing
      leaks to a customer) and begin the ticket body with
      "CUSTOMER UNMATCHED: intended for <name>" so a human can reassign it.
   NEVER guess between two different real customers - when unsure, use the
   default. NEVER skip the ticket because matching failed.

3) DUPLICATE CHECK - ALWAYS do this before creating ANY ticket. Never open a
second ticket for the same underlying issue:
   a. List this customer's tickets in ALL stages (you can see the tickets this
      integration's user created): model sh.helpdesk.ticket, method
      search_read, args [[["partner_id","=",<partner_id>]]],
      kwargs {"fields":["id","name","email_subject","create_date","stage_id"],"limit":30}.
   b. Compare your new finding against their subjects. For any plausible
      candidate, read its body: method read, args [[<id>]],
      kwargs {"fields":["description"]}.
   c. If one clearly concerns the SAME underlying issue (same device/site/
      problem, even if worded differently or from an earlier day):
      - If it is OPEN (stage_id not in [CLOSED_STAGE_ID,CANCELLED_STAGE_ID]):
        do NOT create. UPDATE it via message_post with: date/time of this
        check, whether the situation is UNCHANGED / IMPROVED / WORSE, and the
        new evidence. If the issue has persisted across multiple checks,
        escalate bluntly ("Still unresolved since <create_date> - failed N
        consecutive checks, needs action now"). Then stop.
      - If it is CLOSED or CANCELLED: do NOT create a duplicate. REOPEN it:
        method write, args [[<id>],{"stage_id":NEW_STAGE_ID}], then
        message_post a note stating it was REOPENED because the same issue
        recurred or was not actually resolved (date/time, new evidence, why
        you are confident it is the same issue). A different problem on the
        same device/site gets a NEW ticket.
   d. Only if NO existing ticket matches the issue, proceed to create (step 4).

4) Create the ticket: model sh.helpdesk.ticket, method create,
args [{"partner_id":<id>,"team_id":ALERTS_TEAM_ID,"email_subject":"<subject>","description":"<html body ending with a line: ref: RMM:<client>:<short-slug>:<YYYY-MM-DD>>"}].
Subject format: [Category] Site - one-line problem
(e.g. [UniFi] Main Office - controller unreachable).
Body (HTML paragraphs): what you observed, the evidence, the affected
device/site, recommended next action, in plain language for the tech.

5) The system may override the team on create: method read on the new id with
{"fields":["team_id"]}; if team_id is not ALERTS_TEAM_ID, method write,
args [[<id>],{"team_id":ALERTS_TEAM_ID}].

6) Report the resulting ticket name/number (e.g. TICKET/12345) back to the
operator or in your run summary.
```

---

## Placeholder reference

| Placeholder | What it is | How to find yours |
|---|---|---|
| `YOUR_DB_NAME` | Odoo database name | `xmlrpc/2/db` list, or ask your Odoo admin |
| `YOUR_API_USER_LOGIN` | Login of the least-privilege service user | Settings → Users (needs helpdesk create + contacts read; member of the target team) |
| `{{HELPDESK_API_KEY}}` | Literal text — do NOT replace | Substituted by the bridge from Global Settings |
| `FALLBACK_INTERNAL_PARTNER_ID` | `res.partner` id of YOUR OWN company | so unmapped clients never misroute to a customer |
| `ALERTS_TEAM_ID` | `sh.helpdesk.team` id tickets should land on | `search_read` on `sh.helpdesk.team` |
| `CLOSED_STAGE_ID`, `CANCELLED_STAGE_ID` | `helpdesk.stages` ids that mean "not open" | `search_read` on `helpdesk.stages` |
| `NEW_STAGE_ID` | stage a reopened ticket goes back to | `search_read` on `helpdesk.stages` (or a dedicated "Reopened" stage if you have one) |

## Notes / gotchas discovered on a real install
- Softhealer's ticket model is `sh.helpdesk.ticket` (not Enterprise `helpdesk.ticket`).
  The human-readable subject is **`email_subject`**; `name` is an auto sequence
  (TICKET/xxxxx). Body is HTML in `description`.
- `priority` is a many2one to `helpdesk.priority` — if that table is empty on
  your install, omit priority entirely.
- Softhealer's `create()` **clamps `team_id` to a team the API user belongs to**
  (hence step 5's read-back + corrective write, and why the service user must be
  a member of the target team).
- Record rules scope the API user to its own teams' tickets — good: dedup
  searches can only match RMM-created tickets, never human tickets in other teams.
- Switching ticketing systems entirely = replace this prompt text + base URL +
  API key in Global Settings. No code changes.
```
