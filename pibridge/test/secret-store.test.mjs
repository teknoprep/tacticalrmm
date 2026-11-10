// Credential gate, registration and guards. Canary values only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SECRETS, registerNotebookSecrets, guardTool } from "../src/secret-store.js";

const PW = "Canary#9xQ2wpLM";

test("notebook read registers secret columns, not the visible ones", () => {
  const before = SECRETS.size;
  const n = registerNotebookSecrets({
    notebooks: [{ company: "Acme", columns: ["Info", "User", "Admin Pass"], rows: [["fw", "admin", PW]] }],
  });
  assert.ok(n > 0, "the password column is registered");
  assert.ok(SECRETS.size > before);
  assert.equal(SECRETS.redact(`login admin pass ${PW}`), "login admin pass [REDACTED:Acme / fw / Admin Pass]");
  assert.equal(SECRETS.redact("admin"), "admin", "usernames are not secrets and are not registered");
});

test("a tool whose input carries a registered value is refused and not executed", async () => {
  let ran = false;
  const tool = { name: "send_email", execute: async () => { ran = true; return { content: [{ type: "text", text: "sent" }], details: {} }; } };
  guardTool(tool);
  const res = await tool.execute("id", { body: `here is the password ${PW}` });
  assert.equal(ran, false);
  assert.match(res.content[0].text, /^BLOCKED/);
});

test("the same value in base64 inside the input is also refused", async () => {
  let ran = false;
  const tool = { name: "run", execute: async () => { ran = true; return { content: [{ type: "text", text: "" }], details: {} }; } };
  guardTool(tool);
  await tool.execute("id", { command: `echo ${Buffer.from(PW).toString("base64")} | base64 -d` });
  assert.equal(ran, false);
});

test("clean input passes through and its output is redacted", async () => {
  const tool = { name: "t", execute: async () => ({ content: [{ type: "text", text: `device printed ${PW}` }], details: {} }) };
  guardTool(tool);
  const res = await tool.execute("id", { command: "hostname" });
  assert.match(res.content[0].text, /\[REDACTED:Acme/);
  assert.ok(!res.content[0].text.includes(PW));
});

test("a label is not a secret value: naming a credential is allowed", async () => {
  let ran = false;
  const tool = { name: "run_device_command_with_credential", execute: async () => { ran = true; return { content: [{ type: "text", text: "ok" }], details: {} }; } };
  guardTool(tool);
  await tool.execute("id", { company: "Acme", label: "fw" });
  assert.equal(ran, true);
});
