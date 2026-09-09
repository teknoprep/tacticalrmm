// A prompt sent the moment the window says it is ready must still be answered.
//
// `ready` goes out early; the frame handler is attached after the tool belt, the cost
// meter and the watchdog exist. The browser enables its input on `ready` and AI Resolve
// fires its seed prompt on `ready`, so frames legitimately arrive in that gap - and with
// no listener attached, a WebSocket simply discards them. That is a prompt lost with no
// error, no log line and a spinner left running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { bufferEarlyFrames } from "../src/early-frames.js";

/** The parts of a ws socket this touches. */
const socket = () => {
  const ee = new EventEmitter();
  return { on: ee.on.bind(ee), off: ee.off.bind(ee), emit: ee.emit.bind(ee),
           listeners: () => ee.listenerCount("message") };
};

test("a frame sent before the handler exists is replayed, not lost", async () => {
  const ws = socket();
  const handOff = bufferEarlyFrames(ws);
  ws.emit("message", "typed-immediately");           // the gap
  const seen = [];
  handOff(async (raw) => { seen.push(raw); });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ["typed-immediately"]);
});

test("order is preserved - a queued prompt cannot overtake the one before it", async () => {
  const ws = socket();
  const handOff = bufferEarlyFrames(ws);
  ws.emit("message", "one");
  ws.emit("message", "two");
  ws.emit("message", "three");
  const seen = [];
  handOff(async (raw) => {
    // Deliberately slow and uneven, the way a real turn is.
    await new Promise((r) => setTimeout(r, raw === "one" ? 15 : 1));
    seen.push(raw);
  });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(seen, ["one", "two", "three"]);
});

test("frames after the hand-off go straight to the handler", async () => {
  const ws = socket();
  const handOff = bufferEarlyFrames(ws);
  const seen = [];
  handOff(async (raw) => { seen.push(raw); });
  ws.emit("message", "later");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ["later"]);
});

test("the buffer stops listening once it has handed over", async () => {
  const ws = socket();
  const handOff = bufferEarlyFrames(ws);
  assert.equal(ws.listeners(), 1, "buffering from the moment the socket exists");
  handOff(async () => {});
  assert.equal(ws.listeners(), 1, "the buffer is gone, the handler is on");
});

test("one bad early frame does not swallow the frames behind it", async () => {
  const ws = socket();
  const handOff = bufferEarlyFrames(ws);
  ws.emit("message", "boom");
  ws.emit("message", "good");
  const seen = [];
  handOff(async (raw) => {
    if (raw === "boom") throw new Error("the handler reports this itself");
    seen.push(raw);
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, ["good"]);
});

test("nothing sent early means nothing replayed", async () => {
  const ws = socket();
  const handOff = bufferEarlyFrames(ws);
  const seen = [];
  handOff(async (raw) => { seen.push(raw); });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, []);
});
