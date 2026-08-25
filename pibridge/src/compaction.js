// Compact the conversation: replace the accumulated history with a summary, so the next
// turn re-sends a small context instead of everything said so far.
//
// WHY THIS EXISTS (2026-08-19)
// ---------------------------
// Every turn re-sends the whole conversation. Prompt caching makes that survivable while
// you stay on one model - cached input is roughly a tenth the price of fresh input - but
// two things break it:
//
//   1. LONG CHATS. The context only grows, so cost per turn climbs even when the question
//      is small. A device chat that pulled a few large tool payloads early carries them in
//      every subsequent turn, forever.
//   2. SWITCHING MODEL. The cache belongs to the provider. Switching throws it away and
//      re-sends the ENTIRE conversation at full input price before the new model answers
//      anything - which is the moment the bill jumps.
//
// The cost meter already SAW both of these and warned about them, but the only remedy it
// could offer was "start a new chat", which throws away the context the technician is
// working in. This is the missing half: keep the thread, drop the weight.
//
// The harness owns the hard part (`session.compact()` summarises and rewrites history,
// and the UI's durable branch is rebuilt from the session file, so the operator's
// transcript is NOT lost - see the compaction handling in server.js). This module is the
// operational wrapper: decide whether compacting is worth it, run it safely, and report
// what it saved in money rather than tokens.

/** Compaction has an LLM call of its own, so it is not free. Below this, don't bother. */
export const MIN_TOKENS_TO_COMPACT = 20000;

/**
 * Is compacting this session worth doing right now?
 * @returns {{worth: boolean, reason: string}}
 */
export function shouldCompact({ contextTokens = 0, contextWindow = 0, min = MIN_TOKENS_TO_COMPACT } = {}) {
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
    return { worth: false, reason: "nothing has been sent yet - there is no context to compact" };
  }
  if (contextTokens < min) {
    return {
      worth: false,
      reason: `the conversation is only ${contextTokens.toLocaleString("en-US")} tokens; ` +
        `compacting costs a summarisation call of its own and would not pay for itself yet`,
    };
  }
  if (contextWindow > 0 && contextTokens >= contextWindow) {
    // Still allowed: this is exactly when it is needed most.
    return { worth: true, reason: "the context is at or past the model's window" };
  }
  return { worth: true, reason: "" };
}

/**
 * Run a compaction and describe the result.
 *
 * Never throws: a failed compaction must leave the chat usable, because the technician is
 * mid-task and losing the window is worse than paying for a big one.
 *
 * @param session      pi AgentSession
 * @param opts.reason  short label for the log ("technician asked", "model switch", ...)
 * @param opts.instructions  optional steer for the summary
 * @param opts.log     logger
 */
export async function runCompaction(session, { reason = "requested", instructions, log, key, sessionId } = {}) {
  if (!session || typeof session.compact !== "function") {
    return { ok: false, error: "this session does not support compaction" };
  }
  if (session.isCompacting) {
    return { ok: false, error: "a compaction is already running" };
  }
  const started = Date.now();
  try {
    const res = await session.compact(instructions);
    const before = Number(res?.tokensBefore || 0);
    // estimatedTokensAfter is the harness's own estimate; it is not always present.
    const after = Number(res?.estimatedTokensAfter || 0);
    const saved = before && after ? Math.max(0, before - after) : 0;
    log?.("compacted", key, sessionId,
      `${reason}: ${before.toLocaleString("en-US")} -> ${after ? after.toLocaleString("en-US") : "?"} tokens ` +
      `in ${Math.round((Date.now() - started) / 1000)}s`);
    return {
      ok: true,
      tokensBefore: before,
      tokensAfter: after,
      saved,
      summary: String(res?.summary || ""),
      usage: res?.usage || null,
    };
  } catch (e) {
    const why = String(e?.message || e);
    log?.("compact_error", key, sessionId, `${reason}: ${why.slice(0, 300)}`);
    return { ok: false, error: why };
  }
}

/**
 * The typed command. Deliberately a CHAT COMMAND rather than only a button: it works in
 * every window immediately, including surfaces whose UI has not been rebuilt, and it is
 * something a technician can be told over the phone.
 */
// Prefixed form takes trailing instructions: "/compact keep the fio numbers".
const COMPACT_PREFIXED = /^\s*[/!]compact\b\s*(.*)$/is;
// Bare form must be the WHOLE message. Otherwise "compact the disk on server X" - a
// perfectly ordinary request - would be swallowed as a command and the technician would
// watch their question vanish into a summarisation.
const COMPACT_BARE = /^\s*compact\s*$/i;

/** Is this prompt the compact command? Returns the optional custom instructions. */
export function parseCompactCommand(text) {
  const s = String(text || "");
  const m = COMPACT_PREFIXED.exec(s);
  if (m) return { instructions: (m[1] || "").trim() || undefined };
  if (COMPACT_BARE.test(s)) return { instructions: undefined };
  return null;
}

/**
 * Wire the command to one chat surface. Returns { isCommand, run }.
 *
 * `run` never throws and always tells the technician something: a compaction that fails
 * silently looks identical to one that did nothing, and they will just type it again.
 */
export function makeCompactCommand({
  session, costMeter, send, log, key, sessionId,
  currentModel = () => null, rateLookup = null, inTurn = (fn) => fn(),
}) {
  return {
    isCommand: (text) => parseCompactCommand(text) !== null,

    async run(text, { reason = "technician asked" } = {}) {
      const parsed = parseCompactCommand(text) || {};
      const before = Number(costMeter?.contextTokens || 0);
      const window = Number(currentModel()?.contextWindow || 0);
      const worth = shouldCompact({ contextTokens: before, contextWindow: window });
      if (!worth.worth) {
        send({ type: "error", message: `Nothing to compact: ${worth.reason}.` });
        return { ok: false, skipped: true };
      }

      send({
        type: "working", elapsed_ms: 0, quiet_ms: 0, alive: true, last_byte_ms: null,
        bytes: 0, tools_in_flight: 0,
        note: "Compacting the conversation...",
      });

      // Compaction is itself an LLM call, so run it inside the liveness context - it is
      // exactly the kind of long quiet request the stall watchdog used to kill.
      const res = await inTurn(() => runCompaction(session, {
        reason, instructions: parsed.instructions, log, key, sessionId,
      }));

      if (!res.ok) {
        send({ type: "error", message: `Could not compact the conversation: ${res.error}. Nothing was changed - the chat is exactly as it was.` });
        return res;
      }

      const after = res.tokensAfter || 0;
      if (after) costMeter?.noteCompaction?.(after);
      const detail = describeSaving({
        tokensBefore: res.tokensBefore, tokensAfter: after,
        model: currentModel(), rateLookup,
      });
      send({
        type: "compacted",
        tokens_before: res.tokensBefore,
        tokens_after: after,
        saved: res.saved,
        detail,
        message: `Conversation compacted: ${detail || `${res.tokensBefore.toLocaleString("en-US")} tokens summarised`}. ` +
          `Everything above is still readable here; the model now starts from a summary, so ` +
          `following turns cost far less.`,
      });
      // Refresh the meter so the header stops showing the pre-compaction size.
      if (costMeter?.snapshot) send(costMeter.snapshot());
      return res;
    },
  };
}

/**
 * What a compaction is worth, in money, at this model's rates.
 *
 * Tokens do not motivate anyone; a number with a currency symbol does. This is the
 * per-turn saving from here on, which is the honest way to describe it: the summarisation
 * call is paid once, the smaller context is paid on every turn that follows.
 */
export function describeSaving({ tokensBefore, tokensAfter, model, rateLookup }) {
  const before = Number(tokensBefore || 0);
  const after = Number(tokensAfter || 0);
  if (!before || !after || after >= before) return "";
  const pct = Math.round(((before - after) / before) * 100);
  const base = `${before.toLocaleString("en-US")} -> ${after.toLocaleString("en-US")} tokens (${pct}% smaller)`;

  let rate = null;
  try {
    const c = rateLookup && model ? rateLookup(model.provider, model.id) : model?.cost;
    // Cached input is what a continuing conversation actually pays per turn.
    if (c && Number.isFinite(Number(c.cacheRead))) rate = Number(c.cacheRead);
  } catch { /* pricing is advisory */ }
  if (rate === null) return base;

  const perTurn = ((before - after) / 1_000_000) * rate;
  if (perTurn < 0.001) return base;
  return `${base}, about $${perTurn.toFixed(3)} less per turn from here`;
}
