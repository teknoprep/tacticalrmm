// capabilities.js - WHO may do WHAT to a ticket. Single source of truth.
//
// Why this exists (ISSUES.md F1): every surface that built a toolset used to attach
// the FULL helpdesk operation list, and unattended runs passed gate: () => true. So a
// scheduled job could reply to a customer, close, cancel, resolve or re-attribute ANY
// ticket, restrained only by prompt prose. MANDATE 4.8 requires the consequential
// decision to live in code ("the model never decides that a ticket may be closed").
//
// The portable unit is a CAPABILITY CLASS, not an operation name. Operation names are
// authored per deployment in helpdesk.js, so an allow-list of names in product code
// would break MANDATE 4.11 (helpdesk-agnostic product code) - it would silently
// protect nothing on a deployment that named its operations differently. Classes are
// declared by the deployment and consumed by product code.
//
// DEFAULT DENY: an operation the deployment declares as mutating, but does not
// classify, is DENIED. A new operation can never silently inherit authority.

// The classes. Anything outside this set is treated as unclassified (denied).
//
// `secret` is the customer's stored credentials (the IT Notebook tab on a company). It is
// deliberately NOT a kind of "read": a read is cheap and reversible, whereas handing over a
// live username and password is neither, and it must never happen because an unattended job
// decided it needed one. It is granted to exactly one surface - the ai-decision window,
// where a named technician is present - and even there the gate asks them every single time.
//
// `secret_write` is RECORDING a credential, and it is a separate class from `secret`
// because it is a different risk, not a bigger one. Reading exposes a password to the
// model; writing changes what every future technician will be handed as the truth. An
// overwritten row locks people out of a customer system, and a wrong one sends the next
// person to the wrong door with confident-looking documentation. The two are therefore
// granted, gated and audited separately - a surface may hold either without the other,
// and today the interactive decision window holds both.
//
// Authority rule (owner, 2026-08-18): "only when requested to do so - they can ask if they
// should do it and we will let them know, or if I tell it then it can." So a write needs
// EITHER a verbatim instruction from the technician OR an approval click, and no toggle
// skips it. See the `secret_write` branch of gate() in server.js.
export const CLASSES = ["read", "create", "note", "knowledge", "global_knowledge", "customer", "close", "routing", "secret", "secret_write", "sales"];

// Ships-working-out-of-the-box classifier for conventional operation names. This is a
// DEFAULT CLASSIFIER ONLY, never the authority: explicit exports.opClasses always wins.
// An unrecognised name is not an error - it falls through to the mutating check below.
export const NAME_DEFAULTS = {
  // read
  get_ticket: "read", get_ticket_stages: "read", list_open_tickets: "read",
  list_closed_tickets: "read", find_company: "read", resolve_customer: "read",
  resolve_client_by_domain: "read", check_support_authorization: "read",
  get_kb_article: "read", list_kb_articles: "read", get_global_kb: "read",
  // create
  create_ticket: "create", submit_report: "create",
  // note
  add_note: "note",
  // knowledge  (MANDATE 4.13: company-scoped knowledge capture is memory, not a change)
  upsert_ai_kb_article: "knowledge",
  // global_knowledge (shared/global KB authoring is only exposed interactively and
  // also requires a direct technician instruction; see tools.js)
  create_global_kb_article: "global_knowledge",
  // customer  (irreversible outbound contact)
  reply_to_ticket: "customer",
  // secret  (customer credentials - decision window only, always prompts)
  get_partner_credentials: "secret", get_credentials: "secret", read_secure_notes: "secret",
  // secret_write  (RECORDING a credential / IT Notebook row - decision window only, and
  // only on a technician's instruction or an approval click). Named defaults are a
  // convenience for conventional names; a deployment that calls it something else must
  // tag it in exports.opClasses, and an untagged mutating op stays denied.
  upsert_partner_notebook_row: "secret_write", add_partner_notebook_row: "secret_write",
  upsert_notebook_row: "secret_write", update_notebook_row: "secret_write",
  create_notebook_row: "secret_write", delete_notebook_row: "secret_write",
  set_partner_credentials: "secret_write", upsert_credential: "secret_write",
  write_secure_note: "secret_write",
  // close
  cancel_ticket: "close", close_ticket: "close", ai_close_ticket: "close",
  resolve_ticket: "close",
  // routing
  assign_ticket: "routing", assign_to_working_user: "routing", claim_ticket: "routing",
  release_ticket: "routing", add_follower: "routing", set_ticket_company: "routing",
  set_needs_input_tag: "routing", clear_needs_input_tag: "routing",
  // sales (decision chat only)
  create_quotation: "sales", link_ticket_quotation: "sales",
  get_quotation: "read", list_products: "read",
};

// Surface -> allowed classes. The surface is WHERE the model is running, which
// determines how much human oversight exists at the moment it acts.
//
// NOTE: runAlertVerify is deliberately absent. It calls hd.operations.cancel_ticket
// DIRECTLY from code on proven device evidence, with no LLM tool surface at all - it
// is already the deterministic, code-owned decision MANDATE 4.8 asks for. Gating it
// here would gate code against itself.
export const SURFACE_CLASSES = {
  // Unattended: AI Tasks, bulk per-device runs, scheduled actions. No human present,
  // so no irreversible customer contact and no closing authority.
  unattended:    ["create", "note", "knowledge", "read"],
  // End-of-batch report finalizer. Files ONE combined ticket.
  report:        ["create", "read"],
  // Interactive device chat: a human is watching and approves each mutating call.
  //
  // `secret` was added 2026-08-25. It had been withheld because this surface's gate took a
  // bare summary rather than a capability kind, so a grant would have landed credential
  // reads in the device-approval path - where Auto-approve skips prompts. That is now
  // fixed: startChat builds the same makeCredentialGate() the ticket chat uses and passes
  // it as `secretGate`, and buildTools refuses a `secret` operation outright when that
  // channel is absent. The reason to grant it is that a technician fixing a machine needs
  // the customer's login for the same reasons a technician working a ticket does.
  //
  // `secret_write` stays out. Recording a credential is a decision about what the customer's
  // record should say, and it belongs with the ticket that justifies it.
  device_chat:   ["create", "note", "knowledge", "global_knowledge", "read", "customer", "routing", "secret"],
  // Decision chat: a human is driving the ticket and approves each mutating call. Reaches
  // the credential store under makeCredentialGate(), which Auto-approve cannot skip.
  // `secret_write` is here and nowhere else: recording a credential is a decision about the
  // customer's record, and the ticket is what justifies and dates it.
  decision_chat: ["create", "note", "knowledge", "global_knowledge", "read", "customer", "routing", "close", "secret", "secret_write", "sales"],
  // Ticket Console auto-resolve: read-only investigation, posts a note. Never closes,
  // never emails. Replaces the old blockOps name list (ISSUES.md I6).
  auto_resolve:  ["read", "note", "knowledge"],
  // Classification only - holds no mutating tools at all.
  triage:        ["read"],
  // Learning: reads closed tickets, writes only to our own stores.
  mining:        ["read", "knowledge"],
};

// "warn"    - log what WOULD be denied, allow it through (observation window)
// "enforce" - actually refuse
// Default is warn so a deploy cannot silently break a running automation; flip to
// enforce once a day of real dispatches has been reviewed (MANDATE 4.10 in spirit).
export const CAPS_MODE = (process.env.PI_CAPS_MODE || "warn").toLowerCase() === "enforce"
  ? "enforce"
  : "warn";

function stamp(...a) {
  console.log(new Date().toISOString(), ...a);
}

// Resolve an operation to a class.
//   1. explicit deployment tag (exports.opClasses)  <- the authority
//   2. product-code name default                    <- convenience
//   3. null                                         <- unclassified
export function classOf(op, opClasses) {
  const tagged = opClasses && opClasses[op];
  if (tagged && CLASSES.includes(tagged)) return tagged;
  const named = NAME_DEFAULTS[op];
  if (named) return named;
  return null;
}

// Where a class came from - surfaced in validation UI so an admin can see what product
// code guessed versus what the deployment declared.
export function classSource(op, opClasses) {
  const tagged = opClasses && opClasses[op];
  if (tagged && CLASSES.includes(tagged)) return "declared";
  if (tagged) return "invalid";
  if (NAME_DEFAULTS[op]) return "name-guess";
  return "unclassified";
}

// Classes that an explicit per-run authorisation may ADD to a surface. Deliberately a
// whitelist of one: a task-level field can authorise contacting the customer, and can
// never grant closing or routing authority no matter what it asks for. MANDATE 4.8 keeps
// closing with a human; this hole is only as wide as it has to be.
export const GRANTABLE = ["customer"];

// THE decision. Returns { allowed, cls, reason }.
//
// An unknown surface denies every mutating class - fail safe, and it means a new
// endpoint cannot invent its own permission model by forgetting to declare itself.
//
// `grants` are classes explicitly authorised for THIS run by the person who configured it
// (e.g. an AI task whose author declared a reply register). They are intersected with
// GRANTABLE, so an unexpected value cannot widen authority.
export function checkOp({ surface, op, opClasses, mutating, grants }) {
  const granted = (grants || []).filter((g) => GRANTABLE.includes(g));
  const allowedClasses = SURFACE_CLASSES[surface]
    ? [...SURFACE_CLASSES[surface], ...granted]
    : undefined;
  const isMutating = mutating ? mutating.has(op) : true; // unknown -> assume mutating
  let cls = classOf(op, opClasses);

  // An operation the deployment does NOT declare as mutating changes nothing by its
  // own declaration, so an unclassified one is treated as a read rather than denied.
  // This keeps lookups working out of the box without weakening the authority check:
  // default-deny applies to anything declared mutating. Note helpdesk-runtime.js
  // defaults `mutating` to ALL operation names when exports.mutating is absent, so a
  // deployment that declares nothing gets the strict path, not the lenient one.
  if (!cls && !isMutating) cls = "read";

  if (!allowedClasses) {
    return { allowed: false, cls, reason: `surface '${surface}' is not a known capability surface` };
  }
  if (!cls) {
    return {
      allowed: false, cls: null,
      reason: `'${op}' is not classified. Tag it in helpdesk.js (exports.opClasses) with one of: ${CLASSES.join(", ")}`,
    };
  }
  if (!allowedClasses.includes(cls)) {
    return {
      allowed: false, cls,
      reason: `'${op}' is a '${cls}' operation, which is not permitted on the '${surface}' surface (allowed: ${allowedClasses.join(", ")})`,
    };
  }
  return { allowed: true, cls, reason: "" };
}

// Enforcement wrapper. Logs every denial either way so the warn-mode window produces
// the evidence needed before switching to enforce.
// Classes that are NEVER warn-only, whatever PI_CAPS_MODE says.
//
// `warn` exists so that tightening a capability cannot silently break a running
// automation: the refusal is logged and the call still goes through, and an operator flips
// to `enforce` once a day of real traffic has been reviewed. That is a sound default for
// classes whose worst case is an unwanted ticket note.
//
// It is not sound for the credential store. On a surface that is not supposed to reach it,
// `warn` would return the customer's live passwords to the model and write a log line
// about it - and because a credential READ is not a mutating operation, no approval gate
// stands behind the class check to catch it. There is no observation window worth that, so
// these two classes are enforced from the moment they are checked.
const ALWAYS_ENFORCED = new Set(["secret", "secret_write"]);

export function gateOp(ctx) {
  const v = checkOp(ctx);
  if (v.allowed) return v;
  const enforced = CAPS_MODE === "enforce" || ALWAYS_ENFORCED.has(v.cls);
  stamp(
    `caps_${enforced ? "deny" : "warn"}>`,
    `surface=${ctx.surface}`, `op=${ctx.op}`, `class=${v.cls || "unclassified"}`,
    `ref=${ctx.ref || "-"}`, `| ${v.reason}`,
  );
  return { ...v, enforced };
}

// Operations this surface may actually call - used to filter the list advertised to
// the model, so it is not shown authority it does not have. Enforcement still happens
// at execute time: filtering the description is not a control, since the model can
// name an operation it was never shown.
export function allowedOps({ surface, names, opClasses, mutating, grants }) {
  return (names || []).filter((op) => checkOp({ surface, op, opClasses, mutating, grants }).allowed);
}
