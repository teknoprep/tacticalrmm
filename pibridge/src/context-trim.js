// Get a wedged conversation moving again by dropping ONE oversized tool result out of the
// model's context.
//
// WHY THIS EXISTS (2026-09-22, reported by the owner: "i can't summarize and compact... i
// can't continue")
// -------------------------------------------------------------------------------------
// A single `helpdesk_call` (list_closed_tickets, two months, full message bodies) returned
// 2.96 MB - roughly 740,000 tokens - into a conversation on a 500,000-token model. From
// that moment:
//
//   * every prompt came back `input_too_large` before the model saw a word of it, and
//   * "Summarise & clear" REFUSED with "Nothing to compact (session too small)", because
//     compaction summarises whole turns up to a cut point, and the only thing after the
//     last cut point was that one monstrous tool result. There was nothing it was willing
//     to cut, so the one tool meant for exactly this situation declined to act.
//
// The window was therefore a dead end: too big to talk to, too "small" to compact. The
// only ways out were a new chat (losing the context the technician was working in) or an
// engineer on the box. Auto-compaction eventually broke the deadlock ~5 minutes later by
// cutting a second time, which is luck, not a design.
//
// THE FIX. The problem is never the conversation - it is one or two individual entries that
// have no business being in a context window. The harness already has the mechanism for
// this: a `context_edit` entry replaces what an earlier entry contributes to the model's
// context, branch-locally and without rewriting history. So we find the outsized entries,
// replace each with a one-line marker saying what was removed and why, and refresh the
// finalized context. The transcript on disk is untouched: the technician can still read the
// full result, and the summary/cost trail is unaffected.
//
// DELIBERATE LIMITS
//   * TOOL RESULTS ONLY. Never a person's words and never the model's own messages: the
//     first would be editing what the technician said, the second would rewrite the
//     assistant's reasoning under it. Bulk in this system is always tool output.
//   * Biggest first, and only what is actually oversized (see `minBytes`), so this can
//     never quietly thin out a normal conversation.
//   * Idempotent: an entry whose projected contribution is already the marker (or nothing)
//     is not "oversized" any more, so repeated runs do nothing.
//   * Never throws. It runs on the path where the chat is ALREADY broken.
const DEFAULT_MIN_BYTES = Number(process.env.PI_CONTEXT_TRIM_MIN_BYTES || 150_000);

const bytes = (value) => {
  try { return Buffer.byteLength(JSON.stringify(value) || "", "utf8"); } catch { return 0; }
};

const mb = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.round(n / 1000)} KB`);

/** ~4 chars per token, the same rule of thumb the cost meter's fallback uses. */
export const approxTokens = (byteCount) => Math.round(byteCount / 4);

// "The prompt is too long for this model's context window (871750 tokens > 500000)" - xai.
// Every provider words it differently and some send no code at all, so match the meaning.
// Deliberately narrow: this must not fire on an ordinary rate limit or a bad API key,
// because the response to it is to edit what the model is being sent.
const OVERFLOW = new RegExp([
  "input_too_large", "context_length_exceeded", "prompt is too long",
  "too long for this model", "maximum context", "context window",
  "too many tokens", "reduce the length of the messages",
].join("|"), "i");

/** Is this provider error "what you sent does not fit"? */
export function isContextOverflowError(message) {
  return OVERFLOW.test(String(message || ""));
}

function marker({ tool, size }) {
  return (
    `[REMOVED FROM CONTEXT by pi-trmm-bridge: the ${tool} result was ${mb(size)} ` +
    `(~${approxTokens(size).toLocaleString("en-US")} tokens) and overflowed this model's ` +
    `context window, so the conversation could not continue. The full result is still in ` +
    `the transcript for the technician. Do NOT re-run the same broad call: narrow it (a ` +
    `filter, fewer days, one name), or use run_command_on_device with capture_as to keep ` +
    `large output out of context.]`
  );
}

/**
 * Tool-result entries whose contribution to the CURRENT context is over `minBytes`.
 * Biggest first. Empty array when there is nothing outrageous in there.
 */
export function oversizedEntries(session, { minBytes = DEFAULT_MIN_BYTES } = {}) {
  const sm = session?.sessionManager;
  if (!sm || typeof sm.buildSessionProjection !== "function") return [];
  let projection;
  try { projection = sm.buildSessionProjection(); } catch { return []; }
  const hits = [];
  for (const entry of projection?.entries || []) {
    const src = entry?.sourceEntry;
    if (!src || src.type !== "message" || src.message?.role !== "toolResult") continue;
    const size = (entry.messages || []).reduce((sum, m) => sum + bytes(m), 0);
    if (size < minBytes) continue;
    hits.push({ id: src.id, size, tool: src.message.toolName || src.message.name || "tool" });
  }
  return hits.sort((a, b) => b.size - a.size);
}

/** Total bytes the model is currently being sent (system prompt, summary, tail). */
export function contextBytes(session) {
  const sm = session?.sessionManager;
  if (!sm || typeof sm.buildSessionProjection !== "function") return 0;
  try {
    return (sm.buildSessionProjection().messages || []).reduce((sum, m) => sum + bytes(m), 0);
  } catch {
    return 0;
  }
}

/**
 * Replace every oversized tool result with a marker and refresh what the model will be
 * sent next turn.
 *
 * @returns {{trimmed: Array<{tool:string,size:number}>, freed: number, note: string}}
 *          `trimmed` empty means nothing qualified - say so rather than claiming a fix.
 */
export function trimOversized(session, { minBytes = DEFAULT_MIN_BYTES, log, key, sessionId, max = 5 } = {}) {
  const hits = oversizedEntries(session, { minBytes }).slice(0, max);
  if (!hits.length) return { trimmed: [], freed: 0, note: "" };
  const sm = session.sessionManager;
  const done = [];
  for (const hit of hits) {
    try {
      sm.appendContextEdit(hit.id, { content: [{ type: "text", text: marker(hit) }] });
      done.push(hit);
    } catch (e) {
      // An entry that is not on the active branch (or is not editable) is skipped, not
      // fatal: trimming two of three monsters still un-wedges the chat.
      log?.("context_trim_skip", key, sessionId, `${hit.tool}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  if (!done.length) return { trimmed: [], freed: 0, note: "" };
  // What the SDK's own recovery path does after a context edit (_refreshFinalizedContext):
  // the agent's in-memory message list IS the next request, so it has to be rebuilt from
  // the projection or the edit would only take effect after a reload.
  try {
    session.agent.state.messages = sm.buildSessionProjection().messages;
  } catch (e) {
    log?.("context_trim_refresh_failed", key, sessionId, String(e?.message || e).slice(0, 200));
  }
  const freed = done.reduce((sum, h) => sum + h.size, 0);
  const what = done.map((h) => `${h.tool} (${mb(h.size)})`).join(", ");
  log?.("context_trimmed", key, sessionId, `${what}; freed ~${approxTokens(freed).toLocaleString("en-US")} tokens`);
  return {
    trimmed: done,
    freed,
    note:
      `Dropped ${done.length === 1 ? "an oversized tool result" : `${done.length} oversized tool results`} ` +
      `from the AI's context: ${what}. That is ~${approxTokens(freed).toLocaleString("en-US")} tokens ` +
      `of one-off output that was too big for the model's window - the full text is still in this ` +
      `transcript, and the conversation itself is intact. You can carry on now.`,
  };
}
