// Secret registry: no registered value may reach the model, in any encoding, through any
// tool result or error. Canary values only - never a real credential.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SecretRegistry, wrapToolRedaction } from "../src/secret-registry.js";

const CANARY = 'Zq7!canary"pa\\ss#42';

test("raw value is replaced by its label", () => {
  const r = new SecretRegistry();
  r.add("notebook#86 Admin Pass", CANARY);
  assert.equal(r.redact(`the password is ${CANARY}, keep it`), "the password is [REDACTED:notebook#86 Admin Pass], keep it");
});

test("JSON-escaped form is caught (quotes and backslashes)", () => {
  const r = new SecretRegistry();
  r.add("L", CANARY);
  const jsonish = JSON.stringify({ pw: CANARY }); // {"pw":"...\"...\\..."}
  const out = r.redact(jsonish);
  assert.ok(!out.includes(JSON.stringify(CANARY).slice(1, -1)), "escaped form must be gone");
  assert.ok(out.includes("[REDACTED:L]"));
});

test("base64, base64url and URL-encoded forms are caught", () => {
  const r = new SecretRegistry();
  r.add("L", CANARY);
  const b64 = Buffer.from(CANARY).toString("base64");
  const b64url = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const url = encodeURIComponent(CANARY);
  for (const form of [b64, b64url, url]) {
    assert.ok(r.redact(`echo ${form}`).includes("[REDACTED:L]"), `form not caught: ${form}`);
  }
});

test("every occurrence is redacted, nested objects and arrays included", () => {
  const r = new SecretRegistry();
  r.add("L", CANARY);
  const out = r.redactDeep({ a: [CANARY, { b: `x ${CANARY} y ${CANARY}` }], n: 3 });
  assert.equal(JSON.stringify(out).includes(CANARY.slice(0, 6)), false);
  assert.equal(out.n, 3);
  assert.equal(out.a[1].b, "x [REDACTED:L] y [REDACTED:L]");
});

test("strings that were never registered pass through untouched", () => {
  const r = new SecretRegistry();
  r.add("L", CANARY);
  assert.equal(r.redact("ordinary output, no secrets here"), "ordinary output, no secrets here");
  assert.equal(r.redact(""), "");
  assert.equal(r.redact(undefined), undefined);
});

test("short values are not registered (too many false positives)", () => {
  const r = new SecretRegistry();
  assert.equal(r.add("L", "abc"), 0);
  assert.equal(r.redact("abc is common"), "abc is common");
});

test("overlapping secrets resolve to the longer one", () => {
  const r = new SecretRegistry();
  r.add("short", "Summer2026");
  r.add("long", "Summer2026!xyz");
  assert.equal(r.redact("pw=Summer2026!xyz"), "pw=[REDACTED:long]");
});

test("wrapped tool: returned text is redacted, shape is kept", async () => {
  const r = new SecretRegistry();
  r.add("L", CANARY);
  const tool = { name: "t", execute: async () => ({ content: [{ type: "text", text: `got ${CANARY}` }], details: {} }) };
  wrapToolRedaction(tool, r);
  const res = await tool.execute("id", {});
  assert.deepEqual(res.content, [{ type: "text", text: "got [REDACTED:L]" }]);
  assert.deepEqual(res.details, {});
});

test("wrapped tool: an error that echoes a secret is redacted too", async () => {
  const r = new SecretRegistry();
  r.add("L", CANARY);
  const tool = { name: "t", execute: async () => { throw new Error(`login failed for ${CANARY}`); } };
  wrapToolRedaction(tool, r);
  await assert.rejects(() => tool.execute("id", {}), (e) => {
    assert.equal(e.message, "login failed for [REDACTED:L]");
    return true;
  });
});

test("wrapping twice does not double-wrap", () => {
  const r = new SecretRegistry();
  const tool = { name: "t", execute: async () => ({}) };
  wrapToolRedaction(tool, r);
  const once = tool.execute;
  wrapToolRedaction(tool, r);
  assert.equal(tool.execute, once);
});

test("a value added later still protects output produced earlier in the session", () => {
  const r = new SecretRegistry();
  assert.equal(r.redact(`late ${CANARY}`), `late ${CANARY}`);
  r.add("L", CANARY);
  assert.equal(r.redact(`late ${CANARY}`), "late [REDACTED:L]");
});
