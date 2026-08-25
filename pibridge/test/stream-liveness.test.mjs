import test from "node:test";
import assert from "node:assert/strict";
import {
  installStreamLiveness, makeTurnLiveness, runWithLiveness, PROVIDER_HOSTS,
} from "../src/stream-liveness.js";

// Measured from api.x.ai on 2026-08-18: an SSE comment, 13 bytes, every 15.000s for the
// whole turn. The SSE spec says parsers drop comments - which is exactly how a live
// stream came to look dead to the old watchdog.
const KEEPALIVE = new TextEncoder().encode(": keepalive\n\n");

function streamOf(chunks, { delayMs = 0 } = {}) {
  return new ReadableStream({
    async start(ctrl) {
      for (const c of chunks) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        ctrl.enqueue(c);
      }
      ctrl.close();
    },
  });
}

/** Install the wrapper over a stub fetch, run `fn`, always restore. */
async function withFetch(stub, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  const uninstall = installStreamLiveness({});
  try { return await fn(); } finally { uninstall(); globalThis.fetch = real; }
}

test("the keepalive the parser throws away is counted as liveness", async () => {
  const live = makeTurnLiveness();
  await withFetch(
    async () => new Response(streamOf([KEEPALIVE, KEEPALIVE, KEEPALIVE])),
    () => runWithLiveness(live, async () => {
      const res = await fetch("https://api.x.ai/v1/responses");
      await res.text();
    }),
  );
  assert.equal(live.observed, true, "a live stream must be observable");
  assert.equal(live.chunks, 3);
  assert.equal(live.bytes, KEEPALIVE.length * 3);
  assert.ok(live.quietMs() < 1000);
});

test("the body is passed through byte-for-byte", async () => {
  const payload = 'event: response.completed\ndata: {"ok":true}\n\n';
  const live = makeTurnLiveness();
  const got = await withFetch(
    async () => new Response(streamOf([new TextEncoder().encode(payload)])),
    () => runWithLiveness(live, async () => (await fetch("https://api.x.ai/v1/responses")).text()),
  );
  assert.equal(got, payload, "measuring must not alter what the SDK reads");
});

test("status, headers and url survive the wrapper", async () => {
  const live = makeTurnLiveness();
  const res = await withFetch(
    async () => new Response(streamOf([KEEPALIVE]), {
      status: 201, statusText: "Created", headers: { "x-request-id": "abc123" },
    }),
    () => runWithLiveness(live, () => fetch("https://api.x.ai/v1/responses")),
  );
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("x-request-id"), "abc123");
  await res.text();
});

test("non-provider hosts are left completely alone", async () => {
  const live = makeTurnLiveness();
  await withFetch(
    async () => new Response(streamOf([KEEPALIVE])),
    () => runWithLiveness(live, async () => {
      await (await fetch("http://127.0.0.1:8080/api/agents/")).text();
    }),
  );
  assert.equal(live.observed, false, "TRMM traffic is not model liveness");
});

test("a call outside any turn context is passed straight through", async () => {
  const body = await withFetch(
    async () => new Response(streamOf([KEEPALIVE])),
    async () => (await fetch("https://api.x.ai/v1/responses")).text(),
  );
  assert.equal(body, ": keepalive\n\n");
});

test("bytes are attributed to the right concurrent turn", async () => {
  // Two chats share the process; one is busy, one is idle. The idle one must not be
  // credited with the busy one's liveness, or a genuinely dead turn looks healthy.
  const busy = makeTurnLiveness();
  const idle = makeTurnLiveness();
  await withFetch(
    async () => new Response(streamOf([KEEPALIVE, KEEPALIVE])),
    async () => {
      await runWithLiveness(busy, async () => {
        await (await fetch("https://api.x.ai/v1/responses")).text();
      });
    },
  );
  assert.equal(busy.observed, true);
  assert.equal(idle.observed, false, "liveness must not leak between sessions");
});

test("reset starts a clean measurement for the next turn", async () => {
  const live = makeTurnLiveness();
  await withFetch(
    async () => new Response(streamOf([KEEPALIVE])),
    () => runWithLiveness(live, async () => { await (await fetch("https://api.x.ai/v1/responses")).text(); }),
  );
  assert.equal(live.observed, true);
  live.reset();
  assert.equal(live.observed, false, "a new turn has not been measured yet");
  assert.equal(live.bytes, 0);
  assert.equal(live.quietMs(), null, "null means 'no signal', not 'silent'");
});

test("a stream error still reaches the caller", async () => {
  const live = makeTurnLiveness();
  const failing = new ReadableStream({
    start(ctrl) { ctrl.enqueue(KEEPALIVE); ctrl.error(new Error("socket hang up")); },
  });
  await withFetch(
    async () => new Response(failing),
    () => runWithLiveness(live, async () => {
      await assert.rejects(async () => { await (await fetch("https://api.x.ai/v1/responses")).text(); });
    }),
  );
  assert.equal(live.observed, true, "the bytes that did arrive still counted");
});

test("installing twice does not double-wrap", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response("x");
  const un1 = installStreamLiveness({});
  const wrapped = globalThis.fetch;
  const un2 = installStreamLiveness({});
  assert.equal(globalThis.fetch, wrapped, "second install is a no-op");
  un2(); un1();
  globalThis.fetch = real;
});

test("provider host matching covers the providers actually in use", () => {
  for (const u of [
    "https://api.x.ai/v1/responses",
    "https://api.anthropic.com/v1/messages",
    "https://api.openai.com/v1/responses",
    "https://openrouter.ai/api/v1/chat/completions",
  ]) assert.equal(PROVIDER_HOSTS.test(u), true, u);
  for (const u of [
    "http://127.0.0.1:8080/api/agents/",
    "https://rmm.blueuc.com/pichat/abc",
    "http://127.0.0.1:6379/",
  ]) assert.equal(PROVIDER_HOSTS.test(u), false, u);
});
