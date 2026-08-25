// Force-abort a streaming turn that has gone silent, so a chat can never hang forever
// with no agent_end and no explanation.
//
// Silence while a tool call is in flight does NOT count: device commands legitimately run
// for minutes, and every tool call is bounded by its own transport timeout, so tools
// always settle on their own.
//
// IT IS NO LONGER A GUESS (2026-08-18, later the same day)
// --------------------------------------------------------
// Everything below was written for a watchdog that could only time the gaps between
// parsed agent events. Measuring the actual socket showed that gap is not evidence of
// anything: xAI sends `: keepalive` every 15s for the whole turn, the SSE spec says
// parsers drop comments, so the wire stays busy while the parser output is flat. Measured
// on one real turn: 74,850ms between parsed events, 14,474ms longest gap on the wire.
//
// So liveness is now READ, not inferred (see stream-liveness.js), and the rule is:
//   - bytes still arriving  -> alive, however long it thinks. Never aborted.
//   - no bytes for `deadStreamMs` (several missed heartbeats) -> genuinely dead, and it
//     can be called in ~1 minute instead of 3.
//   - liveness unavailable (unwrapped provider, patch failed) -> fall back to the old
//     event-silence budget below, so the safety net never disappears entirely.
// The claim/escalate/re-run machinery is kept for both paths: a dead socket is usually
// transient, and a turn killed for it should still be retried rather than lost.
//
// WHY IT USED TO BE A GUESS, AND WHY THAT MATTERED (2026-08-18)
// ------------------------------------------------------------
// Silence is only weak evidence of a dead stream. A model building one very large tool
// argument is also silent - for minutes - and then arrives complete. On 2026-08-18 a
// technician asked for a long technical email; grok-4.5 streamed a one-line preamble and
// went quiet for 208s assembling a ~20k-char `send_email` argument, which xAI's Responses
// API emits as a single block rather than incremental deltas. The watchdog called it dead
// and aborted a turn that was working fine.
//
// Worse than the false positive was what the abort did downstream: an abort is how a
// technician pressing Stop looks, so every retry layer stood down (pi-ai's
// `retryAssistantCall` returns immediately on `stopReason:"aborted"`), the turn died with
// no answer, and the technician was told to resend. Resending re-ran an identically slow
// request into an identically tight budget and failed the same way. Two attempts, seven
// minutes, no email.
//
// So this watchdog owns the consequences of its own guess:
//   1. it CLAIMS the abort (`recovery.noteWatchdogStall`), which is what distinguishes
//      our timeout from the technician's Stop and makes the turn retryable,
//   2. it WIDENS the budget before retrying, because re-running the same request under
//      the same limit is just a slower way to fail,
//   3. it DRAINS the recovery itself rather than trusting whoever started the turn to do
//      it - a claimed abort nobody re-runs is a silent chat, the original bug.
// Only when the widened attempt also goes silent is the technician told, and then with
// advice that can actually work (ask for the work in smaller pieces).

/**
 * @param session         the pi AgentSession (needs `.isStreaming` and `.abort()`)
 * @param recovery        an llm-recovery instance (see llm-recovery.js)
 * @param toolsInFlight   () => number of tool calls currently executing
 * @param lastActivityAt  () => ms timestamp of the last agent event
 * @param stallMs         event-silence allowed when liveness is unavailable (fallback)
 * @param escalation      budget multiplier applied after an abort of ours
 * @param maxStallMs      ceiling for the widened fallback budget
 * @param liveness        per-turn tracker from stream-liveness.js (optional)
 * @param deadStreamMs    wire silence that means the stream is really dead
 * @param maxTurnMs       absolute ceiling for one streaming turn; 0 disables
 * @param intervalMs      how often to look
 * @param timers          injectable for tests
 */
export function makeTurnWatchdog({
  session, recovery, log, key, sessionId,
  toolsInFlight = () => 0,
  lastActivityAt = () => Date.now(),
  liveness = null,
  deadStreamMs = 60 * 1000,
  maxTurnMs = 20 * 60 * 1000,
  stallMs, escalation = 3, maxStallMs = 15 * 60 * 1000, intervalMs = 30 * 1000,
  // Re-runs must execute inside the same liveness context as the turn they replace, or
  // the retried turn is measured as having no transport signal at all.
  runTurn = (fn) => fn(),
  timers = { setInterval, clearInterval },
} = {}) {
  let budgetMs = stallMs;
  // One abort per stall: the interval keeps firing while abort() settles.
  let handled = false;
  // Activity floor. Our own re-run counts as activity even though it emits no agent
  // event of its own, so the widened budget is measured from the retry rather than from
  // the silence that caused it - otherwise the retried turn is judged already-stalled
  // the instant it starts.
  let baselineAt = 0;
  let timer = null;

  // Never below the current budget (a mis-set escalation must not tighten the leash),
  // never above the ceiling (an unattended chat must not hang for an hour).
  const widened = () =>
    Math.min(Math.max(Math.round(budgetMs * escalation), budgetMs), maxStallMs);

  async function check() {
    if (!session.isStreaming) {
      handled = false; // the turn is over; re-arm for the next one
      return false;
    }
    if (handled || toolsInFlight() > 0) return false;

    // Transport liveness first: it is a measurement, not an inference.
    const quietMs = liveness?.quietMs?.() ?? null;
    let reason = null;
    let silentFor = 0;

    if (quietMs !== null) {
      const elapsedMs = liveness.elapsedMs?.() ?? 0;
      if (quietMs > deadStreamMs) {
        silentFor = Math.round(quietMs / 1000);
        reason = `no bytes from the provider for ${silentFor}s ` +
                 `(${liveness.bytes}B in ${liveness.chunks} chunks this turn) - stream is dead`;
      } else if (maxTurnMs > 0 && elapsedMs > maxTurnMs) {
        silentFor = Math.round(elapsedMs / 1000);
        reason = `turn still streaming after ${silentFor}s, past the ` +
                 `${Math.round(maxTurnMs / 60000)}min ceiling - abandoning it`;
      } else {
        return false; // bytes are flowing: the model is working, however quiet it looks
      }
    } else {
      // No liveness signal for this turn. Fall back to timing agent events, which is a
      // guess - so keep the widening budget that stops it killing the same work twice.
      const silentMs = Date.now() - Math.max(lastActivityAt(), baselineAt);
      if (silentMs <= budgetMs) return false;
      silentFor = Math.round(silentMs / 1000);
      reason = `no agent events for ${silentFor}s and no transport liveness available ` +
               `(budget ${Math.round(budgetMs / 1000)}s)`;
    }

    handled = true;
    const nextBudgetMs = widened();
    log?.("turn_stall", key, sessionId,
      `${reason}; aborting turn, next fallback budget ${Math.round(nextBudgetMs / 1000)}s`);

    // Claim BEFORE aborting: message_end fires synchronously inside abort(), and the
    // handler that decides whether to re-run keys off exactly this claim.
    recovery.noteWatchdogStall(silentFor);
    budgetMs = nextBudgetMs;
    try {
      await session.abort();
    } catch (e) {
      log?.("turn_stall abort error", key, sessionId, String(e?.message || e));
    }
    // Re-arm BEFORE re-running. The re-run puts the session straight back into streaming
    // and `continue()` does not resolve until that whole turn is done, so a watchdog that
    // stayed "handled" for the duration would leave the retried turn unwatched - a chat
    // that hangs forever, which is worse than the bug being fixed. The activity floor
    // above is what stops this from instantly re-aborting on the stale timestamp.
    baselineAt = Date.now();
    handled = false;
    liveness?.reset?.();
    // Draining twice is harmless - run() disarms before it awaits - so the prompt
    // handler's own loop can stay where it is for the provider-fault path.
    await runTurn(async () => {
      while (recovery.pending) {
        if (!(await recovery.run(session))) break;
      }
    });
    return true;
  }

  return {
    start() {
      if (stallMs > 0 && !timer) timer = timers.setInterval(check, intervalMs);
      return this;
    },
    stop() {
      if (timer) { timers.clearInterval(timer); timer = null; }
    },
    /** A new technician request earns a fresh, tight budget. */
    resetBudget() { budgetMs = stallMs; baselineAt = 0; },
    /** Current allowance, for logging. */
    get budgetMs() { return budgetMs; },
    /** Run one check now. Exposed for tests. */
    check,
  };
}
