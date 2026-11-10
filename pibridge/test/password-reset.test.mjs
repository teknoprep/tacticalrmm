// reset_device_password: the generated value is shown to the driving technician only, is
// never in the command text, the model's result or the registry-visible output. Fake runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePassword, passwordResetTool, RESET_TEMPLATES, USERNAME_RE } from "../src/credential-command.js";
import { SECRETS } from "../src/secret-store.js";

const unhex = (h) => Buffer.from(h, "hex").toString("utf8");
const envOf = (opts) => Object.fromEntries(opts.env_vars.map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), unhex(kv.slice(i + 1))]; }));
const text = (r) => r.content[0].text;

test("generated passwords: 20 chars, every class present, unique", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const p = generatePassword();
    assert.equal(p.length, 20);
    assert.match(p, /[a-z]/); assert.match(p, /[A-Z]/); assert.match(p, /[0-9]/); assert.match(p, /[!@#%^*\-_=+]/);
    seen.add(p);
  }
  assert.equal(seen.size, 500);
});

test("command templates refer to the environment only, never to a value", () => {
  for (const t of Object.values(RESET_TEMPLATES)) {
    assert.match(t, /PI_PASS/); assert.match(t, /PI_USER/);
    assert.doesNotMatch(t, /Canary|password=|passwd\s+\S+\s+\S{6,}/);
  }
});

test("account names are restricted", () => {
  for (const ok of ["testuser", "svc.backup-1", "a_b"]) assert.ok(USERNAME_RE.test(ok), ok);
  for (const bad of ["", "a b", "x;rm -rf /", "a".repeat(33), "$(id)"]) assert.ok(!USERNAME_RE.test(bad), bad);
});

function harness({ allow = true, runOut = null, runErr = null, revealOk = true } = {}) {
  const calls = { run: [], reveal: [], gate: [] };
  const tool = passwordResetTool({
    deviceGate: async (s) => { calls.gate.push(s); return { ok: allow, reason: allow ? "" : "judge said no" }; },
    reveal: { available: () => revealOk, send: (f) => calls.reveal.push(f) },
    runScript: async (agent, opts) => {
      calls.run.push({ agent, opts });
      if (runErr) throw runErr;
      return runOut ?? "";
    },
    getScriptId: async () => 42,
  });
  return { tool, calls };
}

test("no technician driving the window: the reset does not start", async () => {
  const { tool, calls } = harness({ revealOk: false });
  const r = await tool.execute("id", { agent_id: "A1", shell: "bash", username: "testuser" });
  assert.match(text(r), /NOT STARTED/);
  assert.equal(calls.run.length, 0);
});

test("refused approval: nothing runs", async () => {
  const { tool, calls } = harness({ allow: false });
  const r = await tool.execute("id", { agent_id: "A1", shell: "bash", username: "testuser" });
  assert.match(text(r), /REFUSED/);
  assert.equal(calls.run.length, 0);
});

test("invalid account name is refused before anything runs", async () => {
  const { tool, calls } = harness();
  const r = await tool.execute("id", { agent_id: "A1", shell: "bash", username: "x;rm -rf /" });
  assert.match(text(r), /Refused/);
  assert.equal(calls.run.length, 0);
});

test("success: the value goes to the reveal channel only, never into the command text or the result", async () => {
  const { tool, calls } = harness({ runOut: "password set for testuser; it must be changed at the next login" });
  const r = await tool.execute("id", { agent_id: "A1", shell: "bash", username: "testuser", reason: "locked out" });
  assert.equal(calls.run.length, 1);
  const env = envOf(calls.run[0].opts);
  assert.equal(env.PI_CMD_HEX, RESET_TEMPLATES.bash, "the command is the fixed template");
  assert.equal(env.PI_USER_HEX, "testuser");
  const pw = env.PI_PASS_HEX;
  assert.equal(pw.length, 20, "the new password travels in PI_PASS (hex env)");
  assert.equal(calls.reveal.length, 1, "one reveal frame");
  assert.equal(calls.reveal[0].value, pw, "the technician's dialog gets the value");
  assert.equal(calls.reveal[0].username, "testuser");
  assert.ok(!text(r).includes(pw), "the model's result does not contain the value");
  assert.ok(!calls.gate[0].includes(pw), "the approval text does not contain the value");
  assert.equal(SECRETS.redact(`x ${pw} y`).includes(pw), false, "the value is registered for scrubbing");
});

test("failure: no reveal, and the value is not returned", async () => {
  const { tool, calls } = harness({ runOut: "chpasswd: user 'testuser' does not exist" });
  const r = await tool.execute("id", { agent_id: "A1", shell: "bash", username: "testuser" });
  const pw = envOf(calls.run[0].opts).PI_PASS_HEX;
  assert.equal(calls.reveal.length, 0);
  assert.match(text(r), /NOT set/);
  assert.ok(!text(r).includes(pw));
});
