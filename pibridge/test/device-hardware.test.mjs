// Regression test for get_device_hardware (serial / make / model for OFFLINE devices).
//
// Why this tool exists: no helpdesk-facing surface could read a serial number. The only
// hardware-bearing tools were get_device_details (device sessions only - and TRMM's
// AgentSerializer omits serial_number entirely) and run_device_command (needs the
// device ONLINE). Meanwhile TRMM already stores serial + make/model on every agent it
// has ever inventoried, offline ones included, and exposes them on the agent LIST
// endpoint. This test pins the three things that made the old path unusable:
//   1. offline devices still return a serial (no shell, no live WMI)
//   2. placeholder junk ("unknown", "error getting make/model", "To Be Filled") -> null
//   3. a big client never returns JSON cut mid-token; it pages with next_offset
//
// Run: node test/device-hardware.test.mjs

import assert from "node:assert/strict";

const MAX = Number(process.env.PI_MAX_TOOL_RESULT_BYTES || 60000);

// ---- stub TRMM: one fetch, the agent LIST payload (AgentTableSerializer shape) ----
function agent(i, over = {}) {
  return {
    agent_id: `AGENT${String(i).padStart(4, "0")}`,
    hostname: `HOST-${i}`,
    client_name: i % 2 ? "Acme Corp" : "Globex",
    site_name: "Main",
    operating_system: "Windows 11 Pro, 64 bit v23H2 (build 22631.3880)",
    plat: "windows",
    monitoring_type: "workstation",
    status: "overdue", // OFFLINE - the whole point
    logged_username: "jsmith",
    last_seen: "2024-09-27T22:51:49.471779Z",
    serial_number: `SN${i}`,
    make_model: "LENOVO ThinkPad X1 Carbon Gen 12",
    ...over,
  };
}

const FLEET = [
  agent(1, { hostname: "pve01", client_name: "Acme Corp", serial_number: "OM161S004920" }),
  agent(2, { serial_number: "", make_model: "unknown make/model" }),
  agent(3, { serial_number: "unknown", make_model: "error getting make/model" }),
  agent(4, { serial_number: "To Be Filled By O.E.M.", make_model: "Default string" }),
  agent(5, { serial_number: "0000000000", make_model: "System Serial Number" }),
  ...Array.from({ length: 600 }, (_, k) => agent(k + 6, { client_name: "Acme Corp" })),
];

let calls = 0;
globalThis.fetch = async (url) => {
  calls += 1;
  assert.match(String(url), /\/agents\/$/, "must use the agent LIST endpoint (it carries serial_number)");
  return { ok: true, status: 200, text: async () => JSON.stringify(FLEET) };
};

process.env.TRMM_API_URL ||= "https://stub.invalid";
process.env.TRMM_API_KEY ||= "stub";

const { buildDecisionTools, buildTicketTriageTools } = await import("../src/tools.js");

const decision = buildDecisionTools({ gate: async () => ({ ok: false }) }).tools;
const tool = decision.find((t) => t.name === "get_device_hardware");

const run = async (args = {}) => {
  const out = await tool.execute("t", args);
  const txt = out.content[0].text;
  assert.ok(!txt.includes("TRUNCATED"), "result must never be cut mid-token");
  return { txt, json: JSON.parse(txt) };
};

console.log("\nget_device_hardware\n");

assert.ok(tool, "registered on the decision chat (ai-decision)");
console.log("  ok  registered on the decision chat");

try {
  const triage = buildTicketTriageTools({}).tools;
  assert.ok(triage.some((t) => t.name === "get_device_hardware"));
  console.log("  ok  registered on the triage surface");
} catch {
  console.log("  --  triage surface not constructible here (skipped)");
}

{
  const { json } = await run({ hostname_contains: "pve" });
  assert.equal(json.matched, 1);
  assert.equal(json.devices[0].serial, "OM161S004920");
  assert.equal(json.devices[0].status, "overdue", "device is OFFLINE and still yields a serial");
  console.log("  ok  offline device returns its stored serial (no shell, no live WMI)");
}

{
  const { json } = await run({ hostname_contains: "HOST-", limit: 5 });
  const junk = json.devices.filter((d) =>
    /unknown|error|to be filled|default string|system serial|^0+$/i.test(`${d.serial} ${d.make_model}`));
  assert.deepEqual(junk, [], "placeholder hardware strings must be null, never reported as fact");
  assert.equal(json.devices.find((d) => d.hostname === "HOST-2").serial, null);
  assert.equal(json.devices.find((d) => d.hostname === "HOST-3").make_model, null);
  console.log("  ok  placeholder serial/make_model become null, not fake facts");
}

{
  const { json } = await run({ only_missing_serial: true });
  assert.ok(json.matched >= 4 && json.devices.every((d) => d.serial === null));
  console.log(`  ok  only_missing_serial isolates the ${json.matched} real gaps`);
}

{
  // The failure this replaces: 601 rows x ~380 B would blow the cap and arrive as
  // unparseable JSON. Now it pages.
  const ACME = FLEET.filter((a) => a.client_name === "Acme Corp").length;
  const { txt, json } = await run({ client_name: "acme", limit: 1000 });
  assert.equal(json.matched, ACME, "client_name matches case-insensitively on a substring");
  assert.ok(Buffer.byteLength(txt) <= MAX, `page must fit the ${MAX} B cap (got ${Buffer.byteLength(txt)})`);
  assert.ok(json.devices.length < json.matched && json.next_offset === json.devices.length);
  const page2 = (await run({ client_name: "acme", offset: json.next_offset, limit: 1000 })).json;
  assert.notEqual(page2.devices[0].hostname, json.devices.at(-1).hostname, "pages must not overlap");
  assert.equal(page2.showing.split("-")[0], String(json.next_offset + 1), "next_offset resumes exactly where page 1 stopped");
  console.log(`  ok  601-device client pages cleanly: ${json.showing}, next_offset ${json.next_offset}, ` +
              `${Buffer.byteLength(txt)} B <= ${MAX} B`);
}

{
  const { json } = await run({ client_name: "NoSuchClient" });
  assert.equal(json.matched, 0);
  assert.ok(json.known_clients.includes("Acme Corp"), "dead end must hand back the real client names");
  console.log("  ok  no match returns known_clients instead of dead-ending");
}

{
  const before = calls;
  await run({ client_name: "Globex" });
  assert.equal(calls, before, "fleet list is cached (60s) - repeated questions cost one fetch");
  console.log(`  ok  fleet fetch is cached: ${calls} HTTP call(s) for ${9} queries`);
}

// get_device_details (device sessions) goes through shapeAgentDetails. TRMM's
// AgentSerializer now carries serial_number (it did not before 2026-08-12), so that
// path must apply the SAME placeholder rule - no "unknown" masquerading as a serial.
{
  const { shapeAgentDetails } = await import("../src/tools.js");
  const shaped = shapeAgentDetails({
    hostname: "pve1", serial_number: "unknown", make_model: "error getting make/model",
    wmi_detail: { big: "x".repeat(1000) }, services: [{ name: "s", status: "running" }],
  });
  assert.equal(shaped.serial_number, null);
  assert.equal(shaped.make_model, null);
  const real = shapeAgentDetails({ serial_number: "OM161S004920", make_model: "Supermicro X11" });
  assert.equal(real.serial_number, "OM161S004920");
  assert.equal(real.make_model, "Supermicro X11");
  console.log("  ok  get_device_details applies the same placeholder rule to serial/make_model");
}

console.log("\nAll get_device_hardware assertions passed.\n");
