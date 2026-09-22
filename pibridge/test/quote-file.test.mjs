// A quotation raised from a discovery session must be filed in the opportunity's
// INTERNAL NOTES, never the chatter, and re-issuing must replace the previous copy
// (owner's ruling 2026-09-16). Stub integrations: no Odoo, no network.
import { strict as assert } from "node:assert";
import test from "node:test";
import { buildDecisionTools } from "../src/tools.js";

const HD_CODE = `
exports.operations = {
  async update_opportunity_notes({ lead, section, html }) {
    helpdesk.context.notes.push({ lead, section, html });
    return { ok: true, ref: lead, section };
  },
  async add_opportunity_note({ lead, message }) {
    helpdesk.context.chatter.push({ lead, message });
    return { ok: true };
  },
  async get_opportunity({ lead }) { return { ref: lead, name: "test opp", stage: "Send Quote" }; },
};
exports.meta = { update_opportunity_notes: "notes", add_opportunity_note: "chatter", get_opportunity: "read" };
exports.mutating = ["update_opportunity_notes", "add_opportunity_note"];
exports.opClasses = { update_opportunity_notes: "note", add_opportunity_note: "note", get_opportunity: "read" };
`;

const SALES_CODE = `
exports.operations = {
  async create_quotation(args) {
    return { ok: true, id: 501, name: "S00099", state: "draft", amount_total: 12345.67,
             amount_untaxed: 12000, validity_date: "2026-10-16", partner: [7, "Omega Design"],
             salesperson: [6, "Chris Rawlings"], url: "https://erp.example/so/501" };
  },
  async get_quotation() { return { ok: true, name: "S00099" }; },
};
exports.meta = { create_quotation: "create", get_quotation: "read" };
exports.mutating = ["create_quotation"];
exports.opClasses = { create_quotation: "sales", get_quotation: "read" };
`;

function build() {
  // The integration is evaluated in a vm context with its own globals, so the stub cannot
  // write to this module's scope directly. helpdesk.context is passed in BY REFERENCE,
  // which makes it the honest capture channel - and exercises the real runtime, sandbox
  // and all, rather than a hand-made fake of it.
  const captured = { notes: [], chatter: [] };
  const built = buildDecisionTools({
    helpdeskCode: HD_CODE,
    helpdeskApi: { base_url: "https://erp.example", api_key: "x" },
    helpdeskContext: captured,
    ticketRef: "", leadRef: "LEAD/837", surface: "discovery",
    gate: async () => ({ ok: true }),
    actorName: "Chris Rawlings", creditActor: "chris",
    salesEnabled: true, salesCode: SALES_CODE, salesApi: { base_url: "https://erp.example", api_key: "x" },
  });
  return { ...built, captured };
}

test("a created quotation is filed in Internal Notes, not the chatter", async () => {
  const { tools, captured } = build();
  const sales = tools.find((t) => t.name === "sales_call");
  assert.ok(sales, "sales_call tool should be built when sales is enabled");
  await sales.execute("1", { operation: "create_quotation", args: { note_html: "<p>Dear customer</p>" } });
  assert.equal(captured.chatter.length, 0, "a quote must NEVER be posted to the chatter");
  assert.equal(captured.notes.length, 1, "the quote should be filed once");
  const n = captured.notes[0];
  assert.equal(n.lead, "LEAD/837");
  assert.equal(n.section, "quote", "always the 'quote' section, so re-issuing replaces it");
  assert.match(n.html, /S00099/);
  assert.match(n.html, /QUOTATION ON FILE/);
  assert.match(n.html, /Dear customer/, "the customer-facing body is kept verbatim");
  assert.match(n.html, /Omega Design/);
  assert.match(n.html, /12345\.67/, "Odoo's own totals are recorded");
});

test("re-issuing writes the same section again, so the old copy is superseded", async () => {
  const { tools, captured } = build();
  const sales = tools.find((t) => t.name === "sales_call");
  await sales.execute("1", { operation: "create_quotation", args: { note_html: "<p>v1</p>" } });
  await sales.execute("2", { operation: "create_quotation", args: { note_html: "<p>v2 corrected</p>" } });
  assert.equal(captured.notes.length, 2);
  assert.ok(captured.notes.every((n) => n.section === "quote"),
    "both writes target one section - update_opportunity_notes replaces in place");
  assert.match(captured.notes[1].html, /v2 corrected/);
});

test("a read-only sales op files nothing", async () => {
  const { tools, captured } = build();
  const sales = tools.find((t) => t.name === "sales_call");
  await sales.execute("1", { operation: "get_quotation", args: {} });
  assert.equal(captured.notes.length, 0, "reading a quote is not issuing one");
});
