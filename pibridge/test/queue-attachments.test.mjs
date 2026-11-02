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

test("a text file queued with a prompt is kept WHOLE in the sidecar and composed in at run time", async () => {
  // TICKET/63160: the composed prompt used to be stored and cut at QUEUE_MAX_TEXT (8000),
  // so a 150 KB HTML quote reached the model as its first few KB.
  const big = "<style>" + "x".repeat(150 * 1024) + "</style>";
  const block = `The technician attached 1 file(s). Their full contents follow between [[pi-attachment:...]] markers.\n\n[[pi-attachment:quote.html|${big.length}]]\n${big}\n[[/pi-attachment]]`;
  const { q, runs, root, frames } = mk({
    intake: () => ({ images: [], text: block, accepted: [{ name: "quote.html", kind: "text", bytes: big.length }], rejected: [] }),
  });
  await q.handle({ type: "queue_add", text: "build the quote template from this", attachments: [{ name: "quote.html" }] });
  const item = q.state().items[0];
  assert.equal(item.text, "build the quote template from this", "the item holds the words only");
  assert.equal(item.attach_text, true);
  assert.deepEqual(item.attachments, [{ name: "quote.html", kind: "text", bytes: big.length }]);
  const stateFile = path.join(root, "unit:att", "queue", "SESS.json");
  assert.ok(fs.readFileSync(stateFile, "utf8").length < 10000, "the body is not in the state file (or every queue_state frame)");
  assert.ok(!frames.filter((f) => f.type === "queue_state").some((f) => JSON.stringify(f).includes("xxxxxxxxxx")));
  await q.handle({ type: "queue_run_next" });
  assert.deepEqual(runs[0].images, []);
  assert.match(runs[0].text, /^build the quote template from this\n/);
  assert.ok(runs[0].text.includes(big), "the WHOLE file reaches the model");
  assert.ok(runs[0].text.endsWith("[[/pi-attachment]]"));
});

test("a prompt typed while busy keeps its file whole too (addTyped)", async () => {
  const { q, runs } = mk();
  const body = "y".repeat(20000);
  const id = q.addTyped(`look at this\n\nThe technician attached 1 file(s). Their full contents follow between [[pi-attachment:...]] markers.\n\n[[pi-attachment:a.html|20000]]\n${body}\n[[/pi-attachment]]`);
  const item = q.state().items.find((i) => i.id === id);
  assert.equal(item.text, "look at this");
  assert.deepEqual(item.attachments, [{ name: "a.html", kind: "text", bytes: 20000 }]);
  await q.advance("t");
  assert.ok(runs[0].text.includes(body));
  assert.match(runs[0].text, /^look at this/);
});

test("a typed chat prompt's panel item shows words and a chip, never the file body", () => {
  const { q } = mk();
  const html = "<!DOCTYPE html><html><head><style>" + "z".repeat(9000) + "</style></head></html>";
  q.beginTypedItem(`make the website\n\nThe technician attached 1 file(s). Their full contents follow between [[pi-attachment:...]] markers.\n\n[[pi-attachment:Quote.html|154024]]\n${html}\n[[/pi-attachment]]`, "browser");
  const item = q.state().items[0];
  assert.equal(item.text, "make the website");
  assert.deepEqual(item.attachments, [{ name: "Quote.html", kind: "text", bytes: 154024 }]);
  assert.ok(!JSON.stringify(q.state()).includes("DOCTYPE"));
});

test("an item saved by older code with a CUT-OFF file body still loads, words intact", async () => {
  const { splitPrompt } = await import("../src/queue.js");
  const sp = splitPrompt("hello\n\nThe technician attached 1 file(s). Their full contents follow between [[pi-attachment:...]] markers.\n\n[[pi-attachment:q.html|99]]\n<style>body{");
  assert.equal(sp.words.trim(), "hello");
  assert.deepEqual(sp.files, [{ name: "q.html", kind: "text", bytes: 99 }]);
});

test("queued images survive a bridge restart (sanitize keeps the sidecar fields)", async () => {
  const { q, root } = mk({
    intake: () => ({ images: [IMG], text: "", accepted: [{ name: "s.png", kind: "image", bytes: 3 }], rejected: [] }),
  });
  await q.handle({ type: "queue_add", text: "look", attachments: [{ name: "s.png" }] });
  const runs = [];
  const q2 = makePromptQueue({
    scopeKey: "unit:att", root, send: () => {}, log: () => {},
    runPrompt: async (text, images) => { runs.push({ text, images }); },
    compact: async () => {}, isStreaming: () => false,
  });
  q2.attach("SESS");
  assert.equal(q2.state().items[0].images, 1);
  assert.deepEqual(q2.state().items[0].attachments, [{ name: "s.png", kind: "image", bytes: 3 }]);
  await q2.handle({ type: "queue_run_next" });
  assert.deepEqual(runs[0].images, [IMG]);
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
