// The spend outbox: a ledger POST that fails must be OWED, not forgotten.
//
// Unattended surfaces (scheduled AI tasks, triage, auto-resolve, report summaries, the
// assist helpers) run in-memory sessions with no transcript, so a lost POST there is money
// that nothing anywhere can ever recover. These tests pin the behaviour that prevents it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OUTBOX = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-spend-")), "outbox.jsonl");
process.env.PI_SPEND_OUTBOX = OUTBOX;

// The module POSTs through trmm.logSpend; swap the transport by intercepting fetch, which
// is what trmm.js ultimately uses.
const { ledgerSink, flushSpendOutbox } = await import("../src/spend-ledger.js");

let failNext = 0;
let posted = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (!String(url).includes("/core/ai/spend-entry/")) return realFetch(url, opts);
  if (failNext > 0) {
    failNext--;
    return new Response("boom", { status: 500 });
  }
  posted.push(JSON.parse(opts.body));
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "content-type": "application/json" },
  });
};

const entry = (turn) => ({
  session_id: "s-test", turn_index: turn, surface: "unattended",
  provider: "anthropic", model_id: "m", cost: { total: 0.5 },
});
const settle = () => new Promise((r) => setTimeout(r, 30));
const outboxLines = () =>
  (fs.existsSync(OUTBOX) ? fs.readFileSync(OUTBOX, "utf8") : "").split("\n").filter(Boolean);

test("a successful write leaves nothing owed", async () => {
  posted = []; failNext = 0;
  ledgerSink(() => {})(entry(1));
  await settle();
  assert.equal(posted.length, 1);
  assert.equal(outboxLines().length, 0);
});

test("a failed write is queued rather than lost", async () => {
  posted = []; failNext = 1;
  ledgerSink(() => {})(entry(2));
  await settle();
  assert.equal(posted.length, 0, "the POST failed");
  const owed = outboxLines();
  assert.equal(owed.length, 1);
  assert.equal(JSON.parse(owed[0]).turn_index, 2, "the whole charge is kept, not a summary");
});

test("the retry loop pays what is owed and clears the outbox", async () => {
  posted = []; failNext = 0;
  const res = await flushSpendOutbox(() => {});
  assert.equal(res.sent, 1);
  assert.equal(res.pending, 0);
  assert.equal(posted[0].turn_index, 2, "the retried row is the one that failed");
  assert.equal(outboxLines().length, 0);
});

test("a retry that fails again keeps the charge owed - money is never dropped", async () => {
  posted = []; failNext = 1;
  ledgerSink(() => {})(entry(3));
  await settle();
  failNext = 1;                       // still down when the loop runs
  const res = await flushSpendOutbox(() => {});
  assert.equal(res.sent, 0);
  assert.equal(res.pending, 1);
  assert.equal(outboxLines().length, 1);
  failNext = 0;                       // API comes back
  const res2 = await flushSpendOutbox(() => {});
  assert.equal(res2.sent, 1);
  assert.equal(outboxLines().length, 0);
});

test("several failures queue several charges, and all of them are paid", async () => {
  posted = []; failNext = 3;
  const sink = ledgerSink(() => {});
  sink(entry(10)); sink(entry(11)); sink(entry(12));
  await settle();
  assert.equal(outboxLines().length, 3);
  const res = await flushSpendOutbox(() => {});
  assert.equal(res.sent, 3);
  assert.deepEqual(posted.map((p) => p.turn_index).sort(), [10, 11, 12]);
  assert.equal(outboxLines().length, 0);
});

test("an empty outbox is a no-op", async () => {
  const res = await flushSpendOutbox(() => {});
  assert.deepEqual(res, { pending: 0, sent: 0 });
});
