// Is the model still there, or has the stream died?
//
// THE MEASUREMENT THAT WAS MISSING (2026-08-18)
// --------------------------------------------
// The turn watchdog used to answer that question by timing the gap between *parsed agent
// events* and calling anything over 3 minutes dead. It was wrong, and it killed working
// turns: asked for a large email, grok-4.5 emits nothing parseable for ~200s while it
// assembles one big tool argument, then delivers it complete.
//
// Measuring the actual wire says something completely different. Captured from
// api.x.ai during exactly that kind of turn:
//
//     t= 16414ms  gap=15001ms   13B  RAW=": keepalive\n\n"
//     t= 31416ms  gap=15002ms   13B  RAW=": keepalive\n\n"
//     ...            (17 more, metronomic, through a 255s turn)
//     LONGEST GAP 15003ms
//
// The provider sends an SSE heartbeat every 15 seconds and never goes quiet. The stream
// was never silent - only the *parser output* was. `: keepalive` is an SSE comment, and
// per the spec every conformant parser (including the one under pi-ai) discards comments,
// so nothing reached the agent event stream and the watchdog saw a flat line.
//
// So liveness is directly observable and does not need a guess: read it off the socket.
// A stream with bytes arriving is alive no matter how long the model has been thinking; a
// stream with NO bytes for several missed heartbeats is genuinely dead, and can be
// declared so in ~1 minute instead of 3 - faster AND without false positives.
//
// HOW THE BYTES ARE OBSERVED
// --------------------------
// pi-ai owns the HTTP call, and the coding-agent above it exposes no hook for the
// response body. Patching either is out (`npm install` silently reverts a patched
// node_modules - the mistake llm-recovery.js was written to avoid). pi-ai does fall back
// to `globalThis.fetch`, so this installs one transparent pass-through wrapper there,
// tees the byte counts, and hands the body on untouched.
//
// Concurrent turns share the process, so bytes are attributed with AsyncLocalStorage: the
// store is captured SYNCHRONOUSLY inside the wrapper, at the moment the request is made,
// while still on the calling turn's async context. Reading it later from inside a stream
// callback would be unreliable.
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

/** Provider endpoints whose response bodies are worth measuring. */
export const PROVIDER_HOSTS =
  /(^|\/\/|\.)(api\.x\.ai|api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|openrouter\.ai|api\.mistral\.ai)/i;

/**
 * Per-turn liveness tracker. One per turn; handed to `runWithLiveness`.
 */
export function makeTurnLiveness({ now = Date.now } = {}) {
  let bytes = 0;
  let chunks = 0;
  let lastByteAt = 0;      // 0 = nothing has ever arrived on this turn
  let openStreams = 0;
  let startedAt = now();

  return {
    onOpen() { openStreams += 1; lastByteAt = now(); },
    onBytes(n) { bytes += n; chunks += 1; lastByteAt = now(); },
    onClose() { openStreams = Math.max(0, openStreams - 1); },

    /** Restart the measurement for a new turn on the same connection. */
    reset() { bytes = 0; chunks = 0; lastByteAt = 0; openStreams = 0; startedAt = now(); },

    /** Have we ever seen a byte on this turn? If not, callers must not trust liveness. */
    get observed() { return lastByteAt > 0; },
    get bytes() { return bytes; },
    get chunks() { return chunks; },
    get openStreams() { return openStreams; },
    get lastByteAt() { return lastByteAt; },
    /** Milliseconds since the last byte from the provider, or null if never observed. */
    quietMs() { return lastByteAt ? now() - lastByteAt : null; },
    elapsedMs() { return now() - startedAt; },
  };
}

/** Run `fn` with `tracker` as the ambient liveness sink for any provider call it makes. */
export function runWithLiveness(tracker, fn) {
  return als.run(tracker, fn);
}

/**
 * Install the pass-through fetch wrapper. Idempotent; returns an uninstall function.
 *
 * Deliberately minimal: it must be impossible for this to change what the caller sees.
 * The body is piped, never buffered; the status, headers and url are carried across; a
 * non-provider or body-less response is returned exactly as received.
 */
export function installStreamLiveness({ hosts = PROVIDER_HOSTS, log } = {}) {
  const orig = globalThis.fetch;
  if (!orig) throw new Error("no global fetch to wrap");
  if (orig.__piLivenessWrapped) return () => {};

  const wrapped = async function fetch(input, init) {
    // Captured HERE, synchronously, on the calling turn's async context.
    const store = als.getStore();
    const res = await orig(input, init);
    if (!store || !res.body) return res;

    let url = "";
    try { url = typeof input === "string" ? input : input?.url || String(input?.href || input || ""); } catch { /* opaque input */ }
    if (!hosts.test(url)) return res;

    try {
      store.onOpen();
      const meter = new TransformStream({
        transform(chunk, ctrl) {
          try { store.onBytes(chunk?.byteLength ?? chunk?.length ?? 0); } catch { /* never break the stream */ }
          ctrl.enqueue(chunk);
        },
        flush() { try { store.onClose(); } catch { /* ignore */ } },
      });
      const out = new Response(res.body.pipeThrough(meter), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
      // `Response.url` is read-only and not carried by the constructor; some SDKs read it.
      try { Object.defineProperty(out, "url", { value: res.url, configurable: true }); } catch { /* ignore */ }
      return out;
    } catch (e) {
      // Measurement must never cost us the response.
      log?.("liveness_wrap_error", String(e?.message || e).slice(0, 200));
      try { store.onClose(); } catch { /* ignore */ }
      return res;
    }
  };

  wrapped.__piLivenessWrapped = true;
  globalThis.fetch = wrapped;
  return () => { globalThis.fetch = orig; };
}
