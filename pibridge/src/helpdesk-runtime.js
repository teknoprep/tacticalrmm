// Loads and runs the admin-authored "helpdesk.js" integration code that lives
// in Global Settings (CoreSettings.ai_helpdesk_code). This is what makes the
// ticketing layer BOTH deterministic (real code) AND system-agnostic (the code
// is written per-deployment for Odoo / Zendesk / Freshdesk / anything).
//
// Trust model: this runs admin-supplied JS on the bridge host. Only users with
// can_edit_core_settings can set it - the same trust level as TRMM's script
// library (which already runs arbitrary code on every managed device). node:vm
// is used to scope the globals it sees, NOT as a hard security sandbox.
//
// CONTRACT (what the admin code writes):
//   // In scope: helpdesk = { baseUrl, apiKey }, fetch, console, URL,
//   //           URLSearchParams, TextEncoder, TextDecoder, Buffer, atob, btoa,
//   //           setTimeout, clearTimeout.
//   // Define async operations the AI can call, and (optionally) describe them.
//   exports.operations = {
//     async resolve_customer({ name }) { ... return { id, name } },
//     async create_ticket({ customer, subject, body }) { ... return { ref } },
//     async reply_to_ticket({ ticket, message }) { ... },
//     async add_note({ ticket, message }) { ... },
//     async submit_report({ subject, body, partner_id, team_id }) { ... },
//   };
//   exports.meta = { create_ticket: "Create a new ticket", ... };   // optional
//   exports.mutating = ["create_ticket","reply_to_ticket","add_note","submit_report"]; // optional
//   // Capability class per operation - what AUTHORITY it carries. Product code maps
//   // surfaces to allowed classes (see capabilities.js); anything declared mutating
//   // but left unclassified is DENIED on unattended surfaces (default deny).
//   // One of: read | create | note | knowledge | customer | close | routing
//   exports.opClasses = { create_ticket: "create", reply_to_ticket: "customer",
//                         cancel_ticket: "close", add_note: "note", ... };  // optional but recommended
import vm from "node:vm";

// PASSWORDS NEVER REACH A MODEL (owner, 2026-09-26). get_partner_credentials used to hand
// the IT Notebook's passwords, keys and secret columns straight to the model, and from there
// into transcripts and logs (TICKET/61824, TICKET/61857). Every surface that exposes helpdesk
// operations to a model goes through this loader, so the masking is done HERE, once: the
// model gets labels, links and usernames, and "[stored]" for everything else. Brokered tools
// (run_device_command_with_credential, the authorizer's label lookup) read the real values
// through hd.readNotebookValues, which is not an operation and cannot be called by a model.
const SHOW_COLUMN = /^(info|label|name|system|description|service|link|url|portal|address|host|site|user|username|user ?name|login|email|e-?mail|admin user|account)$/i;
function maskNotebooks(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.notebooks)) return result;
  const notebooks = result.notebooks.map((nb) => {
    if (!nb || !Array.isArray(nb.columns) || !Array.isArray(nb.rows)) return nb;
    const show = nb.columns.map((c) => SHOW_COLUMN.test(String(c || "").trim()));
    // A secret typed into a visible column (a password pasted into Link, seen on BlueCloud's
    // notebook) is blanked there too: every value of a masked column, 6+ real characters,
    // is scrubbed from every visible cell of the notebook.
    const secrets = new Set();
    for (const row of nb.rows) {
      if (!Array.isArray(row)) continue;
      row.forEach((cell, i) => { const v = String(cell ?? "").trim(); if (!show[i] && v.length >= 6) secrets.add(v); });
    }
    const bySize = [...secrets].sort((x, y) => y.length - x.length);
    const scrub = (cell) => {
      let v = String(cell ?? "");
      for (const sec of bySize) if (v.includes(sec)) v = v.split(sec).join("[stored]");
      return v;
    };
    const rows = nb.rows.map((row) => (Array.isArray(row)
      ? row.map((cell, i) => (show[i] ? scrub(cell) : (String(cell ?? "").trim() ? "[stored]" : "")))
      : row));
    return { ...nb, rows, masked_columns: nb.columns.filter((_, i) => !show[i]) };
  });
  return {
    partner_id: result.partner_id, notebooks, read_only: true, values_masked: true,
    ...(result.note ? { note: result.note } : {}),
    ...(result.error ? { error: result.error } : {}),
    handling:
      "Passwords, keys and other secret columns are shown as [stored] - by design, you never see them. " +
      "To USE a login, pass it BY REFERENCE (company + the row's Info label, exactly as shown): " +
      "run_device_command_with_credential (any RMM agent; the command reads $PI_USER/$PI_PASS/$PI_URL), " +
      "operator_desktop_fill_secret (a sign-in page on the Operator desktop), run_script_with_credential " +
      "(PowerShell on the Operator workstation). If the technician asks you for a password, tell them it is " +
      "in the IT Notebook row <label> in Odoo - you cannot read it out.",
  };
}

export function loadHelpdesk(code, config, context) {
  if (!code || !code.trim()) return null;
  const exportsObj = {};
  const sandbox = {
    exports: exportsObj,
    module: { exports: exportsObj },
    // helpdesk.context is present for SINGLE-device sessions: { deviceUrl,
    // hostname, client, site, agentId } - so the integration can put a deep
    // link to the device in the ticket. Empty object for multi-device/report.
    helpdesk: {
      baseUrl: (config?.base_url || "").replace(/\/+$/, ""),
      apiKey: config?.api_key || "",
      context: context || {},
    },
    fetch,
    console: { log: () => {}, error: () => {}, warn: () => {} },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Buffer,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
    JSON,
  };
  vm.createContext(sandbox);
  // Only top-level (synchronous) setup is time-boxed; async ops run later.
  vm.runInContext(code, sandbox, { timeout: 5000, filename: "helpdesk.js" });

  const ex = sandbox.module.exports && Object.keys(sandbox.module.exports).length
    ? sandbox.module.exports
    : sandbox.exports;
  const operations = ex.operations || {};
  const names = Object.keys(operations).filter((k) => typeof operations[k] === "function");
  if (!names.length) throw new Error("helpdesk.js defined no exports.operations functions");
  // The model-facing operations get the masked notebook read; the raw one stays server-side.
  const rawCredentials = typeof operations.get_partner_credentials === "function"
    ? operations.get_partner_credentials.bind(operations) : null;
  const exposed = { ...operations };
  if (rawCredentials) {
    exposed.get_partner_credentials = async (args = {}) =>
      // Labels of privileged rows are included too: the row is still only usable through a
      // brokered tool, which has its own gate.
      maskNotebooks(await rawCredentials({ ...(args || {}), include_privileged: true }));
  }
  return {
    operations: exposed,
    readNotebookValues: rawCredentials,
    names,
    meta: ex.meta || {},
    mutating: new Set(ex.mutating || names), // default: treat all as mutating (safe)
    // Capability tags. Absent -> product code falls back to its name-based default
    // classifier, and anything it cannot classify is denied where authority matters.
    opClasses: ex.opClasses || {},
    apiKey: sandbox.helpdesk.apiKey,
  };
}
