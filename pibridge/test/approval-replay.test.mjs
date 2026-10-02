// A refresh must not eat a pending approval (TICKET/62044, 2026-09-30 11:06).
import test from "node:test";
import assert from "node:assert/strict";
import { makePendingApprovals } from "../src/live-hub.js";

test("pending approvals keep their question until answered, and replay it", () => {
  const p = makePendingApprovals();
  let answered = null;
  p.set("a1", (v) => { answered = v; });
  p.asks.set("a1", "Run a command that MODIFIES X");
  assert.deepEqual(p.replayFrames(), [{ type: "approval_request", id: "a1", summary: "Run a command that MODIFIES X" }]);
  const r = p.get("a1"); p.delete("a1"); r(true);
  assert.equal(answered, true);
  assert.deepEqual(p.replayFrames(), [], "answered = no longer replayed");
  p.set("a2", () => {}); p.asks.set("a2", "y"); p.clear();
  assert.deepEqual(p.replayFrames(), []);
});
