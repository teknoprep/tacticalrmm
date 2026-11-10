// reset_device_password: the generated value goes to the driving technician only. It is never
// in the command text, the model's result, the approval text or the audit trail. Fake runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePassword, passwordResetTool, RESET_TEMPLATES, USERNAME_RE } from "../src/credential-command.js";
import { SECRETS } from "../src/secret-store.js";

const unhex = (h) => Buffer.from(h, "hex").toString("utf8");
const envOf = (opts) => Object.fromEntries(opts.env_vars.map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), unhex(kv.slice(i + 1))]; }));
const text = (r) => r.content[0].text;

test("generated passwords: 20 chars, every class present, unique, no ':' or '='", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const p = generatePassword();
    assert.equal(p.length, 20);
    assert.match(p, /[a-z]/); assert.match(p, /[A-Z]/); assert.match(p, /[0-9]/); assert.match(p, /[!@#%^*\-_+]/);
    assert.doesNotMatch(p, /[:=]/);
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

function harness({ allow = true, runOut = null, runErr = null, driving = [true], afterApproval = null } = {}) {
  const calls = { run: [], reveal: [], gate: [], audit: [], persist: [] };
  let i = 0;
  // driving: a list of answers to successive available() checks; the last one repeats.
  const available = () => driving[Math.min(i++, driving.length - 1)];
  const tool = passwordResetTool({
    actor: { email: "tech@blueuc.com", name: "Tech One" },
    deviceGate: async (s) => {
      calls.gate.push(s);
      if (afterApproval) afterApproval();
      return { ok: allow, reason: allow ? "" : "judge said no" };
    },
    reveal: { available, send: (f) => calls.reveal.push(f) },
    runScript: async (agent, opts) => {
      calls.run.push({ agent, opts });
      if (runErr) throw runErr;
      return runOut ?? "";
    },
    getScriptId: async () => 42,
    persist: (a) => { calls.persist.push(a); return "digest"; },
    audit: (e) => calls.audit.push(e),
  });
  return { tool, calls };
}

test("no technician driving the window: the reset does not start", async () => {
  const { tool, calls } = harness({ driving: [false] });
  const r = await tool.execute("id", { agent_id: "A1", shell: "bash", username: "testuser" });
  assert.match(text(r), /NOT STARTED/);
  assert.equal(calls.run.length, 0);
  assert.equal(calls.audit[0].outcome, "refused_no_technician");
});

test("technician leaves during approval: nothing is set", async () => {
  const { tool, calls } = harness({ driving: [true, false] });
  const r = await tool.execute("id", { agent_id: "A1", shell: "bash", username: "testuser" });
  assert.match(text(r), /left before the reset ran/);
  assert.equal(calls.run.length, 0, "no password is generated or set");
  assert.equal(calls.persist.length, 0);
  assert.equal(calls.audit.at(-1).outcome, "refused_no_technician_after_approval");
});

test("refused approval: nothing runs, and the refusal is audited with the judge's reason", async () => {
  const { tool, calls } = harness({ allow: false });
  const r = await tool.execute("id", { agent_id: "A1", shell: "bash", username: "testuser" });
  assert.match(text(r), /REFUSED/);
  assert.equal(calls.run.length, 0);
  assert.equal(calls.audit[0].outcome, "refused_approval");
});

test("invalid account name is refused before anything runs", async () => {
  const { tool, calls } = harness();
  const r = await tool.execute("id", { agent_id: "A1", shell: "bash", username: "x;rm -rf /" });
  assert.match(text(r), /Refused/);
  assert.equal(calls.run.length, 0);
  assert.equal(calls.audit[0].outcome, "refused_invalid_name");
});

test("success: value to the reveal channel only; digest persisted; audited without the value", async () => {
  const { tool, calls } = harness({ runOut: "password set for testuser; it must be changed at the next login" });
  const r = await tool.execute("id", { agent_id: "A1", shell: "bash", username: "testuser", reason: "locked out" });
  assert.equal(calls.run.length, 1);
  const env = envOf(calls.run[0].opts);
  assert.equal(env.PI_CMD_HEX, RESET_TEMPLATES.bash, "the command is the fixed template");
  assert.equal(env.PI_USER_HEX, "testuser");
  const pw = env.PI_PASS_HEX;
  assert.equal(pw.length, 20, "the new password travels in PI_PASS (hex env)");
  assert.equal(calls.reveal.length, 1);
  assert.equal(calls.reveal[0].value, pw, "the technician's dialog gets the value");
  assert.ok(!text(r).includes(pw), "the model's result does not contain the value");
  assert.ok(!calls.gate[0].includes(pw), "the approval text does not contain the value");
  assert.equal(calls.persist.length, 1, "a digest is persisted for restarts");
  assert.equal(calls.persist[0].value, pw);
  assert.equal(SECRETS.redact(`x ${pw} y`).includes(pw), false, "the value is registered for scrubbing");
  const a = calls.audit.at(-1);
  assert.equal(a.outcome, "set_shown");
  assert.equal(a.actor_email, "tech@blueuc.com");
  assert.equal(a.username, "testuser");
  assert.ok(!JSON.stringify(calls.audit).includes(pw), "the audit trail never holds the value");
});

test("technician leaves between the run and the reveal: set_not_shown is audited, value not shown", async () => {
  const { tool, calls } = harness({ runOut: "password set for testuser", driving: [true, true, false] });
  const r = await tool.execute("id", { agent_id: "A1", shell: "bash", username: "testuser" });
  assert.equal(calls.reveal.length, 0);
  assert.match(text(r), /no technician is driving/);
  assert.equal(calls.audit.at(-1).outcome, "set_not_shown");
});

test("failure: no reveal, the value is not returned, outcome is unconfirmed", async () => {
  const { tool, calls } = harness({ runOut: "chpasswd: user 'testuser' does not exist" });
  const r = await tool.execute("id", { agent_id: "A1", shell: "bash", username: "testuser" });
  const pw = envOf(calls.run[0].opts).PI_PASS_HEX;
  assert.equal(calls.reveal.length, 0);
  assert.match(text(r), /NOT confirmed/);
  assert.ok(!text(r).includes(pw));
  assert.equal(calls.audit.at(-1).outcome, "unconfirmed");
});

test("transport error: outcome is failed_run and the value is not returned", async () => {
  const { tool, calls } = harness({ runErr: new Error("nats timeout") });
  const r = await tool.execute("id", { agent_id: "A1", shell: "bash", username: "testuser" });
  const pw = envOf(calls.run[0].opts).PI_PASS_HEX;
  assert.match(text(r), /may or may not have changed/);
  assert.ok(!text(r).includes(pw));
  assert.equal(calls.audit.at(-1).outcome, "failed_run");
});
