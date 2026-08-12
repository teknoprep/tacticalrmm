// Regression test for tool-result size caps.
//
// Replays the ACTUAL tool payloads from the session that stalled on 2026-08-04
// (agent AVgiDUib..., session 019fcc9e-afe4-7a51-940a-5e01566c583b): 1.76 MB of tool
// JSON in one turn (a 1.99 MB session file once escaped) pushed ~609k tokens into a
// 200k context window, so the turn ended with stopReason="length" having produced no
// answer, at a cost of $7.52.
//
// The caps must bring every single result under MAX_TOOL_RESULT_BYTES and keep the
// whole batch small enough to leave room for the model to actually think and reply.
//
// Run: node test/tool-caps.test.mjs [path-to-session.jsonl]

import assert from "node:assert/strict";
import fs from "node:fs";
import { capString, capJson, shapeAgentDetails } from "../src/tools.js";

const CAP = Number(process.env.PI_MAX_TOOL_RESULT_BYTES || 60000);
const SESSION =
  process.argv[2] ||
  "/home/tactical/.pi/agent/sessions/--opt-pi-trmm-bridge-sessions--/" +
    "2026-08-04T11-52-59-620Z_019fcc9e-afe4-7a51-940a-5e01566c583b.jsonl";

const bytes = (s) => Buffer.byteLength(String(s), "utf8");
const fmt = (n) => n.toLocaleString("en-US");

// --- Re-implementations of the per-tool shaping, driven by the real payloads ----
// (mirrors src/tools.js so the test exercises the same shapes the tools produce)
function shapeProcesses(procs, limit = 40) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const ranked = [...procs].sort(
    (a, b) => num(b.cpu_percent) - num(a.cpu_percent) || num(b.membytes) - num(a.membytes),
  );
  return capJson(
    {
      total_processes: procs.length,
      showing_top: Math.min(limit, ranked.length),
      ranked_by: "cpu_percent desc, then membytes desc",
      total_memory_bytes_all_processes: procs.reduce((n, x) => n + num(x.membytes), 0),
      processes: ranked.slice(0, limit),
    },
    { what: "process" },
  );
}

function shapeEvents(out, logType, days, { include_info = false, max_entries = 150 } = {}) {
  const total = out.length;
  const wanted = /^(error|critical|warning)$/i;
  let rows = include_info ? out : out.filter((e) => wanted.test(String(e?.eventType || "")));
  const dropped = total - rows.length;
  rows = [...rows].reverse().map((e) => ({
    ...e,
    message: capString(String(e?.message ?? ""), 600, "event message"),
  }));
  return capJson(
    {
      log_type: logType,
      days,
      total_events_in_window: total,
      severity_filter: include_info ? "ALL (info included)" : "ERROR/CRITICAL/WARNING only",
      info_events_suppressed: include_info ? 0 : dropped,
      source_contains: null,
      returned: Math.min(max_entries, rows.length),
      matching_after_filter: rows.length,
      events: rows.slice(0, max_entries),
    },
    { what: "event" },
  );
}

function shapeSoftware(sw) {
  const list = Array.isArray(sw?.software) ? sw.software : Array.isArray(sw) ? sw : [];
  return capJson(
    {
      total_installed: list.length,
      returned: list.length,
      software: list.map((s) => ({ name: s?.name, version: s?.version, publisher: s?.publisher })),
    },
    { what: "software" },
  );
}

// --- Load the real turn -------------------------------------------------------
if (!fs.existsSync(SESSION)) {
  console.error(`SKIP: session fixture not found: ${SESSION}`);
  process.exit(0);
}
const results = [];
for (const line of fs.readFileSync(SESSION, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  const m = row.message;
  if (m?.role !== "toolResult") continue;
  results.push({ tool: m.toolName, text: m.content?.[0]?.text ?? "" });
}
assert.ok(results.length >= 7, `expected the 7-tool batch, got ${results.length}`);

// --- Apply the caps -----------------------------------------------------------
let before = 0;
let after = 0;
let eventSeen = 0;
const rows = [];

for (const r of results) {
  const rawBytes = bytes(r.text);
  let out;
  let parsed = null;
  try { parsed = JSON.parse(r.text); } catch { /* non-JSON (e.g. notes) */ }

  switch (r.tool) {
    case "get_device_details":
      out = capJson(shapeAgentDetails(parsed), { what: "device detail" });
      break;
    case "list_processes":
      out = shapeProcesses(parsed);
      break;
    case "get_event_logs":
      out = shapeEvents(parsed, eventSeen++ === 0 ? "System" : "Application", 7);
      break;
    case "list_software":
      out = shapeSoftware(parsed);
      break;
    case "get_checks":
      out = capJson(parsed, { what: "check" });
      break;
    default:
      out = capString(r.text, CAP, r.tool);
  }

  const outBytes = bytes(out);
  before += rawBytes;
  after += outBytes;
  rows.push({ tool: r.tool, rawBytes, outBytes, out });

  // Every individual result must respect the cap (+2 KB for the explanatory note).
  assert.ok(
    outBytes <= CAP + 2048,
    `${r.tool}: ${fmt(outBytes)} B exceeds cap ${fmt(CAP)} B`,
  );
}

// --- Assertions that encode the actual incident --------------------------------
assert.ok(before > 1_700_000, `fixture should be the ~1.76 MB turn, got ${fmt(before)} B`);

// The whole batch must now fit in a small fraction of a 200k-token window.
// ~4 bytes/token is a safe rough conversion for this JSON.
const approxTokens = Math.round(after / 4);
assert.ok(
  approxTokens < 60_000,
  `batch still too big: ~${fmt(approxTokens)} tokens (want < 60,000)`,
);

// get_device_details must have shed the services table, wmi_detail and all_timezones.
// Check for the JSON KEYS (the _omitted_for_context note legitimately names them).
const dd = rows.find((r) => r.tool === "get_device_details");
for (const gone of ['"all_timezones":', '"wmi_detail":', '"services":']) {
  assert.ok(!dd.out.includes(gone), `get_device_details still carries the ${gone} payload`);
}
assert.ok(dd.out.includes("services_summary"), "expected services_summary in device details");
assert.ok(dd.out.includes("_omitted_for_context"), "expected _omitted_for_context note");

// Event logs must report what was suppressed rather than silently dropping it.
const ev = rows.filter((r) => r.tool === "get_event_logs");
assert.equal(ev.length, 2, "expected both event-log pulls");
for (const e of ev) {
  assert.ok(e.out.includes("info_events_suppressed"), "missing info_events_suppressed");
  assert.ok(e.out.includes("total_events_in_window"), "missing total_events_in_window");
  assert.ok(JSON.parse(e.out.slice(e.out.indexOf("{"))), "event payload must be valid JSON");
}

// Truncated arrays must still parse as JSON (the "showing X of Y" path).
const bigArray = Array.from({ length: 20000 }, (_, i) => ({ i, pad: "x".repeat(200) }));
const capped = capJson(bigArray, { what: "synthetic" });
assert.ok(capped.startsWith("NOTE: showing "), "expected showing X of Y preamble");
assert.ok(Array.isArray(JSON.parse(capped.slice(capped.indexOf("[")))), "capped array must parse");
assert.ok(bytes(capped) <= CAP + 2048, "capped array exceeded budget");

// capString marks truncation and respects the budget.
const long = capString("y".repeat(500_000), 10_000, "unit test");
assert.ok(bytes(long) <= 10_000 + 2048 && long.includes("[TRUNCATED"), "capString failed");

// --- Report -------------------------------------------------------------------
console.log("\nTool-result caps vs. the real 2026-08-04 stalled turn\n");
console.log(
  `${"tool".padEnd(20)}${"before".padStart(12)}${"after".padStart(12)}${"saved".padStart(10)}`,
);
for (const r of rows.sort((a, b) => b.rawBytes - a.rawBytes)) {
  const pct = r.rawBytes ? Math.round((1 - r.outBytes / r.rawBytes) * 100) : 0;
  console.log(
    r.tool.padEnd(20) +
      fmt(r.rawBytes).padStart(12) +
      fmt(r.outBytes).padStart(12) +
      `${pct}%`.padStart(10),
  );
}
console.log("-".repeat(54));
console.log(
  "TOTAL".padEnd(20) + fmt(before).padStart(12) + fmt(after).padStart(12) +
    `${Math.round((1 - after / before) * 100)}%`.padStart(10),
);
console.log(
  `\n~${fmt(Math.round(before / 4))} tokens  ->  ~${fmt(approxTokens)} tokens ` +
    `(200,000-token window)`,
);
console.log("\nAll cap assertions passed.\n");
