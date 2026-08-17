// Recover a turn that the provider rejected with an error string the harness does not
// recognise as retryable.
//
// WHAT WENT WRONG (2026-08-17, multi-machine PBX chat)
// ---------------------------------------------------
// A turn died with `Sorry, something went wrong.` and the technician was shown "The
// model returned no answer". It was a transient xAI fault: usage came back all zeros
// (so nothing was even processed - not a context overflow, the conversation was 57k
// tokens against a far larger window), and the identical conversation succeeded two
// minutes later untouched.
//
// It should never have reached the technician. The harness DOES auto-retry provider
// faults, but it decides what is retryable by matching the error TEXT against a fixed
// pattern list in pi-ai (`overloaded`, `429`, `500`, `503`, `timeout`, ...). xAI returns
// a bare apology with no status code in it, so `isRetryableAssistantError()` said false,
// no retry was attempted, and a recoverable blip became a dead turn mid-task.
//
// Patching that vendored regex was the obvious fix and the wrong one: `npm install`
// would silently revert it, and the next provider with its own phrasing would need
// another patch. So this classifies on the SHAPE of the failure rather than its wording:
//
//   an assistant message that ended in error, produced no content, and burned no
//   tokens, is a request the provider dropped before it started - and that is
//   retryable whatever words came back.
//
// Deliberately NOT retried:
//   - anything the harness already retried and gave up on (its budget is authoritative;
//     retrying past it just wastes the technician's time and money),
//   - aborts, which are somebody pressing stop,
//   - quota / billing / auth / context-overflow, which are permanent and where a retry
//     is pure cost with no chance of success,
//   - a turn that produced ANY content or burned ANY tokens: partial work means the
//     model really did run, and re-running from the transcript could duplicate a side
//     effect.
//
// The re-run itself uses the harness's own recipe (see AgentSession._prepareRetry):
// drop the trailing errored assistant message from agent state, keeping it in the
// session file for history, then `agent.continue()` - which resumes from the existing
// transcript. No synthetic user message, so the transcript the technician reads and the
// context the model sees are both untouched.

// STATUS CODE FIRST, WORDS SECOND.
//
// The first version of this file screened permanent failures with a word list, which is
// precisely the weakness it was written to fix - and it got caught by it immediately. A
// live test with a deliberately bad API key was retried three times, because the list said
// `invalid api key` and xAI says `Incorrect API key provided`. Two words for one meaning,
// and the retry could never have succeeded.
//
// HTTP status is structured, standard across providers, and says exactly this: 4xx means
// the REQUEST is wrong and sending it again changes nothing; 5xx means the SERVER failed
// and sending it again might work. The two 4xx exceptions are the ones that are really
// about timing rather than the request: 408 request timeout and 429 rate limited.
const CLIENT_ERROR_EXCEPTIONS = new Set([408, 429]);

/**
 * Pull an HTTP status out of a provider error string, only from shapes that actually
 * denote a status - so "maximum context length is 400000 tokens" is not read as a 400.
 */
function statusFrom(why) {
  const found = [];
  for (const re of [
    /\((\d{3})\)/g,                                  // "API error (400)"
    /\b(?:HTTP|status(?:\s*code)?|code)\s*[:=]?\s*(\d{3})\b/gi, // "HTTP 503", "status: 429"
    /^\s*(\d{3})\b/g,                                 // "429 Too Many Requests"
    /\berror\s+(\d{3})\b/gi,                          // "error 502"
  ]) {
    for (const m of String(why).matchAll(re)) {
      const n = Number(m[1]);
      if (n >= 400 && n <= 599) found.push(n);
    }
  }
  return found.length ? found : null;
}

/** Permanent by wording. Kept as a SECOND line of defence for providers that send no status. */
const PERMANENT = new RegExp([
  "insufficient_quota", "quota exceeded", "out of budget", "billing", "available balance",
  "usagelimiterror", "monthly usage limit",
  // Both spellings seen in the wild: OpenAI says "Incorrect API key provided", others
  // "invalid api key". Match the noun, not one vendor's adjective.
  "api.?key", "unauthorized", "unauthorised", "forbidden", "authentication",
  "context.?length", "context window", "too many tokens", "maximum context",
  "model.?not.?found", "does not exist", "unsupported", "invalid.?request",
].join("|"), "i");

/** Somebody pressed stop. Not a fault, and must never be retried. */
const ABORTED = /abort|cancel/i;

function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((part) => part?.type === "text" || part?.type === "thinking")
    .map((part) => String(part.text || part.thinking || ""))
    .join("")
    .trim();
}

function tokensUsed(message) {
  const u = message?.usage || {};
  return (
    Number(u.input || 0) + Number(u.output || 0) +
    Number(u.cacheRead || 0) + Number(u.cacheWrite || 0) + Number(u.reasoning || 0)
  );
}

/**
 * Is this the "provider dropped it on the floor" shape?
 * Content-free, token-free, ended in error, and not permanently broken.
 */
export function isBlankProviderFailure(message) {
  if (!message || message.role !== "assistant" || message.stopReason !== "error") return false;
  const why = String(message.errorMessage || "");
  if (!why) return false;
  if (ABORTED.test(why)) return false;
  // A 4xx is the provider telling us the request itself is wrong. Retrying it is asking
  // the same question again and paying for the same answer.
  const statuses = statusFrom(why);
  if (statuses && statuses.some((s) => s < 500 && !CLIENT_ERROR_EXCEPTIONS.has(s))) return false;
  if (PERMANENT.test(why)) return false;
  // Any real output means the model ran. Do not re-run work that partly happened.
  if (messageText(message)) return false;
  if (Array.isArray(message.content) && message.content.some((p) => p?.type === "toolCall")) return false;
  return tokensUsed(message) === 0;
}

/**
 * Per-turn recovery budget. One instance per chat session.
 *
 * @param maxAttempts  how many silent re-runs before the technician is told
 * @param baseDelayMs  exponential backoff base
 */
export function makeLlmRecovery({ log, key, sessionId, maxAttempts = 2, baseDelayMs = 1500 } = {}) {
  let armed = null;        // the errored message awaiting a re-run
  let attempts = 0;        // used within the current turn
  let harnessGaveUp = false;

  return {
    /** The harness tried its own retries and ran out. Its budget wins; stand down. */
    noteHarnessGaveUp() {
      harnessGaveUp = true;
    },

    /** A technician-visible turn is starting: reset the per-turn budget. */
    beginTurn() {
      armed = null;
      attempts = 0;
      harnessGaveUp = false;
    },

    /**
     * Offer a failed assistant message for recovery.
     * @returns true if this will be retried silently (so do NOT tell the technician yet)
     */
    consider(message) {
      if (harnessGaveUp) return false;
      if (attempts >= maxAttempts) return false;
      if (!isBlankProviderFailure(message)) return false;
      armed = message;
      return true;
    },

    get pending() {
      return !!armed;
    },

    /**
     * Re-run the turn from the existing transcript. Returns true when a re-run was
     * actually performed, so the caller can re-inspect the outcome.
     */
    async run(session) {
      if (!armed) return false;
      const why = String(armed.errorMessage || "");
      armed = null;
      attempts += 1;
      const delayMs = baseDelayMs * 2 ** (attempts - 1);
      log?.("llm_recover", key, sessionId,
        `attempt ${attempts}/${maxAttempts} after unrecognised provider error "${why.slice(0, 80)}" - waiting ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));

      // The harness's own recipe: the errored assistant message stays in the session
      // file (history is a record of what happened) but must leave the live state, or
      // continue() would be resuming from an assistant turn.
      try {
        const messages = session.agent?.state?.messages;
        if (Array.isArray(messages) && messages.length
            && messages[messages.length - 1]?.role === "assistant") {
          session.agent.state.messages = messages.slice(0, -1);
        }
      } catch (e) {
        log?.("llm_recover_error", key, sessionId, `could not trim state: ${String(e?.message || e).slice(0, 120)}`);
        return false;
      }

      try {
        await session.agent.continue();
        return true;
      } catch (e) {
        log?.("llm_recover_error", key, sessionId, `continue() failed: ${String(e?.message || e).slice(0, 200)}`);
        return false;
      }
    },

    /** Wording for the technician once recovery has genuinely run out. */
    exhaustedNote(why) {
      return attempts > 0
        ? `The model returned no answer - the provider rejected the request ${attempts + 1} times ` +
          `(${String(why).slice(0, 200)}). Your conversation is intact: send anything to pick up where it stopped.`
        : "";
    },
  };
}
