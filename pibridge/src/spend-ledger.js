// ONE way to put money in the ledger.
//
// WHY THIS EXISTS: `AISpendEntry` was created (2026-08-04) precisely because spend that
// lived only in the session `.jsonl` files was unattributable and got DELETED with the
// chat. But only three surfaces were ever wired to it - the device chat, the ticket chat
// and the Odoo panel - each with its own hand-rolled copy of the same fire-and-forget
// POST. Every other surface that runs a model (scheduled AI tasks, alert verifiers,
// reports, ticket triage, auto-resolve, procedure mining, the assist helpers, and the
// agent-group specialists, which run in a temp dir that is DELETED afterwards) billed
// real money and wrote nothing anywhere. Measured 2026-09-14: 2,307 sessions holding
// $527 had no ledger row at all, and the agent-group specialists left no trace even on
// disk.
//
// So: a surface no longer opts IN to accounting by remembering to build a cost meter.
// It calls `attachSpendLedger(session, ctx)` on the line after `createAgentSession()` and
// every billed turn is recorded, with no UI and no per-surface bookkeeping code.
//
// ACCOUNTING RULE (unchanged, see cost-meter.js): every dollar is the figure the runtime
// reported for that call. Nothing here recomputes anything from a rate table.
import fs from "node:fs";
import path from "node:path";
import { makeCostMeter } from "./cost-meter.js";
import { trmm } from "./trmm.js";
import { CONFIG } from "./config.js";

// ---- the outbox -----------------------------------------------------------------
//
// A ledger POST can fail: the API restarts during a deploy, a migration holds a lock,
// the box is briefly out of memory. Before this, that money was simply GONE - the write
// was fire-and-forget, the failure was logged, and nothing ever tried again. It happens
// in practice: five turns were lost that way during this very change, in a 90-second
// window while the API was restarting.
//
// For a chat there is at least a transcript to recover from later (`manage.py
// backfill_ai_spend`). For unattended work - scheduled AI tasks, triage, auto-resolve,
// the report summariser, the assist helpers - there is NO transcript: those sessions are
// in-memory and vanish. A failed POST there is money that no process anywhere can ever
// account for again.
//
// So every failed row is appended to a small file on disk and retried until the API
// takes it. Retries are safe because the ledger is idempotent on (session_id,turn_index).
// Nothing is ever dropped: an entry that keeps failing keeps being retried, and the
// backlog is reported in the log so a permanent problem is visible.
const OUTBOX = process.env.PI_SPEND_OUTBOX ||
  path.join(path.dirname(CONFIG.sessionsRoot), "spend-outbox.jsonl");
const RETRY_MS = Number(process.env.PI_SPEND_RETRY_MS || 60_000);
const RETRY_BATCH = Number(process.env.PI_SPEND_RETRY_BATCH || 200);

function stash(entry, log) {
  try {
    fs.appendFileSync(OUTBOX, `${JSON.stringify(entry)}\n`);
  } catch (e) {
    // The last line of defence failed. This is the one case where money really is at
    // risk, so say so unmistakably.
    log("spend_outbox_write_failed", entry.surface, entry.session_id,
        `turn ${entry.turn_index}: ${String(e?.message || e).slice(0, 200)} - THIS CHARGE IS UNRECORDED`);
  }
}

/** Read the outbox, retry each row, rewrite what is still owed. */
export async function flushSpendOutbox(log = () => {}) {
  let lines;
  try {
    if (!fs.existsSync(OUTBOX)) return { pending: 0, sent: 0 };
    lines = fs.readFileSync(OUTBOX, "utf8").split("\n").filter(Boolean);
  } catch (e) {
    log("spend_outbox_read_failed", String(e?.message || e).slice(0, 200));
    return { pending: 0, sent: 0 };
  }
  if (!lines.length) return { pending: 0, sent: 0 };

  const keep = [];
  let sent = 0;
  for (const [i, line] of lines.entries()) {
    if (i >= RETRY_BATCH) { keep.push(line); continue; }  // next pass takes the rest
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // unparseable: drop the line, not a charge
    try {
      await trmm.logSpend(entry);
      sent++;
    } catch {
      keep.push(line);
    }
  }
  try {
    // Rewrite whole-file: the outbox is small (it is only ever a backlog) and a partial
    // write here would be a lost charge.
    const tmp = `${OUTBOX}.tmp`;
    fs.writeFileSync(tmp, keep.length ? `${keep.join("\n")}\n` : "");
    fs.renameSync(tmp, OUTBOX);
  } catch (e) {
    log("spend_outbox_rewrite_failed", String(e?.message || e).slice(0, 200),
        "entries may be retried again (harmless: the ledger is idempotent)");
  }
  if (sent || keep.length) {
    log("spend_outbox", `recovered ${sent} row(s)`, `${keep.length} still owed`);
  }
  return { pending: keep.length, sent };
}

/** Start the retry loop. Called once at bridge startup. */
export function startSpendOutbox(log = () => {}) {
  const tick = () => { flushSpendOutbox(log).catch(() => {}); };
  tick();                                   // clear anything left by the last process
  const t = setInterval(tick, RETRY_MS);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}

/**
 * The durable sink: POST one row, never throw, never stay silent about a failure, and
 * never lose the charge - a failed write goes to the outbox and is retried until it lands.
 */
export function ledgerSink(log = () => {}) {
  return (entry) => {
    trmm.logSpend(entry).catch((e) => {
      log("spend_ledger_error", entry.surface, entry.session_id,
          `turn ${entry.turn_index}: ${String(e?.message || e).slice(0, 300)} - queued for retry`);
      stash(entry, log);
    });
  };
}

/**
 * Record every billed turn of a session in the durable ledger. Headless: no frames, no
 * warnings, no cost meter in anyone's UI - just the money.
 *
 * Use this for surfaces with no operator watching. Interactive chats build a full
 * `makeCostMeter` (which also feeds the on-screen meter) and pass it `ledger: ledgerSink(log)`.
 *
 * @param {object} session  the AgentSession returned by createAgentSession()
 * @param {object} ctx
 * @param {string} ctx.surface        one of AISpendEntry.SURFACE
 * @param {function} [ctx.log]
 * @param {string} [ctx.key]          agent id / ticket ref, for log lines
 * @param {string} [ctx.actorUsername] who caused the spend ("" for schedule-driven work)
 * @param {string} [ctx.agentId] [ctx.agentHostname] [ctx.client] [ctx.site] [ctx.ticketRef]
 * @param {string} [ctx.sessionId]    defaults to session.sessionId; pass one for sessions
 *                                    that have no durable id of their own (agent-group
 *                                    specialists run in a temp dir that is then deleted).
 * @returns {function} unsubscribe
 */
export function attachSpendLedger(session, ctx = {}) {
  const log = ctx.log || (() => {});
  const sessionId = String(ctx.sessionId || session?.sessionId || "");
  if (!sessionId) {
    // No id means no idempotency key, which means a retry could double-bill. Refusing to
    // record is wrong too, so make it loud and use a synthetic id: an attributable row
    // with an odd id beats a missing dollar.
    log("spend_ledger_error", ctx.surface || "?", "-", "session had no id; using a synthetic one");
  }
  const meter = makeCostMeter({
    send: () => {},          // nobody is watching this one
    visible: false,
    log,
    key: ctx.key || ctx.agentId || ctx.ticketRef || "",
    sessionId: sessionId || `nosid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ledger: ledgerSink(log),
    context: {
      surface: ctx.surface || "other",
      actorUsername: ctx.actorUsername || "",
      agentId: ctx.agentId || "",
      agentHostname: ctx.agentHostname || "",
      client: ctx.client || "",
      site: ctx.site || "",
      ticketRef: ctx.ticketRef || "",
    },
  });
  const unsubscribe = session.subscribe((event) => {
    if (event?.type === "message_end" && event.message?.role === "assistant") {
      // record() ignores messages with no usage (user turns, tool results, aborts).
      meter.record(event.message);
    }
  });
  return () => { try { unsubscribe(); } catch { /* already gone */ } };
}
