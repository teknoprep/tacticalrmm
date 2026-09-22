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
 * Rough token estimate for a session the cost meter has not measured yet (~4 chars per
 * token). Exists for exactly one case: the bridge restarted and the window RESUMED a
 * session from disk - the history (and its per-turn cost) is fully there, but the fresh
 * in-memory meter reads zero until the next turn reports usage. Without this, "compact"
 * refuses right after a restart, which is precisely when a long chat wants it most.
 */
export function estimateContextTokens(session) {
  try {
    const msgs = session?.messages || [];
    let chars = 0;
    for (const m of msgs) chars += JSON.stringify(m)?.length || 0;
    return Math.round(chars / 4);
  } catch {
    return 0;
  }
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
function handoffInstructions(note) {
  const n = String(note || "").trim();
  if (!n) return undefined;
  return (
    `TECHNICIAN HANDOFF — this is AUTHORITATIVE and overrides earlier checklist items, ` +
    `"In Progress" lines, and any previous summary in this conversation:\n\n${n}\n\n` +
    `Rules:\n` +
    `- If the note says something is done, working, finished, or closed, put it under Done. ` +
    `Do NOT keep a leftover "verify / retry / in progress" item for that same thing.\n` +
    `- This is a chapter break. Summarise what is finished, what still matters for the NEXT stretch, ` +
    `and what to ignore. Drop stale open items the note just closed.\n` +
    `- Keep names, IDs, paths, numbers, and decisions. Do not invent new work.`
  );
}

export async function runCompaction(session, { reason = "requested", instructions, log, key, sessionId } = {}) {
  if (!session || typeof session.compact !== "function") {
    return { ok: false, error: "this session does not support compaction" };
  }
  if (session.isCompacting) {
    return { ok: false, error: "a compaction is already running" };
  }
  const started = Date.now();
  const steer = handoffInstructions(instructions);
  try {
    const res = await session.compact(steer);
    const before = Number(res?.tokensBefore || 0);
    // estimatedTokensAfter is the harness's own estimate; it is not always present.
    const after = Number(res?.estimatedTokensAfter || 0);
    const saved = before && after ? Math.max(0, before - after) : 0;
    log?.("compacted", key, sessionId,
      `${reason}: ${before.toLocaleString("en-US")} -> ${after ? after.toLocaleString("en-US") : "?"} tokens ` +
      `in ${Math.round((Date.now() - started) / 1000)}s` +
      (steer ? ` note=${JSON.stringify(String(instructions).trim().slice(0, 80))}` : ""));
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
  // Optional: drop oversized tool results out of the model's context before summarising
  // (context-trim.js). Injected so this module keeps no opinion about session internals.
  trimContext = null,
  // "Summarise & clear history": writes a durable cut marker into the session file so
  // every rebuilt transcript (reload, resume, the phone) starts at the cut. Optional -
  // a surface that does not pass it simply cannot clear.
  markCleared = null,
  // Optional: switch to the group's cheap summarizer for the compact call, then
  // put the orchestrator back. Failures must still restore the original model.
  prepareSummarizer = null,
  restoreAfter = null,
}) {
  return {
    isCommand: (text) => parseCompactCommand(text) !== null,

    async run(text, { reason = "technician asked", clear = false, instructions } = {}) {
      const parsed = parseCompactCommand(text) || {};
      if (instructions !== undefined && instructions !== null && String(instructions).trim()) {
        parsed.instructions = String(instructions).trim();
      }
      // Prefer the measured figure; fall back to an estimate for a freshly resumed
      // session (bridge restart) whose meter has not seen a turn yet.
      const measured = Number(costMeter?.contextTokens || 0);
      const before = measured > 0 ? measured : estimateContextTokens(session);
      const window = Number(currentModel()?.contextWindow || 0);
      const worth = shouldCompact({ contextTokens: before, contextWindow: window });
      if (!worth.worth) {
        send({ type: "error", message: `Nothing to compact: ${worth.reason}.` });
        return { ok: false, skipped: true };
      }

      // ONE OVERSIZED TOOL RESULT FIRST (see context-trim.js). Compaction summarises whole
      // turns up to a cut point and KEEPS the recent tail - so a single 3 MB tool result
      // sitting in that tail survives the compaction and the chat stays wedged. Worse, when
      // the tail is the only thing after the last cut point, the harness refuses outright
      // with "Nothing to compact (session too small)" on a conversation of 871,000 tokens,
      // which is where the owner found himself on 2026-09-22: unable to talk to it AND
      // unable to compact it.
      //
      // Dropping the monster out of CONTEXT (never out of the transcript) both un-wedges
      // the window on its own and gives the summariser something it can actually cut.
      let trimmed = { trimmed: [], freed: 0, note: "" };
      if (typeof trimContext === "function") {
        try { trimmed = trimContext() || trimmed; } catch (e) {
          log?.("compact_trim_error", key, sessionId, String(e?.message || e).slice(0, 200));
        }
        if (trimmed.note) send({ type: "system_note", text: trimmed.note });
      }

      send({
        type: "working", elapsed_ms: 0, quiet_ms: 0, alive: true, last_byte_ms: null,
        bytes: 0, tools_in_flight: 0,
        note: "Compacting the conversation...",
      });

      // Compaction is itself an LLM call, so run it inside the liveness context - it is
      // exactly the kind of long quiet request the stall watchdog used to kill.
      let res;
      try {
        if (typeof prepareSummarizer === "function") await prepareSummarizer();
        res = await inTurn(() => runCompaction(session, {
          reason, instructions: parsed.instructions, log, key, sessionId,
        }));
      } finally {
        if (typeof restoreAfter === "function") {
          try { await restoreAfter(); } catch (e) {
            log?.("compact_restore_error", key, sessionId, String(e?.message || e).slice(0, 200));
          }
        }
      }

      if (!res.ok) {
        // "Nothing to compact (session too small)" from the harness means there is no cut
        // point it is willing to use - NOT that the conversation is small. Saying "too
        // small" to someone looking at a 871k-token window that refuses every prompt is
        // how a person ends up with no idea what to do, so say what is actually true and
        // what just happened about it.
        const tooSmall = /too small|nothing to compact/i.test(String(res.error || ""));
        const huge = window > 0 && before >= window * 0.8;
        let message = `Could not compact the conversation: ${res.error}. Nothing was changed - the chat is exactly as it was.`;
        if (tooSmall && huge) {
          message =
            `This conversation is ${before.toLocaleString("en-US")} tokens against a ` +
            `${window.toLocaleString("en-US")}-token window, but it cannot be summarised: ` +
            `everything since the last summary is a single exchange, so there is nothing for ` +
            `the summariser to cut. ` +
            (trimmed.trimmed.length
              ? `The oversized tool output has been dropped from the AI's context, so send your ` +
                `message again - it should go through now.`
              : `The weight is not in the conversation - it is in one large tool result. Start a ` +
                `new chat (the transcript and cost stay in AI History), or ask an admin to check ` +
                `the bridge log for the oversized tool call.`);
        }
        send({ type: "error", message });
        return { ...res, trimmed: trimmed.trimmed };
      }

      const after = res.tokensAfter || 0;
      if (after) costMeter?.noteCompaction?.(after);
      const detail = describeSaving({
        tokensBefore: res.tokensBefore, tokensAfter: after,
        model: currentModel(), rateLookup,
      });
      // The clear marker goes in only AFTER a successful compaction: clearing the screen
      // without the summary would genuinely lose the technician's working context.
      let cleared = false;
      if (clear && typeof markCleared === "function") {
        try { markCleared(); cleared = true; }
        catch (e) { log?.("compact_clear_error", key, sessionId, String(e?.message || e).slice(0, 200)); }
      }
      send({
        type: "compacted",
        cleared,
        // The summary itself - "where we are now". The window shows it so the technician
        // is never staring at a cleared screen wondering what the AI still knows.
        summary: String(res.summary || ""),
        tokens_before: res.tokensBefore,
        tokens_after: after,
        saved: res.saved,
        detail,
        message: cleared
          ? `Conversation summarised and history cleared: ${detail || `${res.tokensBefore.toLocaleString("en-US")} tokens summarised`}. ` +
            `Pi keeps working from the summary in this same window; the full transcript is ` +
            `still on disk and in AI History.`
          : `Conversation compacted: ${detail || `${res.tokensBefore.toLocaleString("en-US")} tokens summarised`}. ` +
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
