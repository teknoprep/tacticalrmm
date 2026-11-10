// Generated-password digests across a restart, expiry, file modes, and the audit file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecretRegistry, digestOf } from "../src/secret-registry.js";
import { rememberGeneratedSecret, loadGeneratedSecrets } from "../src/generated-secrets.js";
import { auditReset } from "../src/reset-audit.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pw-digest-"));
const PW = "Qw7!rT2#kLp9vN4@hZ8x";

test("a typed copy is redacted by a fresh registry (restart) after the digest is reloaded", () => {
  const dir = tmp(); const file = path.join(dir, "generated-secrets.json");
  rememberGeneratedSecret({ registry: new SecretRegistry(), label: "generated password: u on A", value: PW, file });
  // a "restart": a new registry that knows only the file
  const after = new SecretRegistry();
  assert.equal(loadGeneratedSecrets({ registry: after, file }), 1);
  for (const t of [`${PW}`, `Password: ${PW}.`, `the new one is ${PW}, thanks`, `"${PW}"`, `${PW}!`]) {
    assert.doesNotMatch(after.redact(t), /Qw7!rT2/, `redacted: ${t}`);
  }
  assert.equal(after.redact("nothing secret here at all"), "nothing secret here at all");
});

test("the state file holds a digest, never the password", () => {
  const dir = tmp(); const file = path.join(dir, "generated-secrets.json");
  rememberGeneratedSecret({ registry: new SecretRegistry(), label: "x", value: PW, file });
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes(PW));
  assert.ok(raw.includes(digestOf(PW)));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("expired digests are pruned at load and do not match", () => {
  const dir = tmp(); const file = path.join(dir, "generated-secrets.json");
  const now = Date.parse("2026-11-10T00:00:00Z");
  rememberGeneratedSecret({ registry: new SecretRegistry(), label: "old", value: PW, file, ttlDays: 1, now });
  const reg = new SecretRegistry();
  assert.equal(loadGeneratedSecrets({ registry: reg, file, now: now + 2 * 86400000 }), 0);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 0, "expired entry removed from the file");
  assert.equal(reg.redact(`pw ${PW}`), `pw ${PW}`);
});

test("short or unrelated tokens never match a digest", () => {
  const reg = new SecretRegistry().addDigest("g", digestOf(PW));
  assert.equal(reg.redact("ok so the user is testuser on the host"), "ok so the user is testuser on the host");
  assert.equal(reg.redact(PW.slice(0, 10)), PW.slice(0, 10), "a partial value is not a token match");
});

test("a bad digest string is ignored", () => {
  const reg = new SecretRegistry().addDigest("g", "not-a-digest");
  assert.equal(reg.digests.size, 0);
});

test("audit lines are written 0600 and never contain the value", () => {
  const dir = tmp(); const file = path.join(dir, "audit", "password-resets.jsonl");
  const reg = new SecretRegistry(); reg.add("generated password", PW);
  auditReset({ actor_email: "t@x", agent_id: "A1", username: "u", reason: `pls ${PW}`, outcome: "set_shown" }, { file, registry: reg });
  auditReset({ actor_email: "t@x", agent_id: "A1", username: "u", outcome: "refused_approval" }, { file, registry: reg });
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes(PW));
  assert.equal(raw.trim().split("\n").length, 2);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(raw.split("\n")[0]).event, "password_reset");
});

test("anything written to disk is redacted (queue history, index, memory, outbox)", async () => {
  const { redactedJSON, SECRETS } = await import("../src/secret-store.js");
  const pw = "Zk4!mN8#pQ2vB6@tR9wY";
  SECRETS.add("typed", pw);
  const out = redactedJSON({ history: [{ text: `my login is ${pw}`, detail: "" }], nested: { a: [pw] } }, 2);
  assert.ok(!out.includes(pw));
  assert.match(out, /REDACTED/);
});
