// A reconnect must not cost megabytes.
//
// The `ready` frame carried 2.55 MB on a real ticket. The heartbeat ping shares that
// socket, so it queued behind the payload, the client could not answer in time, and the
// server terminated a healthy connection - which made the browser reconnect and ship the
// 2.55 MB again. These tests are about the bound, and about not shipping bytes that
// cannot be rendered.
import { test } from "node:test";
import assert from "node:assert/strict";

import { boundTranscript } from "../src/transcript-bound.js";

const msg = (role, text) => ({ role, content: [{ type: "text", text }] });

test("a short conversation is passed through untouched", () => {
  const all = [msg("user", "hi"), msg("assistant", "hello")];
  assert.deepEqual(boundTranscript(all, 100000), all, "no marker, no copy, nothing to explain");
});

test("a long conversation keeps the RECENT end", () => {
  const all = Array.from({ length: 500 }, (_, i) => msg("user", `turn ${i} ${"x".repeat(500)}`));
  const out = boundTranscript(all, 50000);

  assert.ok(out.length < all.length, "it has to drop something");
  assert.equal(out.at(-1).content[0].text.startsWith("turn 499"), true,
    "the last thing said is the thing being looked at");
  assert.equal(out[0].role, "system", "and the gap is explained rather than silent");
  assert.match(out[0].content[0].text, /earlier messages are not shown/);
  assert.match(out[0].content[0].text, /still has them in context/,
    "a technician must not think the assistant forgot");
});

test("the bound is honoured in bytes, not in messages", () => {
  const all = Array.from({ length: 200 }, (_, i) => msg("user", "y".repeat(1000 + i)));
  const out = boundTranscript(all, 30000);
  const bytes = JSON.stringify(out).length;
  assert.ok(bytes < 30000 * 1.2, `expected ~30KB, got ${bytes}`);
});

test("one enormous message is still shown", () => {
  // Cutting to nothing would leave a blank window, which is worse than a big one.
  const out = boundTranscript([msg("user", "z".repeat(50000))], 1000);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "user");
});

test("a tool result whose call was cut off is dropped, not shipped blind", () => {
  // The browser matches a result to its call by id; an orphan renders as nothing, so
  // sending it spends the budget on something invisible.
  const all = [
    { role: "assistant", content: [{ type: "toolCall", id: "old", name: "run", arguments: {} }] },
    { role: "toolResult", toolCallId: "old", content: [{ type: "text", text: "A".repeat(20000) }] },
    { role: "assistant", content: [{ type: "toolCall", id: "new", name: "run", arguments: {} }] },
    { role: "toolResult", toolCallId: "new", content: [{ type: "text", text: "fresh" }] },
    msg("user", "and then?"),
  ];
  const out = boundTranscript(all, 3000);
  const ids = out.filter((m) => m.role === "toolResult").map((m) => m.toolCallId);
  assert.deepEqual(ids, ["new"], "the orphaned result must not be shipped");
  assert.ok(out.some((m) => m.role === "assistant"
    && m.content.some((c) => c.type === "toolCall" && c.id === "new")));
});

test("the real ticket that caused this fits in the budget", () => {
  // 699 messages / 2.55 MB, the shape that produced the disconnect loop.
  const all = [];
  for (let i = 0; i < 699; i++) {
    all.push(i % 3 === 1
      ? { role: "toolResult", toolCallId: `c${i}`, content: [{ type: "text", text: "R".repeat(8000) }] }
      : msg(i % 3 === 0 ? "assistant" : "user", "T".repeat(1200)));
  }
  const before = JSON.stringify(all).length;
  const after = JSON.stringify(boundTranscript(all)).length;
  assert.ok(before > 2_000_000, `fixture should be megabytes, was ${before}`);
  assert.ok(after < 750_000, `expected under the 700KB bound, got ${after}`);
});
