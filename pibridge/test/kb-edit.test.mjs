// KB CLEANUP (spec I of docs/KB-WRITE-GUARD.md): deleting text a technician says is no
// longer needed. Two halves, tested separately because they live in different places:
//
//   1. the GUARD (bridge): who may ask for it, how often, and the line the technician sees;
//   2. the OPERATION (helpdesk.js in the ERP): the HTML surgery, the backup, the verify.
//
// Part 2 loads the live integration file. It lives in the ai-helpdesk repo and is executed by
// the bridge as ADMIN-SUPPLIED CODE from Global Settings - there is no import path to it, so
// the test runs node:vm against the file when it can find it (PI_HELPDESK_JS overrides the
// path) and SKIPS, loudly, when it cannot.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createKbGuard, memoryBudget, runKbOp, isKbWrite } from "../src/kb-guard.js";
import { checkCleanupInstruction, editChatLine } from "../src/kb-write.js";
import { checkOp, gateOp } from "../src/capabilities.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPDESK_JS = process.env.PI_HELPDESK_JS || path.resolve(HERE, "../../../pi-ai-helpdesk/live-config/helpdesk.js");

// ---- the fake helpdesk ---------------------------------------------------------------

function fakeHd() {
  const calls = [];
  return {
    calls,
    operations: {
      edit_ai_kb_article: async (args) => {
        calls.push(args);
        if (args.entries && args.entries.includes("boom")) return { error: "that quote matches 3 places; quote more of it" };
        return args.dry_run
          ? { action: "planned", dry_run: true, id: 7, entries_removed: [{ quote: "x", blocks: 1 }], statements_removed: [], replacements: [], chars_before: 900, chars_after: 800 }
          : { action: "edited", id: 7, entries_removed: [{ quote: "x", blocks: 1 }], statements_removed: [{ quote: "y" }], replacements: [], chars_before: 900, chars_after: 800, backup_attachment_id: 1234 };
      },
    },
  };
}

const ASK = { at: "2026-11-16T12:00:00Z", text: "Clean up KB 106 - delete the dial plan entries I retired in the notice." };

function setup({ turns = [ASK], budget = memoryBudget() } = {}) {
  let t = Date.parse("2026-11-16T12:05:00Z");
  const clock = () => new Date(t);
  const hd = fakeHd();
  const guard = createKbGuard({
    hd, partnerId: 1, companyName: "BlueCloud IAAS, LLC", ticketRef: "TICKET/64000",
    surface: "decision_chat", techSaid: turns, getRecentResults: () => [], now: clock, budget,
  });
  return { hd, guard, budget, nextTurn: () => { t += 60000; }, clock };
}

// ---- 1. the guard --------------------------------------------------------------------

test("I. cleanup needs the technician's own words - the model's 'this looks stale' is not authority", async () => {
  assert.equal(checkCleanupInstruction({ techTurns: [] }).ok, false);
  assert.match(checkCleanupInstruction({ techTurns: [] }).reason, /technician's own instruction/);
  // A capture instruction is not a cleanup instruction.
  const save = { text: "Save that to the KB and remember the gateway is 10.0.0.1." };
  assert.equal(checkCleanupInstruction({ techTurns: [save] }).ok, false);
  // A negated one is not one either.
  assert.equal(checkCleanupInstruction({ techTurns: [{ text: "don't delete anything from the KB yet." }] }).ok, false);
  assert.equal(checkCleanupInstruction({ techTurns: [ASK] }).ok, true);
  assert.match(checkCleanupInstruction({ techTurns: [ASK] }).quote, /delete the dial plan entries/);

  const s = setup({ turns: [save] });
  const r = await s.guard.edit({ entries: ["STANDARD - TEAMS DIRECT ROUTING DIAL PLAN + VOICE ROUTE, EVERY CLIENT (PROPOSED"] });
  assert.equal(r.refused, true);
  assert.match(r.chatLine, /^KB edit: .*refused: a KB cleanup needs the technician's own instruction/);
  assert.equal(s.hd.calls.length, 0, "the operation is never called without an instruction");
});

test("I. with the instruction the operation is called, and the technician gets one 'KB edit:' line", async () => {
  const s = setup();
  const r = await s.guard.edit({ entries: ["STANDARD - TEAMS DIRECT ROUTING DIAL PLAN + VOICE ROUTE, EVERY CLIENT (PROPOSED"], remove: ["the tenant GLOBAL dial plan already allows it"] });
  assert.equal(r.action, "edited");
  assert.match(r.chatLine, /^KB edit: client · Pi\.dev AI - BlueCloud IAAS, LLC · removed\/replaced 1 entry \+ 1 statement \(900 → 800 chars\), backup attachment #1234/);
  assert.deepEqual(s.hd.calls[0].entries, ["STANDARD - TEAMS DIRECT ROUTING DIAL PLAN + VOICE ROUTE, EVERY CLIENT (PROPOSED"]);
  assert.equal(s.hd.calls[0].partner_id, 1);
  // Through runKbOp, the chat line is FIRST so it survives any truncation.
  const viaOp = await runKbOp(s.guard, "edit_ai_kb_article", { partner_id: 1, remove: ["an obsolete statement inside an entry"] });
  assert.match(viaOp.split("\n")[0], /^KB edit: /);
  assert.equal(isKbWrite("edit_ai_kb_article"), true);
});

test("I. a dry run writes nothing and spends no budget; a refusal changes nothing", async () => {
  const s = setup();
  const dry = await s.guard.edit({ entries: ["some retired entry that is no longer needed at all"], dry_run: true });
  assert.equal(dry.action, "planned");
  assert.match(dry.chatLine, /NOTHING WRITTEN \(dry run\)/);
  assert.equal(s.budget.stamps("edit:TICKET/64000").length, 0, "a dry run is not rate-limited or recorded");

  const bad = await s.guard.edit({ entries: ["boom"] });
  assert.equal(bad.refused, true);
  assert.match(bad.chatLine, /matches 3 places/);
  assert.equal(s.budget.stamps("edit:TICKET/64000").length, 0);
});

test("I. cleanups are rate-capped per article, on their own counter (the write budget is untouched)", async () => {
  const s = setup();
  for (let i = 0; i < 6; i++) {
    s.nextTurn();
    const r = await s.guard.edit({ entries: [`retired entry number ${i} that is no longer needed`] });
    assert.equal(r.action, "edited", `cleanup ${i} should be allowed: ${r.chatLine}`);
  }
  s.nextTurn();
  const over = await s.guard.edit({ entries: ["one more retired entry that is no longer needed here"] });
  assert.equal(over.refused, true);
  assert.match(over.chatLine, /rate cap: 6 KB cleanups per hour/);
  assert.equal(s.budget.stamps("TICKET/64000").length, 0, "a cleanup never spends the KB WRITE budget");
});

test("I. the capability is knowledge_delete: the ticket chat and device chat only, and never in warn mode", () => {
  const mutating = new Set(["edit_ai_kb_article"]);
  const opClasses = { edit_ai_kb_article: "knowledge_delete" };
  for (const surface of ["decision_chat", "device_chat"]) {
    assert.equal(checkOp({ surface, op: "edit_ai_kb_article", opClasses, mutating }).allowed, true, surface);
  }
  for (const surface of ["unattended", "auto_resolve", "mining", "triage", "advise", "autowork_fix", "discovery"]) {
    const v = gateOp({ surface, op: "edit_ai_kb_article", opClasses, mutating, grants: [] });
    assert.equal(v.allowed, false, surface);
    assert.equal(v.enforced, true, `${surface} must be a hard denial, not a warn-mode one`);
  }
  assert.match(editChatLine({ article: "Pi.dev AI - Acme", action: "removed 2 entries" }), /^KB edit: client · Pi\.dev AI - Acme · removed 2 entries$/);
});

// ---- 2. the operation (helpdesk.js in the ERP) ----------------------------------------

function loadHelpdesk(articles) {
  const state = { articles: new Map(articles), nextAtt: 900, attachments: new Map(), writes: 0, keepOldBody: false };
  const rpc = async (service, method, args) => {
    if (service === "common") return 7;
    const [db, uid, key, model, meth, margs] = args;
    const a = margs || [];
    if (model === "knowledge.global.article") {
      if (meth === "read") return (a[0] || []).map((id) => state.articles.get(Number(id))).filter(Boolean)
        .map((r) => ({ id: r.id, name: r.name, partner_id: [r.partner_id, "Co"], content: r.content }));
      if (meth === "search") return [...state.articles.values()].map((r) => r.id);
      if (meth === "write") {
        const rec = state.articles.get(Number(a[0][0]));
        if (!state.keepOldBody) Object.assign(rec, a[1] || {});
        state.writes += 1;
        return true;
      }
    }
    if (model === "res.partner" && meth === "read") return (a[0] || []).map((id) => ({ id, is_company: true, commercial_partner_id: false }));
    if (model === "ir.attachment" && meth === "create") {
      const rec = { id: state.nextAtt++, ...(a[0] || {}) };
      rec.html = Buffer.from(rec.datas || "", "base64").toString("utf8");
      state.attachments.set(rec.id, rec);
      return rec.id;
    }
    throw new Error(`unexpected rpc ${model}.${meth}`);
  };
  const fetchStub = async (url, opts) => {
    const body = JSON.parse(opts.body);
    try { return { json: async () => ({ result: await rpc(body.params.service, body.params.method, body.params.args) }) }; }
    catch (e) { return { json: async () => ({ error: { data: { message: e.message }, message: e.message } }) }; }
  };
  const exportsObj = {};
  const sandbox = {
    exports: exportsObj, module: { exports: exportsObj },
    helpdesk: { baseUrl: "https://erp.test", apiKey: "k", context: {} },
    fetch: fetchStub, console: { log() {}, error() {}, warn() {} },
    URL, URLSearchParams, TextEncoder, TextDecoder, Buffer, atob, btoa, setTimeout, clearTimeout, JSON,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(HELPDESK_JS, "utf8"), sandbox, { timeout: 5000, filename: "helpdesk.js" });
  const ex = sandbox.module.exports && Object.keys(sandbox.module.exports).length ? sandbox.module.exports : sandbox.exports;
  return { ops: ex.operations, state };
}

const ENTRIES = [
  "<p><b>[2026-11-01]</b> Old rule: dial plan copies the BlueCloud model with the 2-11 Digit Not Trash rule.</p>",
  "<p><b>[2026-11-02]</b> Proposed standard: three rules for extension, NANP and star codes.</p>",
  "<p><b>[2026-11-03]</b> Open conflict in the standard, technician to decide between the two wordings.</p>",
  "<p><b>[2026-11-04]</b> Final standard: ONE pass-through rule, nothing stripped and nothing added.</p>",
];
// Filler keeps the article comfortably above the 400-character floor that stops a cleanup
// emptying an article (a real article is 5-6 figures of characters; this is a test).
const FILLER = [
  "<p><b>[2026-10-01]</b> MOH: the hold_music value must carry the local_stream:// scheme or FreeSWITCH treats the name as a file, plays silence and logs an invalid-file error for every channel using the stream.</p>",
  "<p><b>[2026-10-02]</b> Park codes: TSH parks on the slot number (11-19) because the domain-variables dialplan binds the meta key for a valet_park lot; there is no *59 prefix in that client's flow.</p>",
];
const ARTICLE = "<h3>🤖 Pi.dev AI - Test</h3><p><i>Auto-maintained by Pi.dev AI as it works tickets. Techs may edit, delete, or promote into a proper article.</i></p>" + ENTRIES.join("") + FILLER.join("");
const artRow = (content) => ({ id: 501, name: "🤖 Pi.dev AI - Test", partner_id: 42, content });

const haveHelpdesk = fs.existsSync(HELPDESK_JS);
test("I. operation: the retired entries go, the rest of the article is untouched, a backup is kept", { skip: haveHelpdesk ? false : `helpdesk.js not found at ${HELPDESK_JS}` }, async () => {
  const { ops, state } = loadHelpdesk([[501, artRow(ARTICLE)]]);
  const dry = await ops.edit_ai_kb_article({ article_id: 501, entries: ["Old rule: dial plan copies the BlueCloud model"], dry_run: true });
  assert.equal(dry.action, "planned");
  assert.equal(state.writes, 0);
  assert.equal(state.attachments.size, 0, "a dry run takes no backup because it writes nothing");

  const r = await ops.edit_ai_kb_article({ article_id: 501, entries: ["Old rule: dial plan copies the BlueCloud model", "Open conflict in the standard, technician to decide"] });
  assert.equal(r.action, "edited");
  assert.equal(r.entries_removed.length, 2);
  const now = state.articles.get(501).content;
  assert.doesNotMatch(now, /2-11 Digit Not Trash/);
  assert.doesNotMatch(now, /Open conflict/);
  assert.match(now, /Proposed standard: three rules/);
  assert.match(now, /Final standard: ONE pass-through rule/);
  assert.match(now, /Auto-maintained by Pi\.dev AI/, "the banner is never a target");
  assert.equal(state.attachments.get(r.backup_attachment_id).html, ARTICLE, "the whole previous body is kept as an attachment");
});

test("I. operation: a statement can be removed, and a typo fixed in place instead of appending a correction", { skip: haveHelpdesk ? false : `helpdesk.js not found at ${HELPDESK_JS}` }, async () => {
  const { ops, state } = loadHelpdesk([[501, artRow(ARTICLE)]]);
  const r = await ops.edit_ai_kb_article({
    article_id: 501,
    remove: ["Open conflict in the standard, technician to decide between the two wordings."],
    replace: [{ find: "three rules for extension, NANP and star codes", with: "three rules: extension, NANP, star codes" }],
  });
  assert.equal(r.action, "edited");
  const now = state.articles.get(501).content;
  assert.doesNotMatch(now, /Open conflict/);
  assert.doesNotMatch(now, /\[2026-11-03\]/, "a block emptied by the edit is dropped whole");
  assert.match(now, /three rules: extension, NANP, star codes/);
  assert.equal(r.replacements.length, 1);
});

test("I. operation: no match, two matches and an unsafe short quote are all refusals - nothing is written", { skip: haveHelpdesk ? false : `helpdesk.js not found at ${HELPDESK_JS}` }, async () => {
  const { ops, state } = loadHelpdesk([[501, artRow(ARTICLE)]]);
  const missing = await ops.edit_ai_kb_article({ article_id: 501, entries: ["an entry that was never in this article at all"] });
  assert.match(missing.error, /not found/);
  const twice = await ops.edit_ai_kb_article({ article_id: 501, remove: ["round rule: dial plan copies the BlueCloud"] });
  assert.match(twice.error, /nothing was changed/);
  const short = await ops.edit_ai_kb_article({ article_id: 501, remove: ["the standard"] });
  assert.match(short.error, /too short/);
  const crossCompany = await ops.edit_ai_kb_article({ partner_id: 43, article_id: 501, entries: ["Old rule: dial plan copies the BlueCloud model"] });
  assert.match(crossCompany.error, /belongs to partner 42/);
  assert.equal(state.writes, 0);
  assert.equal(state.attachments.size, 0);
});

test("I. operation: half the article per call, and an article can never be emptied", { skip: haveHelpdesk ? false : `helpdesk.js not found at ${HELPDESK_JS}` }, async () => {
  const big = "<h3>t</h3>" + Array.from({ length: 40 }, (_, i) => `<p><b>[2026-10-${String(i + 1).padStart(2, "0")}]</b> entry number ${i} with a reasonably long body of text in it.</p>`).join("");
  const { ops, state } = loadHelpdesk([[502, { ...artRow(big), id: 502 }]]);
  const all = await ops.edit_ai_kb_article({ article_id: 502, entries: Array.from({ length: 39 }, (_, i) => `entry number ${i} with a reasonably long body`) });
  assert.match(all.error, /more than half the article|would leave the article/);
  assert.equal(state.writes, 0);
  const small = "<h3>t</h3><p><b>[2026-01-01]</b> one short entry that is the whole article.</p>";
  const { ops: ops2, state: st2 } = loadHelpdesk([[503, { ...artRow(small), id: 503 }]]);
  const emptied = await ops2.edit_ai_kb_article({ article_id: 503, entries: ["one short entry that is the whole article"] });
  assert.match(emptied.error, /would leave the article/);
  assert.equal(st2.writes, 0);
});

test("I. operation: a write that did not take is caught by the read-back and rolled back", { skip: haveHelpdesk ? false : `helpdesk.js not found at ${HELPDESK_JS}` }, async () => {
  const { ops, state } = loadHelpdesk([[501, artRow(ARTICLE)]]);
  state.keepOldBody = true;   // the write "succeeds" but the article never changes
  const r = await ops.edit_ai_kb_article({ article_id: 501, entries: ["Old rule: dial plan copies the BlueCloud model"] });
  assert.match(r.error, /did not verify/);
  assert.match(r.error, /ROLLED BACK/);
  assert.ok(r.backup_attachment_id, "the backup is named so a human can restore it by hand if the rollback failed");
  assert.equal(state.articles.get(501).content, ARTICLE);
});

test("I. operation: entities and line breaks in the quoted text still match ('->' vs '-&gt;')", { skip: haveHelpdesk ? false : `helpdesk.js not found at ${HELPDESK_JS}` }, async () => {
  const pad = Array.from({ length: 12 }, (_, i) => `<p><b>[2026-09-${String(i + 1).padStart(2, "0")}]</b> filler entry ${i} keeping the article above the floor.</p>`).join("");
  const e = '<p><b>[2026-11-05]</b> The rule is ^1?(\\d{2,10})$ -&gt; $1 and it turns 100 into 00<br/>which is wrong.</p>';
  const { ops, state } = loadHelpdesk([[504, { ...artRow("<h3>t</h3>" + pad + e), id: 504 }]]);
  const r = await ops.edit_ai_kb_article({ article_id: 504, replace: [{ find: "turns 100 into 00 which is wrong", with: "keeps 100 exactly as dialed" }] });
  assert.equal(r.action, "edited", JSON.stringify(r).slice(0, 300));
  assert.match(state.articles.get(504).content, /keeps 100 exactly as dialed/);
});
