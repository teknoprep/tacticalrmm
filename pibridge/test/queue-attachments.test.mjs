// A prompt can be QUEUED WITH FILES: images ride to the model when that item runs, text
// files are inlined at add time, and a refused file is reported while the operator is
// still looking at the window (2026-09-16).
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makePromptQueue } from "../src/queue.js";

function mk({ intake } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qatt-"));
  const frames = [];
  const runs = [];
  const q = makePromptQueue({
    scopeKey: "unit:att", root,
    send: (f) => frames.push(f), log: () => {},
    runPrompt: async (text, images) => { runs.push({ text, images }); },
    compact: async () => {}, isStreaming: () => false,
    intake: intake || (() => ({ images: [], text: "", accepted: [], rejected: [] })),
    compose: (t, extra) => (extra ? `${t}\n${extra}` : t),
  });
  q.attach("SESS");
  return { q, frames, runs, root };
}

const IMG = { data: "aaaa", mime: "image/png" };

test("an image queued with a prompt reaches the model when the item runs", async () => {
  const { q, runs, root } = mk({
    intake: () => ({ images: [IMG], text: "", accepted: [{ name: "shot.png", kind: "image", bytes: 3 }], rejected: [] }),
  });
  await q.handle({ type: "queue_add", text: "what does this error say?", attachments: [{ name: "shot.png" }] });
  const item = q.state().items[0];
  assert.equal(item.images, 1, "the item records that it carries an image");
  assert.deepEqual(item.attachments, [{ name: "shot.png", kind: "image", bytes: 3 }]);
  // the payload is NOT in the state file (which is rewritten on every publish)
  const stateFile = path.join(root, "unit:att", "queue", "SESS.json");
  assert.ok(!fs.readFileSync(stateFile, "utf8").includes(IMG.data), "image bytes must not bloat the state file");
  await q.handle({ type: "queue_run_next" });
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].images, [IMG], "the image is handed over at run time");
  assert.match(runs[0].text, /what does this error say\?/);
});

test("a text file is inlined into the queued prompt at add time", async () => {
  const { q, runs } = mk({
    intake: () => ({ images: [], text: "[[pi-attachment:log.txt|9]]\nboom\n[[/pi-attachment]]",
                     accepted: [{ name: "log.txt", kind: "text", bytes: 9 }], rejected: [] }),
  });
  await q.handle({ type: "queue_add", text: "explain this log", attachments: [{ name: "log.txt" }] });
  assert.match(q.state().items[0].text, /pi-attachment:log\.txt/, "inlined immediately, no sidecar needed");
  assert.ok(!q.state().items[0].images);
  await q.handle({ type: "queue_run_next" });
  assert.deepEqual(runs[0].images, []);
});

test("a file with no words is refused OUT LOUD, not silently dropped", async () => {
  const { q, frames } = mk({
    intake: () => ({ images: [IMG], text: "", accepted: [{ name: "a.png", kind: "image", bytes: 3 }], rejected: [] }),
  });
  await q.handle({ type: "queue_add", text: "", attachments: [{ name: "a.png" }] });
  assert.equal(q.state().items.length, 0, "no mystery item is created");
  assert.ok(frames.some((f) => f.type === "error" && /a\.png/.test(f.message || "") && /needs words/.test(f.message)),
    "the operator is told what is missing, by file name");
});

test("removing an item deletes its stored images", async () => {
  const { q, root } = mk({
    intake: () => ({ images: [IMG], text: "", accepted: [{ name: "s.png", kind: "image", bytes: 3 }], rejected: [] }),
  });
  await q.handle({ type: "queue_add", text: "look", attachments: [{ name: "s.png" }] });
  const id = q.state().items[0].id;
  const side = path.join(root, "unit:att", "queue", "attachments", `SESS.${id}.json`);
  assert.ok(fs.existsSync(side), "sidecar written");
  await q.handle({ type: "queue_remove", id });
  assert.ok(!fs.existsSync(side), "sidecar cleaned up with the item");
});

test("an unreadable sidecar is announced, not silently ignored", async () => {
  const { q, frames, runs, root } = mk({
    intake: () => ({ images: [IMG], text: "", accepted: [{ name: "s.png", kind: "image", bytes: 3 }], rejected: [] }),
  });
  await q.handle({ type: "queue_add", text: "look at this", attachments: [{ name: "s.png" }] });
  const id = q.state().items[0].id;
  fs.unlinkSync(path.join(root, "unit:att", "queue", "attachments", `SESS.${id}.json`));
  await q.handle({ type: "queue_run_next" });
  assert.deepEqual(runs[0].images, [], "it still runs rather than failing the work");
  assert.ok(frames.some((f) => f.type === "error" && /could not be read back/.test(f.message || "")),
    "the operator is told the screenshot did not reach the model");
});
