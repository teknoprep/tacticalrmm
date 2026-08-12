// Unit tests for the cost meter and silent-stop detection.
// Uses the REAL usage block from the message that stalled on 2026-08-04:
//   usage: { input:3, output:16, cacheRead:8205, reasoning:16, totalTokens:608918,
//            cost:{ total: 7.51763 } }, stopReason: "length"
//
// Run: node test/cost-meter.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  makeCostMeter,
  silentStopMessage,
  cacheRewriteCost,
  TURN_COST_WARN,
  SESSION_COST_WARN,
} from "../src/cost-meter.js";

// Published per-million rates, as pi's model registry reports them (2026-08-04).
const RATES = {
  "xai/grok-4.5":            { input: 2, output: 6,  cacheRead: 0.3, cacheWrite: 0 },
  "anthropic/claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "anthropic/claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};
const ratesFor = (provider, modelId) => RATES[`${provider}/${modelId}`] || null;

let pass = 0;
const ok = (name) => { console.log(`  ok  ${name}`); pass++; };

function harness({ visible = true, contextWindow = 0, rates = ratesFor } = {}) {
  // `rates` now only forecasts switches; accounting comes from usage.cost.
  const sent = [];
  const logged = [];
  const meter = makeCostMeter({
    send: (f) => sent.push(f),
    log: (...a) => logged.push(a.join(" ")),
    visible,
    key: "AVgiDUiblQBSeEQKSlJnGDaGRVASDWRgdIKpLUhW",
    sessionId: "019fcc9e-afe4-7a51-940a-5e01566c583b",
    contextWindow,
    rateLookup: rates,
  });
  return { meter, sent, logged };
}

// The actual billed message from the incident.
const INCIDENT_MSG = {
  stopReason: "length",
  usage: {
    input: 3, output: 16, cacheRead: 8205, reasoning: 16,
    totalTokens: 608918, cost: { total: 7.51763 },
  },
};

console.log("\ncost meter");

// --- accumulation -------------------------------------------------------------
{
  const { meter, sent } = harness();
  const snap = meter.record(INCIDENT_MSG);
  assert.equal(snap.type, "cost_update");
  assert.equal(snap.session_cost, 7.51763);
  assert.equal(snap.turn_cost, 7.51763);
  assert.equal(snap.turns, 1);
  assert.equal(snap.context_tokens, 608918);
  assert.equal(snap.tokens.cacheRead, 8205);
  assert.ok(sent.some((f) => f.type === "cost_update"), "must push a cost_update");
  ok("records the incident message and reports $7.52 / 608,918 tokens");
}
{
  const { meter } = harness();
  meter.record({ usage: { cost: { total: 0.02 }, input: 100, output: 50, totalTokens: 1000 } });
  meter.record({ usage: { cost: { total: 0.03 }, input: 200, output: 60, totalTokens: 2000 } });
  const s = meter.snapshot();
  assert.equal(Number(s.session_cost.toFixed(4)), 0.05);
  assert.equal(s.turn_cost, 0.03);
  assert.equal(s.turns, 2);
  assert.equal(s.tokens.input, 300);
  assert.equal(s.tokens.output, 110);
  assert.equal(s.context_tokens, 2000, "context follows the latest turn");
  ok("accumulates cost and tokens across turns");
}

// --- warnings -----------------------------------------------------------------
{
  const { meter, sent, logged } = harness();
  meter.record(INCIDENT_MSG);
  const warns = sent.filter((f) => f.type === "cost_warning");
  assert.ok(warns.length >= 2, `expected turn + session warnings, got ${warns.length}`);
  assert.ok(warns.some((w) => w.message.includes("$7.52")), "turn warning must name the amount");
  assert.ok(logged.some((l) => l.includes("cost_warn")), "must log server-side");
  ok(`warns on a $7.52 turn (turn threshold $${TURN_COST_WARN}, session $${SESSION_COST_WARN})`);
}
{
  // Cheap turns must stay silent - no nagging on normal work.
  const { meter, sent } = harness();
  for (let i = 0; i < 10; i++) meter.record({ usage: { cost: { total: 0.01 }, totalTokens: 5000 } });
  assert.equal(sent.filter((f) => f.type === "cost_warning").length, 0);
  assert.equal(sent.filter((f) => f.type === "cost_update").length, 10);
  ok("no warnings for ten cheap turns ($0.10 total)");
}
{
  // Session threshold must fire once per band crossed, not once per turn after it.
  const { meter, sent } = harness();
  for (let i = 0; i < 12; i++) meter.record({ usage: { cost: { total: 0.5 }, totalTokens: 1000 } });
  const sessionWarns = sent.filter(
    (f) => f.type === "cost_warning" && f.message.includes("conversation has now cost"),
  );
  assert.equal(sessionWarns.length, 1, `$6.00 total should cross $5 once, got ${sessionWarns.length}`);
  ok("session warning fires once per $5 band, not every turn");
}
{
  // Context pressure warning - the early signal for stopReason="length".
  const { meter, sent } = harness({ contextWindow: 200000 });
  meter.record({ usage: { cost: { total: 0.05 }, totalTokens: 90000 } });
  assert.equal(sent.filter((f) => f.type === "cost_warning").length, 0, "45% is fine");
  meter.record({ usage: { cost: { total: 0.05 }, totalTokens: 170000 } });
  const ctx = sent.filter((f) => f.type === "cost_warning" && f.message.includes("Context is"));
  assert.equal(ctx.length, 1);
  assert.ok(ctx[0].message.includes("85%"), `expected 85%, got: ${ctx[0].message}`);
  ok("warns at 85% of a 200k context window, silent at 45%");
}

// --- permission gating --------------------------------------------------------
{
  const { meter, sent, logged } = harness({ visible: false });
  meter.record(INCIDENT_MSG);
  assert.equal(sent.length, 0, "an operator without can_view_ai_cost must receive nothing");
  assert.ok(logged.some((l) => l.includes("cost_warn")), "but the server still logs it");
  assert.equal(meter.sessionCost, 7.51763, "and totals are still tracked internally");
  ok("sends nothing when the role may not see cost, yet still logs and tracks");
}

// --- robustness ---------------------------------------------------------------
{
  const { meter } = harness();
  meter.record(undefined);
  meter.record({});
  meter.record({ usage: {} });
  meter.record({ usage: { cost: {} } });
  meter.record({ usage: { cost: { total: "not-a-number" }, input: null, totalTokens: undefined } });
  const s = meter.snapshot();
  assert.equal(s.session_cost, 0);
  // Only the three calls carrying a `usage` object count as turns; `undefined` and `{}`
  // are unbilled messages and are ignored (see the unbilled-message regression below).
  assert.equal(s.turns, 3);
  assert.ok(Number.isFinite(s.tokens.input) && s.tokens.input === 0);
  ok("survives missing/garbage usage without NaN, ignoring unbilled messages");
}

console.log("\nsilent stop detection");

// --- silentStopMessage --------------------------------------------------------
{
  const msg = silentStopMessage(INCIDENT_MSG);
  assert.ok(msg, 'stopReason "length" MUST produce a message - this was the silent bug');
  assert.ok(/CONTEXT LIMIT/.test(msg), "must name the cause");
  assert.ok(/narrower/i.test(msg), "must tell the operator what to do next");
  ok('stopReason "length" is reported with a cause and a next step');
}
{
  assert.equal(silentStopMessage({ stopReason: "stop" }), null);
  assert.equal(silentStopMessage({ stopReason: "toolUse" }), null);
  ok("normal stop / toolUse stay silent");
}
{
  // handled by the caller, which has the provider reason
  assert.equal(silentStopMessage({ stopReason: "error" }), null);
  ok("error is left to the existing provider-error path");
}
{
  assert.equal(silentStopMessage({ stopReason: "aborted" }), null);
  assert.equal(silentStopMessage({ stopReason: "cancelled" }), null);
  ok("operator-initiated stop is not reported as a failure");
}
{
  const m = silentStopMessage({ stopReason: "content_filter" });
  assert.ok(m && m.includes("content_filter"), "unknown stops must not be swallowed");
  assert.equal(silentStopMessage({}), null);
  assert.equal(silentStopMessage(undefined), null);
  ok("unknown stop reasons are surfaced; empty message is safe");
}

// --- per-class / per-model attribution against the REAL $4.78 session -----------
console.log("\nspend attribution (real 4-model session 019fccfd)");

const SESSION_4MODEL =
  "/home/tactical/.pi/agent/sessions/--opt-pi-trmm-bridge-sessions--/" +
  "2026-08-04T13-36-10-228Z_019fccfd-25f4-7418-9563-ce51b78035c3.jsonl";

if (fs.existsSync(SESSION_4MODEL)) {
  const { meter } = harness();
  let reported = 0;
  for (const line of fs.readFileSync(SESSION_4MODEL, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const m = row.message;
    if (m?.role !== "assistant" || !m.usage?.cost) continue;
    reported += m.usage.cost.total;
    meter.record(m);
  }
  const s = meter.snapshot();

  // The meter's total must equal what the provider billed, to the cent.
  assert.ok(
    Math.abs(s.session_cost - reported) < 0.01,
    `meter total ${s.session_cost} != provider total ${reported}`,
  );
  ok(`total matches provider billing: $${s.session_cost.toFixed(4)}`);

  // The per-class split must reconstruct the total from published rates.
  const classSum = s.spend.input + s.spend.output + s.spend.cacheRead + s.spend.cacheWrite;
  assert.ok(s.pricing_known, "pricing should be known for all three models");
  assert.ok(
    Math.abs(classSum - s.session_cost) < 0.01,
    `class split ${classSum.toFixed(4)} != total ${s.session_cost.toFixed(4)}`,
  );
  ok(`per-class split reconstructs the total (delta $${Math.abs(classSum - s.session_cost).toFixed(5)})`);

  // The headline finding: cache traffic dwarfs the actual output.
  const cache = s.spend.cacheRead + s.spend.cacheWrite;
  assert.ok(cache > s.spend.output * 3, "expected cache traffic to dominate output");
  ok(`cache traffic $${cache.toFixed(2)} vs output $${s.spend.output.toFixed(2)}`);

  // Per-model attribution must expose the expensive model.
  assert.ok(s.by_model.length >= 3, `expected >=3 models, got ${s.by_model.length}`);
  const opus = s.by_model.find((x) => x.model.includes("opus"));
  const grok = s.by_model.find((x) => x.model.includes("grok"));
  assert.ok(opus && grok, "expected both opus and grok in the breakdown");
  assert.ok(
    opus.cost_per_turn > grok.cost_per_turn * 5,
    `opus $${opus.cost_per_turn}/turn should dwarf grok $${grok.cost_per_turn}/turn`,
  );
  ok(`per-model cost/turn: opus $${opus.cost_per_turn.toFixed(4)} vs grok $${grok.cost_per_turn.toFixed(4)}`);

  // NOTE: the session holds FOUR model_change records, but the meter counts transitions
  // between BILLED turns - and the switch back to grok-4.5 produced no billed turn before
  // the next switch to opus. Two observed transitions is correct; don't assert on the
  // model_change count, which includes switches that never cost anything.
  assert.ok(s.model_switches >= 2, `expected >=2 observed switches, got ${s.model_switches}`);
  ok(`counted ${s.model_switches} billed model transitions, $${s.switch_spend.toFixed(2)} of cacheWrite after them`);

  console.log("\n  reconstructed breakdown:");
  console.log(`    total          $${s.session_cost.toFixed(4)}  (${s.turns} turns, $${s.cost_per_turn.toFixed(4)}/turn)`);
  for (const c of ["cacheWrite", "cacheRead", "output", "input"]) {
    console.log(`    ${c.padEnd(14)} $${s.spend[c].toFixed(4)}`);
  }
  for (const m of s.by_model) {
    console.log(`    ${m.model.padEnd(26)} ${String(m.turns).padStart(3)} turns  $${m.cost.toFixed(4)}  ($${m.cost_per_turn.toFixed(4)}/turn)`);
  }
} else {
  console.log("  SKIP: 4-model session fixture not present");
}

// --- model-switch preview -------------------------------------------------------
console.log("\nmodel-switch cache-rewrite preview");
{
  assert.equal(cacheRewriteCost({ cost: { cacheWrite: 0 } }, 132000), 0, "grok: free rewrite");
  assert.ok(Math.abs(cacheRewriteCost({ cost: { cacheWrite: 6.25 } }, 132000) - 0.825) < 0.001);
  assert.equal(cacheRewriteCost({ cost: {} }, 132000), null, "unknown pricing must return null");
  assert.equal(cacheRewriteCost(null, 132000), null);
  ok("cacheRewriteCost: $0 for grok, $0.83 for opus at 132k, null when unpriced");
}
{
  const { meter, sent } = harness();
  meter.record({ provider: "xai", model: "grok-4.5",
    usage: { cost: { total: 0.02 }, cacheRead: 90000, totalTokens: 132000 } });
  sent.length = 0;
  const est = meter.previewModelSwitch({ cost: { cacheWrite: 6.25 } }, "claude-opus-5");
  assert.ok(Math.abs(est - 0.825) < 0.001, `estimate ${est}`);
  const w = sent.find((f) => f.type === "cost_warning");
  assert.ok(w && /claude-opus-5/.test(w.message) && /0\.8/.test(w.message),
    `expected a switch warning naming the model and cost, got: ${w && w.message}`);
  assert.ok(/NEW chat/.test(w.message), "should suggest a new chat instead");
  ok("warns before an expensive switch, naming model + estimated cost");
}
{
  // A free rewrite must NOT nag.
  const { meter, sent } = harness();
  meter.record({ provider: "anthropic", model: "claude-opus-5",
    usage: { cost: { total: 0.3 }, totalTokens: 132000 } });
  sent.length = 0;
  const est = meter.previewModelSwitch({ cost: { cacheWrite: 0 } }, "grok-4.5");
  assert.equal(est, 0);
  assert.equal(sent.filter((f) => f.type === "cost_warning").length, 0);
  ok("switching TO a free-cacheWrite model raises no warning");
}
{
  // A model with no pricing metadata: pi reports NO cost object at all. The meter must
  // degrade to "-" rather than show a fabricated $0.00.
  const { meter } = harness();
  meter.record({ provider: "custom", model: "mystery-1",
    usage: { input: 500, output: 100, totalTokens: 600 } });
  const s = meter.snapshot();
  assert.equal(s.pricing_known, false, "must flag missing pricing");
  assert.equal(s.spend, null, "must not fabricate a per-class split");
  assert.equal(s.switch_spend, null);
  ok("unpriced model reports pricing_known=false and no invented split");
}
{
  // REGRESSION GUARD for the bug found on 2026-08-04: an earlier version of this meter
  // computed per-class dollars as (tokens x published rate), which silently understates
  // TIERED pricing - gpt-5.6-sol doubles above 272k input tokens, and Anthropic has
  // cacheWrite1h. The meter must report pi's OWN cost numbers verbatim, never recompute.
  const { meter } = harness();
  // Flat rate would give input 300k x $5/M = $1.50; the tier makes pi charge $3.00.
  meter.record({
    provider: "openai", model: "gpt-5.6-sol",
    usage: {
      input: 300000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 301000,
      cost: { input: 3.0, output: 0.045, cacheRead: 0, cacheWrite: 0, total: 3.045 },
    },
  });
  const s = meter.snapshot();
  assert.equal(s.spend.input, 3.0, "must use pi's tiered input cost, not a flat multiply");
  assert.equal(s.session_cost, 3.045, "total must be pi's total");
  assert.notEqual(s.spend.input, 1.5, "must NOT reproduce the flat-rate understatement");
  ok("tiered pricing: reports pi's $3.00 input cost, not the flat-rate $1.50");
}

// --- spend ledger --------------------------------------------------------------
console.log("\nspend ledger rows");
{
  const rows = [];
  const meter = makeCostMeter({
    send: () => {}, log: () => {}, visible: false,
    key: "agent1", sessionId: "sess-1", contextWindow: 500000,
    ledger: (e) => rows.push(e),
    context: { surface: "device_chat", actorUsername: "chris", agentId: "agent1",
               agentHostname: "JMAX", client: "Farmer Boy", site: "Main" },
  });
  meter.record(INCIDENT_MSG);
  assert.equal(rows.length, 1, "one ledger row per billed turn");
  const r = rows[0];
  assert.equal(r.session_id, "sess-1");
  assert.equal(r.turn_index, 1, "turn_index makes the POST idempotent");
  assert.equal(r.client, "Farmer Boy");
  assert.equal(r.actor_username, "chris");
  assert.equal(r.tokens.cacheRead, 8205);
  assert.equal(r.tokens.total, 608918);
  assert.equal(r.cost.total, 7.51763, "cost must be pi's figure, verbatim");
  assert.equal(r.priced, true);
  assert.ok(r.at && !Number.isNaN(Date.parse(r.at)), "needs an ISO timestamp");
  ok("emits one row per turn with pi's verbatim cost + attribution");
}
{
  // Unpriced turns must be recorded and FLAGGED, not silently dropped or zeroed.
  const rows = [];
  const meter = makeCostMeter({
    send: () => {}, log: () => {}, visible: false, key: "k", sessionId: "s2",
    ledger: (e) => rows.push(e), context: {},
  });
  meter.record({ provider: "custom", model: "mystery-1", usage: { input: 10, output: 5 } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].priced, false, "must flag the row as unpriced");
  assert.equal(rows[0].cost.total, 0);
  ok("unpriced turn is still recorded, flagged priced=false");
}
{
  // A throwing ledger must never propagate into the chat.
  const meter = makeCostMeter({
    send: () => {}, log: () => {}, visible: false, key: "k", sessionId: "s3",
    ledger: () => { throw new Error("db down"); }, context: {},
  });
  assert.doesNotThrow(() => meter.record(INCIDENT_MSG), "ledger failure must be swallowed");
  assert.equal(meter.sessionCost, 7.51763, "accounting continues regardless");
  ok("a failing ledger cannot break the chat or the meter");
}

{
  // REGRESSION: message_end fires for messages that were never billed (user turns, tool
  // results, aborted turns) - they carry no `usage`. A real run on 2026-08-04 wrote THREE
  // empty ledger rows (model="", cost=0), doubled the turn count so cost/turn was halved,
  // and set pricing_known=false which blanked the meter's per-class split.
  const rows = [];
  const meter = makeCostMeter({
    send: () => {}, log: () => {}, visible: true, key: "k", sessionId: "s-unbilled",
    ledger: (e) => rows.push(e), context: {},
  });
  meter.record({ role: "user", content: "hello" });                 // no usage
  meter.record({ role: "toolResult", toolName: "x" });              // no usage
  meter.record({ stopReason: "aborted" });                          // no usage
  assert.equal(rows.length, 0, "unbilled messages must not create ledger rows");
  assert.equal(meter.turns, 0, "unbilled messages must not count as turns");
  assert.equal(meter.snapshot().pricing_known, true, "must not mark pricing unknown");

  meter.record(INCIDENT_MSG);                                       // one real billed turn
  assert.equal(meter.turns, 1, "only billed turns count");
  assert.equal(rows.length, 1);
  const s2 = meter.snapshot();
  assert.equal(s2.cost_per_turn, 7.51763, "cost/turn must not be diluted by unbilled msgs");
  assert.ok(s2.spend && s2.spend.cacheWrite >= 0, "per-class split must survive");
  ok("unbilled message_end events are ignored (no rows, no turn inflation, split intact)");
}

console.log(`\n${pass} assertions passed.\n`);
