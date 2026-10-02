// Lazy capabilities (context trim, 2026-09-27). Tools a ticket rarely needs start hidden
// and load_capability turns them on mid-run. These tests drive a REAL pi agent session with
// the faux provider, so they check what the MODEL actually receives on each call - not just
// what our module believes it did.
import test from "node:test";
import assert from "node:assert/strict";
import { defineTool, createAgentSession, SessionManager, DefaultResourceLoader, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { Type } from "typebox";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { makeLazyCapabilities, TICKET_CHAT_UNADVERTISED, TOTP_OP_RE } from "../src/lazy-capabilities.js";

const txt = (s) => ({ content: [{ type: "text", text: s }], details: {} });
const mk = (name, run = () => txt(`${name} ran`)) => defineTool({
  name, label: name, description: `${name} tool`, parameters: Type.Object({}, { additionalProperties: true }),
  execute: async (_id, p) => run(p),
});

async function harness({ steps, capabilities, seedMessages = null }) {
  const core = createFauxCore({ api: "faux-lazy", provider: "fauxlazy", models: [{ id: "m1", contextWindow: 100000, maxTokens: 1000 }] });
  const seen = [];
  // The provider receives tool declarations as toolsAdded/toolsRemoved on system messages in
  // the transcript. Replay them: that is exactly the tool list the model sees on this call.
  const declared = (ctx) => {
    const cur = new Set((ctx.tools || []).map((t) => t.name));
    for (const m of ctx.messages || []) {
      for (const t of m.toolsAdded || []) cur.add(t.name);
      for (const t of m.toolsRemoved || []) cur.delete(typeof t === "string" ? t : t.name);
    }
    return [...cur].sort();
  };
  core.setResponses(steps.map((s) => (ctx) => { seen.push(declared(ctx)); return s(ctx); }));
  const rt = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  rt.registerProvider("fauxlazy", {
    api: "faux-lazy", apiKey: "x", baseUrl: "http://faux.invalid", streamSimple: core.streamSimple,
    models: [{ id: "m1", name: "m1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
  });
  const hd = mk("helpdesk_call", (p) => txt(`op ${p.operation} ok`));
  const base = [hd, mk("run_device_command"), mk("operator_desktop_observe"), mk("operator_desktop_click"), mk("save_procedure"), mk("sales_call")];
  const lazy = makeLazyCapabilities({ capabilities: capabilities(base) });
  const tools = [...base, lazy.tool];
  lazy.wrapHelpdeskCall(hd);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lazy-"));
  const loader = new DefaultResourceLoader({ agentDir: dir, cwd: dir, systemPromptOverride: () => "SYSTEM PROMPT UNDER TEST" });
  await loader.reload();
  const sm = SessionManager.inMemory();
  const { session } = await createAgentSession({
    model: rt.getModel("fauxlazy", "m1"), modelRuntime: rt, noTools: "builtin", customTools: tools,
    resourceLoader: loader, sessionManager: sm, agentDir: dir, cwd: dir,
  });
  if (seedMessages) for (const m of seedMessages) session.agent.state.messages.push(m);
  lazy.attach(session);
  return { session, lazy, seen, core };
}

const CAPS = (base) => ({
  desktop: { summary: "drive the desktop", tools: base.filter((t) => t.name.startsWith("operator_")), instructions: "DESKTOP RULES" },
  totp: { summary: "codes", requires: ["desktop"], ops: ["get_totp_code"], instructions: "TOTP RULES" },
  procedure: { summary: "save procedures", tools: base.filter((t) => t.name === "save_procedure") },
  sales: { summary: "quotes", tools: base.filter((t) => t.name === "sales_call"), instructions: "SALES RULES" },
});

test("hidden tools are not sent to the model until loaded, then arrive on the NEXT call of the same run", async () => {
  const { session, seen } = await harness({
    capabilities: CAPS,
    steps: [
      () => fauxAssistantMessage(fauxToolCall("load_capability", { name: "desktop" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxToolCall("operator_desktop_observe", {}), { stopReason: "toolUse" }),
      () => fauxAssistantMessage("done"),
    ],
  });
  await session.prompt("go");
  assert.ok(!seen[0].includes("operator_desktop_observe"), "operator tools hidden on the first call");
  assert.ok(!seen[0].includes("save_procedure") && !seen[0].includes("sales_call"), "procedure + sales hidden");
  assert.ok(seen[0].includes("load_capability") && seen[0].includes("run_device_command") && seen[0].includes("helpdesk_call"));
  assert.ok(seen[1].includes("operator_desktop_observe") && seen[1].includes("operator_desktop_click"), "loaded mid-run");
  assert.ok(!seen[1].includes("sales_call"), "loading one capability does not load the others");
  const results = session.messages.filter((m) => m.role === "toolResult").map((m) => m.content.map((c) => c.text).join(""));
  assert.match(results[0], /CAPABILITY "desktop" is ON[\s\S]*DESKTOP RULES/);
  assert.equal(results[1], "operator_desktop_observe ran", "the loaded tool actually executes");
});

test("the system prompt does not change when a capability loads (cache prefix stays valid)", async () => {
  const { session } = await harness({
    capabilities: CAPS,
    steps: [
      () => fauxAssistantMessage(fauxToolCall("load_capability", { name: "sales" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage("ok"),
    ],
  });
  const before = session.systemPrompt;
  await session.prompt("go");
  assert.equal(session.systemPrompt, before);
  assert.ok(!before.includes("SALES RULES"));
});

test("requires: loading totp also loads desktop", async () => {
  const { lazy, session } = await harness({ capabilities: CAPS, steps: [] });
  const out = lazy.enable("totp");
  assert.ok(lazy.isLoaded("desktop") && lazy.isLoaded("totp"));
  assert.match(out, /DESKTOP RULES[\s\S]*TOTP RULES/);
  assert.ok(session.getActiveToolNames().includes("operator_desktop_click"));
});

test("a helpdesk op owned by a capability auto-loads it and prepends the rules to that result", async () => {
  const { session, seen } = await harness({
    capabilities: CAPS,
    steps: [
      () => fauxAssistantMessage(fauxToolCall("helpdesk_call", { operation: "get_totp_code" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxToolCall("helpdesk_call", { operation: "get_totp_code" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage("ok"),
    ],
  });
  await session.prompt("go");
  const results = session.messages.filter((m) => m.role === "toolResult").map((m) => m.content.map((c) => c.text).join("\n"));
  assert.match(results[0], /TOTP RULES[\s\S]*--- get_totp_code result ---[\s\S]*op get_totp_code ok/);
  assert.equal(results[1], "op get_totp_code ok", "rules are only prepended the first time");
  assert.ok(seen[1].includes("operator_desktop_observe"), "totp requires desktop, so its tools arrived too");
});

test("ordinary helpdesk ops are untouched", async () => {
  const { session } = await harness({
    capabilities: CAPS,
    steps: [() => fauxAssistantMessage(fauxToolCall("helpdesk_call", { operation: "get_ticket" }), { stopReason: "toolUse" }), () => fauxAssistantMessage("ok")],
  });
  await session.prompt("go");
  const r = session.messages.find((m) => m.role === "toolResult").content.map((c) => c.text).join("");
  assert.equal(r, "op get_ticket ok");
});

test("resuming a chat that already used the desktop brings the desktop back (no tools vanish mid-job)", async () => {
  const seed = [
    { role: "user", content: "earlier", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "operator_desktop_click", arguments: {} }], stopReason: "toolUse", timestamp: 2,
      api: "faux-lazy", provider: "fauxlazy", model: "m1", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
  ];
  const { lazy, session } = await harness({ capabilities: CAPS, steps: [], seedMessages: seed });
  assert.ok(lazy.isLoaded("desktop"));
  assert.ok(!lazy.isLoaded("sales"));
  assert.ok(session.getActiveToolNames().includes("operator_desktop_observe"));
  assert.ok(!session.getActiveToolNames().includes("sales_call"));
});

test("unknown capability names are refused without side effects", async () => {
  const { session } = await harness({
    capabilities: CAPS,
    steps: [() => fauxAssistantMessage(fauxToolCall("load_capability", { name: "rootshell" }), { stopReason: "toolUse" }), () => fauxAssistantMessage("ok")],
  });
  const before = session.getActiveToolNames().slice().sort();
  await session.prompt("go");
  const r = session.messages.find((m) => m.role === "toolResult").content.map((c) => c.text).join("");
  assert.match(r, /Unknown capability "rootshell"/);
  assert.deepEqual(session.getActiveToolNames().slice().sort(), before);
});

test("no capabilities -> no load_capability tool at all", () => {
  const lazy = makeLazyCapabilities({ capabilities: { desktop: { summary: "x", tools: [] } } });
  assert.equal(lazy.tool, null);
});

test("ticket-chat catalog patterns hide CRM + TOTP op names only", () => {
  const hidden = (n) => TICKET_CHAT_UNADVERTISED.some((re) => re.test(n));
  for (const n of ["get_opportunity", "list_opportunities", "update_opportunity_notes", "list_totp", "get_totp_code", "add_totp", "o365_totp_coverage"]) assert.ok(hidden(n), n);
  for (const n of ["get_ticket", "reply_to_ticket", "resolve_ticket", "add_note", "get_partner_credentials", "upsert_partner_notebook_row", "check_support_authorization"]) assert.ok(!hidden(n), n);
  assert.ok(TOTP_OP_RE.test("add_totp") && !TOTP_OP_RE.test("add_note"));
});
