// IT Notebook WRITE authority (class `secret_write`).
//
// Owner's ruling 2026-08-18: the AI should be able to save a row, but "only when requested
// to do so - they can ask if they should do it and we will let them know, or if I tell it
// then it can." Two routes to the authority, and nothing else may create it.
//
// These are the adversarial cases, because this class can change what every future
// technician is told is the password to a customer system.

import test from "node:test";
import assert from "node:assert/strict";
import {
  CLASSES, SURFACE_CLASSES, NAME_DEFAULTS, classOf,
} from "../src/capabilities.js";
import { describeSecretFields, notebookWriteSummary } from "../src/tools.js";
import { notebookWriteAuthorisation } from "../src/authorisation.js";

const said = (...lines) => lines.map((text, i) => ({ at: `2026-08-18T1${i}:00:00.000Z`, text }));

// ---------------------------------------------------------------- the class

test("secret_write is a real class, distinct from secret", () => {
  assert.ok(CLASSES.includes("secret_write"));
  assert.notEqual("secret", "secret_write");
});

test("only the decision window may write to the notebook", () => {
  assert.ok(SURFACE_CLASSES.decision_chat.includes("secret_write"));
  for (const surface of ["unattended", "report", "device_chat", "auto_resolve", "triage", "mining"]) {
    assert.equal(SURFACE_CLASSES[surface].includes("secret_write"), false,
      `${surface} must never write credentials`);
  }
});

test("no unattended surface gained credential access of any kind", () => {
  for (const surface of ["unattended", "report", "auto_resolve", "triage", "mining"]) {
    assert.equal(SURFACE_CLASSES[surface].includes("secret"), false, surface);
    assert.equal(SURFACE_CLASSES[surface].includes("secret_write"), false, surface);
  }
});

test("conventional write op names classify as secret_write, reads stay secret", () => {
  for (const op of ["upsert_notebook_row", "update_notebook_row", "create_notebook_row",
                    "delete_notebook_row", "set_partner_credentials", "write_secure_note"]) {
    assert.equal(NAME_DEFAULTS[op], "secret_write", op);
  }
  for (const op of ["get_partner_credentials", "get_credentials", "read_secure_notes"]) {
    assert.equal(NAME_DEFAULTS[op], "secret", op);
  }
});

test("an unclassified write operation is still denied by default", () => {
  // MANDATE: a new operation can never silently inherit authority.
  assert.equal(classOf("save_the_thing_somewhere", {}), null);
});

test("a deployment tag beats the name default", () => {
  assert.equal(classOf("upsert_notebook_row", { upsert_notebook_row: "note" }), "note");
  assert.equal(classOf("company_vault_put", { company_vault_put: "secret_write" }), "secret_write");
});

// ------------------------------------------------- "if I tell it, then it can"

test("a plain instruction to save it authorises the write", () => {
  for (const line of [
    "save this to the IT notebook",
    "please add it to the IT Notebook",
    "put those credentials in the notebook",
    "record this in the credential store",
    "update the notebook with the grafana login",
    "go ahead and store that in the it-notebook",
  ]) {
    assert.ok(notebookWriteAuthorisation(said(line)), line);
  }
});

test("the authorising sentence is returned, for the audit trail", () => {
  const auth = notebookWriteAuthorisation(said("save this to the IT notebook please"));
  assert.match(auth.text, /save this to the IT notebook/);
  assert.ok(auth.at, "must carry a timestamp");
});

test("talking about the notebook is not the same as asking for a write", () => {
  for (const line of [
    "what does the IT notebook say for this customer?",
    "the notebook has the old password",
    "is grafana in the notebook?",
    "check the IT Notebook for the admin user",
  ]) {
    assert.equal(notebookWriteAuthorisation(said(line)), null, line);
  }
});

test("an instruction about something else does not leak into notebook authority", () => {
  for (const line of [
    "save this to the KB",
    "add a note to the ticket",
    "write up what you did",
    "document the fix",           // no notebook target named
    "store it somewhere sensible",
  ]) {
    assert.equal(notebookWriteAuthorisation(said(line)), null, line);
  }
});

// The action has to be aimed AT the notebook. A first cut matched any action word plus
// the word "notebook" anywhere in the sentence, which turned an instruction to write a
// TICKET NOTE that merely mentioned the notebook into permission to write a credential.
test("an action aimed at something else is not authority over the notebook", () => {
  for (const line of [
    "add a note about the notebook",
    "add a note to the ticket saying the password is in the IT notebook",
    "write up where the notebook lives",
    "create a KB article explaining our notebook conventions",
    "put a comment on the ticket about the notebook entry",
  ]) {
    assert.equal(notebookWriteAuthorisation(said(line)), null, line);
  }
});

test("the natural orders both work", () => {
  assert.ok(notebookWriteAuthorisation(said("IT Notebook: save this row please")),
    "target first");
  assert.ok(notebookWriteAuthorisation(said("add a new row to the customer's IT notebook")),
    "action first, with possessive filler");
  assert.ok(notebookWriteAuthorisation(said("record these credentials in their notebook")),
    "action first, with plural filler");
});

test("a refusal is operative, and outranks an older yes", () => {
  for (const line of [
    "don't save it to the notebook",
    "do not add that to the IT notebook",
    "not yet - hold off writing it to the notebook",
    "just show me the notebook row, don't save it",
  ]) {
    assert.equal(notebookWriteAuthorisation(said(line)), null, line);
  }
  // Newest instruction wins: they changed their mind.
  assert.equal(
    notebookWriteAuthorisation(said("save it to the IT notebook", "actually don't save it to the notebook")),
    null,
    "a later refusal must cancel an earlier instruction",
  );
});

test("a yes AFTER a refusal re-authorises", () => {
  const auth = notebookWriteAuthorisation(
    said("don't put it in the notebook yet", "ok now save it to the IT notebook"),
  );
  assert.ok(auth);
  assert.match(auth.text, /now save it/);
});

test("the model cannot authorise itself", () => {
  // Only the technician's verbatim turns are ever passed in. This is the property that
  // makes the whole gate meaningful: a model that could say "you told me to" would be
  // handing itself the decision.
  assert.equal(notebookWriteAuthorisation([]), null);
  assert.equal(notebookWriteAuthorisation(said("")), null);
  assert.equal(notebookWriteAuthorisation(undefined) ?? null, null);
});

// ------------------------------------------------------------ secret masking

test("password-ish columns are masked in the approval prompt", () => {
  const shown = describeSecretFields({
    Info: "Observability Grafana (docker1)",
    "LAN IP": "http://10.1.11.9:3000",
    "Admin User": "admin",
    "Admin Pass": "xEhvfSsj1TfjzP0MDpa1qCT2oUkZ",
  });
  assert.match(shown, /Admin User = admin/);
  assert.match(shown, /LAN IP = http:\/\/10\.1\.11\.9:3000/);
  assert.doesNotMatch(shown, /xEhvfSsj1TfjzP0MDpa1qCT2oUkZ/, "the password must never be shown");
  assert.match(shown, /Admin Pass = \*{8} \(28 chars, hidden\)/);
});

test("every flavour of secret column name is caught", () => {
  const shown = describeSecretFields({
    password: "a", passwd: "b", pwd: "c", api_key: "d", "API Key": "e",
    token: "f", client_secret: "g", passphrase: "h", "private-key": "i",
  });
  assert.doesNotMatch(shown, /= [a-i]$/m, `a raw secret leaked:\n${shown}`);
  assert.equal((shown.match(/hidden/g) || []).length, 9);
});

test("a long non-secret value is truncated, not dumped into the transcript", () => {
  const shown = describeSecretFields({ Notes: "x".repeat(500) });
  assert.ok(shown.length < 200);
  assert.match(shown, /…$/);
});

test("empty and structural fields are skipped", () => {
  const shown = describeSecretFields({ a: "", b: null, c: undefined, d: { nested: 1 }, e: "keep" });
  assert.equal(shown.trim(), "e = keep");
});

// ------------------------------------------------------- the approval prompt itself
//
// Regression 2026-08-19: the first version of this branch was inline inside helpdesk_call
// and referenced an `op` variable that does not exist in that scope. Nothing in the branch
// was reachable from a test, so the ReferenceError ("op is not defined") only surfaced when
// a technician actually tried to save a row. The summary builder is now a pure function,
// for exactly this reason.

const ROW = {
  "Info": "Observability Grafana (docker1)",
  "LAN IP": "https://grafana.farmerboyag.com",
  "Admin": "https",
  "Admin User": "admin",
  "Admin Pass": "xEhvfSsj1TfjzP0MDpa1qCT2oUkZ",
  "Additional 1": "Prometheus http://10.1.11.9:9090",
};

test("the prompt builds without throwing, for every arg shape the model sends", () => {
  for (const args of [
    { partner_id: 9547, notebook_id: 28, row: ROW },
    { partner_id: 9547, notebook_id: 28, fields: ROW },
    { company_name: "FarmerBoy AG", row: ROW },
    { partner_id: 9547, notebook_id: 28, values: ["a", "", "c"] },
    { partner_id: 9547, notebook_id: 28, row: ROW, match_info: "Observability Grafana (docker1)" },
    {},                                    // nothing at all must still not throw
  ]) {
    const out = notebookWriteSummary({
      operation: "upsert_partner_notebook_row", args, ticketRef: "TICKET/60184",
    });
    assert.equal(typeof out.summary, "string");
    assert.ok(out.summary.length > 0);
  }
});

test("the prompt names the row and notebook, and hides the password", () => {
  const out = notebookWriteSummary({
    operation: "upsert_partner_notebook_row",
    args: { partner_id: 9547, notebook_id: 28, row: ROW },
    ticketRef: "TICKET/60184",
  });
  assert.match(out.summary, /IT Notebook 28/);
  assert.doesNotMatch(out.summary, /IT Notebook IT Notebook/, "no duplicated label");
  assert.match(out.summary, /9547/);
  assert.match(out.summary, /TICKET\/60184/);
  assert.match(out.summary, /Observability Grafana \(docker1\)/, "the tech must see WHICH row");
  assert.match(out.summary, /Admin User = admin/);
  assert.doesNotMatch(out.summary, /xEhvfSsj1TfjzP0MDpa1qCT2oUkZ/, "password must never be shown");
  assert.match(out.summary, /Admin Pass = \*{8} \(28 chars, hidden\)/);
});

test("the provenance note gets column names only", () => {
  const out = notebookWriteSummary({
    operation: "upsert_partner_notebook_row", args: { row: ROW },
  });
  assert.deepEqual(out.columns.sort(),
    ["Additional 1", "Admin", "Admin Pass", "Admin User", "Info", "LAN IP"]);
  assert.equal(JSON.stringify(out.columns).includes("xEhvfSsj1"), false);
});

test("a positional write masks every value - there are no column names to key on", () => {
  const out = notebookWriteSummary({
    operation: "upsert_partner_notebook_row",
    args: { values: ["Grafana", "", "https://x", "https", "admin", "SUPERSECRET"] },
  });
  assert.doesNotMatch(out.summary, /SUPERSECRET/, "must not guess which slot is the password");
  assert.doesNotMatch(out.summary, /Grafana/, "positional form masks all values");
  assert.match(out.summary, /\[1\] = \(blank\)/);
  assert.match(out.summary, /6 positional values/);
});

test("a delete is described as a delete", () => {
  const out = notebookWriteSummary({
    operation: "delete_notebook_row", args: { notebook_id: 28, row_id: "abc" },
  });
  assert.match(out.summary, /DELETE a row from/);
  assert.match(out.summary, /row: abc/);
});

test("match_info identifies the row when no row_id is given", () => {
  const out = notebookWriteSummary({
    operation: "upsert_partner_notebook_row",
    args: { match_info: "Existing Thing", row: { Info: "Existing Thing" } },
  });
  assert.equal(out.rowRef, "Existing Thing");
  assert.match(out.summary, /SAVE \(create or update\) a row in/);
});

test("all the spec'd operation names classify as secret_write", () => {
  for (const op of ["upsert_partner_notebook_row", "add_partner_notebook_row",
                    "upsert_notebook_row"]) {
    assert.equal(NAME_DEFAULTS[op], "secret_write", op);
    assert.equal(classOf(op, {}), "secret_write", op);
  }
});
