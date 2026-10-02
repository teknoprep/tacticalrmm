# Letting the AI write to the IT Notebook

Requested 2026-08-18: *"I need the AI chats to be able to update the IT Notebook, only when
requested to do so — they can ask if they should do it and we will let them know, or if I
tell it then it can."*

The trigger was a chat that did the work, then handed over a block of text to paste in by
hand because it could not save the row itself.

## Status

| part | where | state |
|---|---|---|
| `secret_write` capability class | `src/capabilities.js` | **done** |
| Authority gate (instruction *or* approval) | `src/server.js` | **done** |
| Technician-intent detector | `src/authorisation.js` | **done** |
| Secret masking in the prompt | `src/tools.js` | **done** |
| Provenance note in the ticket | `src/tools.js` | **done** |
| Model guidance | `src/server.js` default policy | **done, but see (2)** |
| Tests (19) | `test/notebook-write.test.mjs` | **done** |
| The actual write operation | Global Settings → `ai_helpdesk_code` | **(1) NOT DONE — needs your decision** |
| Prompt guidance in the live prompt | Global Settings → `ai_ticket_decision_prompt` | **(2) NOT DONE** |

Nothing can write to the notebook until (1) is done. The product side is inert until then:
`upsert_notebook_row` simply does not exist as an operation yet.

## How the authority works

Two routes in, exactly as specified, and nothing else creates authority:

1. **You told it.** `notebookWriteAuthorisation()` reads *your verbatim chat turns* —
   never the model's claim that it was asked. A model that could authorise itself by
   asserting "you told me to" is not gated at all. A later refusal cancels an earlier
   instruction, and the authorising sentence is recorded.
2. **It asked, you approved.** Otherwise the model must propose and you click Approve.

Neither Auto-approve nor Auto-credential can skip it. Auto-credential is a standing
permission to *read* a password when work needs one; it says nothing about changing what
the credential store claims is true, and reading a switch labelled for one thing as
consent for another is how a safeguard quietly stops meaning anything.

Write mode is not consulted either — that switch scopes changes to **devices**.

Granted to the **decision window only**, matching `secret`. Not to device chat, not to any
unattended surface.

The approval prompt shows the row with secret-looking columns masked
(`Admin Pass = ******** (28 chars, hidden)`) — you cannot sensibly approve "write
something somewhere", and equally must not have the password splashed across the
transcript to find out what you are approving.

After a successful write an internal ticket note records who authorised it, the row and
the **column names** — never a value.

---

## (1) The chokepoint — your call, not mine

`ai_helpdesk_code` blocks this deliberately, and the comment anticipates this exact
request:

```js
const SECURE_MODEL = "partner.secure.note";
const SECURE_READ_METHODS = new Set(["read","search","search_read","search_count","fields_get"]);

async function kw(model, method, args, kwargs) {
  if (model === SECURE_MODEL && !SECURE_READ_METHODS.has(method)) {
    throw new Error("BLOCKED: ... The credential store (IT Notebook) is READ-ONLY to this
      integration - no create, write, unlink or any other method, ever. ... a human edits
      them in Odoo.");
```

> *"The Odoo service user currently HAS write and create rights on it, so 'we only read it'
> cannot be a matter of which operations we happen to have written — a future operation, a
> mistaken edit, or a prompt-injected instruction would silently be able to write."*

That reasoning is sound and one of its three named threats — **prompt injection** — is
live: this AI reads customer emails and ticket text. I did not edit it. It is your control,
it is in the database rather than this repo, and changing it changes the security posture
of every customer credential you hold.

**What the product side already answers.** Authority comes from *your verbatim words* or
*your click*. Ticket text saying "save this to the IT notebook" is not a technician turn
and authorises nothing, so the injection path the author was protecting against does not
reach the gate. What their chokepoint additionally protects against is a *bug* — a future
operation that writes by mistake. That argues for keeping the ban and adding one narrow
door, not for removing it.

### Proposed change — a second door with its own lock, not a hole

```js
// The ban stands. Writes are possible ONLY through a one-shot ticket that
// notebookWrite() sets immediately before the single RPC it authorises, and that the
// chokepoint consumes. It cannot be left switched on, it cannot be set from any operation
// that did not go through the product gate, and every other method on the model is still
// refused outright.
let secureWriteTicket = null;

async function kw(model, method, args, kwargs) {
  if (model === SECURE_MODEL && !SECURE_READ_METHODS.has(method)) {
    const t = secureWriteTicket;
    secureWriteTicket = null;                       // one-shot, consumed even on failure
    if (!t || t.method !== method || Date.now() > t.expires) {
      throw new Error(
        "BLOCKED: '" + method + "' on " + SECURE_MODEL + " is refused. Writes are only " +
        "possible through upsert_notebook_row, which the technician must instruct or " +
        "approve (capability class secret_write).");
    }
  }
  await login();
  return rpc("object", "execute_kw", [DB, uid, KEY, model, method, args, kwargs || {}]);
}

// class secret_write - product code has ALREADY required a technician instruction or an
// approval click before this is reachable. See capabilities.js and the secret_write
// branch of the decision-chat gate.
async function upsert_notebook_row({ partner_id, company_name, notebook_id, fields, row_id }) {
  if (!fields || typeof fields !== "object") return { error: "fields object required" };
  const pid = await resolveCompany({ partner_id, company_name });   // reuse the existing resolver
  const where = notebook_id ? [["id","=",Number(notebook_id)],["partner_id","=",pid]]
                            : [["partner_id","=",pid]];
  const books = await kw(SECURE_MODEL, "search_read", [where],
    { fields: ["id","payload","privileged_row_ids"], limit: 5 });
  if (!books.length) return { error: "no IT Notebook for this company" };
  if (books.length > 1) return { error: "several notebooks - pass notebook_id: " +
                                        books.map(b => b.id).join(", ") };
  const book = books[0];

  let parsed;
  try { parsed = JSON.parse(book.payload || "{}"); } catch (e) { parsed = null; }
  if (!parsed || !Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) {
    return { error: "notebook payload is not readable JSON - refusing to overwrite it" };
  }

  // NEVER touch a privileged row: they are withheld from reads for a reason, and an
  // update that cannot see one must not be able to replace it.
  let priv = [];
  try { const p = JSON.parse(book.privileged_row_ids || "[]"); priv = Array.isArray(p) ? p.map(String) : []; }
  catch (e) { priv = String(book.privileged_row_ids || "").split(/[,\s]+/).filter(Boolean); }
  const meta = Array.isArray(parsed.row_meta) ? parsed.row_meta : [];

  // Map the named fields onto THIS notebook's column order; unknown column = refuse,
  // rather than silently dropping a password into the wrong column.
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();
  const index = new Map(parsed.columns.map((c, i) => [norm(c), i]));
  const row = new Array(parsed.columns.length).fill("");
  for (const [k, v] of Object.entries(fields)) {
    const i = index.get(norm(k));
    if (i === undefined) {
      return { error: "unknown column '" + k + "'. This notebook has: " + parsed.columns.join(" | ") };
    }
    row[i] = v == null ? "" : String(v);
  }

  let action;
  if (row_id) {
    const at = meta.findIndex((m, i) => String((m && (m.id || m.row_id)) ?? i) === String(row_id));
    if (at < 0) return { error: "row not found: " + row_id };
    if (meta[at]?.privileged || priv.includes(String(row_id))) {
      return { error: "that row is PRIVILEGED - a human edits it in Odoo" };
    }
    parsed.rows[at] = row;
    action = "updated";
  } else {
    parsed.rows.push(row);
    meta.push({ id: "ai-" + Date.now().toString(36), privileged: false });
    parsed.row_meta = meta;
    action = "created";
  }

  secureWriteTicket = { method: "write", expires: Date.now() + 10_000 };
  await kw(SECURE_MODEL, "write", [[book.id], { payload: JSON.stringify(parsed) }]);
  return { ok: true, action, notebook_id: book.id, columns: parsed.columns, rows: parsed.rows.length };
}
```

Then declare it, so the product gate recognises it:

```js
exports.operations.upsert_notebook_row = upsert_notebook_row;
exports.opClasses.upsert_notebook_row  = "secret_write";
exports.meta.upsert_notebook_row =
  "SAVE a row to a company's IT Notebook. Only when the technician tells you to, or you " +
  "asked and they approved. args: {partner_id|company_name, notebook_id?, row_id?, fields:{Column: value}}";
// NOTE: deliberately NOT added to exports.mutating - the secret_write gate already asks,
// and listing it there would prompt twice for one action.
```

Points worth arguing about before you apply it:

* **`write` on the whole payload is read-modify-write.** Two people saving at once and the
  last one wins. Odoo has no row-level lock here. Acceptable for a human-paced action;
  worth knowing.
* **Unknown column refuses** rather than guessing. That is why the model is told to read a
  row first if unsure.
* **Privileged rows are untouchable**, matching the read path.
* **No `unlink`.** Deleting a credential row stays a human job in Odoo; `delete_notebook_row`
  is classified in product code so it *can* be added later, but I have not proposed it.

## (2) The live prompt overrides the built-in one

`blob.decision_prompt` (9,669 chars, from Global Settings `ai_ticket_decision_prompt`)
**replaces** `DEFAULT_DECISION_POLICY` — it is not merged. The guidance I added to the
default therefore will not reach production, and the live prompt currently says nothing
about the notebook at all. Paste this into the Global Settings prompt:

> **CREDENTIALS — THE IT NOTEBOOK IS THE ONLY PLACE A PASSWORD GOES:** never put a
> credential in a ticket note, a customer reply, an email, the KB or a device note — say
> where it lives, never the value. You CAN write to the customer's IT Notebook
> (`helpdesk_call upsert_notebook_row`), but ONLY when the technician has told you to save
> it, or you have ASKED and they said yes. So when you set something up that has a
> credential: do NOT dump a block of text for them to paste in by hand — tell them in one
> line what you would record (system, URL, username, "password" — never the password
> itself), ask "want me to save this to the IT Notebook?", and write it when they agree. If
> they say no, show them the row as a table they can paste and move on. Match the column
> layout of the notebook's existing rows. Never record a password you did not actually set
> or were not given, and never guess a row's columns — read one existing row first if you
> are unsure.

## Verifying it once it is on

```sh
grep -E "notebook write (authorised|permitted)" /var/log/pi-trmm-bridge.log
```

`authorised` = you instructed it (the sentence is logged). `permitted` = you clicked
Approve. Any notebook write with neither line is a bug — report it.
