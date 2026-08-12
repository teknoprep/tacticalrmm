// Regression test: a RESUMED chat must show its history, even after a compaction.
//
// Bug (2026-08-04, session 019fcc9e-afe4-7a51-940a-5e01566c583b): the oversized turn
// blew the context window, pi auto-compacted, and resuming the chat opened a BLANK
// window. Cause: the bridge sent the model's post-compaction CONTEXT
// (`session.messages`, which compaction empties) as the operator's transcript, while
// the full conversation was still on disk in `getBranch()`.
//
// This test asserts against the real session file:
//   SessionManager.open(file).messages        -> 0     (what was being sent)
//   buildContextEntries()                     -> 3     (correct for the MODEL)
//   getBranch()                               -> 15    (the durable record)
//   uiTranscript()                            -> the user prompt, the assistant turn,
//                                                the tool results, + a compaction notice
//
// Run: node test/transcript.test.mjs [path-to-session.jsonl]

import assert from "node:assert/strict";
import fs from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const SESSION =
  process.argv[2] ||
  "/home/tactical/.pi/agent/sessions/--opt-pi-trmm-bridge-sessions--/" +
    "2026-08-04T11-52-59-620Z_019fcc9e-afe4-7a51-940a-5e01566c583b.jsonl";

// Mirror of uiTranscript() in src/server.js (server.js opens sockets on import).
const TRANSCRIPT_TOOL_RESULT_MAX = Number(process.env.PI_TRANSCRIPT_TOOL_MAX || 8000);
const COMPACTION_NOTICE =
  "--- Earlier turns were summarised to free up context. They are shown above for " +
  "your reference, but the assistant no longer sees them verbatim - only the summary. ---";

function uiTranscript(sessionManager, session) {
  let branch = [];
  try { branch = sessionManager?.getBranch?.() || []; } catch { branch = []; }
  const out = [];
  for (const entry of branch) {
    if (entry?.type === "compaction") {
      out.push({ role: "system", content: [{ type: "text", text: COMPACTION_NOTICE }] });
      continue;
    }
    if (entry?.type !== "message" || !entry.message) continue;
    const m = entry.message;
    if (m.role === "toolResult" && Array.isArray(m.content)) {
      out.push({
        ...m,
        content: m.content.map((c) =>
          c?.type === "text" && typeof c.text === "string" && c.text.length > TRANSCRIPT_TOOL_RESULT_MAX
            ? { ...c, text: c.text.slice(0, TRANSCRIPT_TOOL_RESULT_MAX) + `\n...(${c.text.length} bytes total, trimmed for display)` }
            : c,
        ),
      });
      continue;
    }
    out.push(m);
  }
  return out.length ? out : session?.messages || [];
}

// Mirror of the browser's history hydration (PiChat.vue) so we prove what RENDERS.
function hydrate(history) {
  const rendered = [];
  const toolById = {};
  for (const hm of history || []) {
    if (hm.role === "user") {
      const txt = typeof hm.content === "string"
        ? hm.content
        : (hm.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      if (txt) rendered.push({ role: "user", text: txt });
    } else if (hm.role === "assistant") {
      const content = Array.isArray(hm.content) ? hm.content : [];
      const txt = content.filter((c) => c.type === "text").map((c) => c.text).join("");
      const tools = content.filter((c) => c.type === "toolCall").map((c) => {
        const t = { id: c.id, name: c.name, result: "" };
        toolById[c.id] = t;
        return t;
      });
      if (txt || tools.length) rendered.push({ role: "assistant", text: txt, tools });
    } else if (hm.role === "system") {
      const txt = typeof hm.content === "string"
        ? hm.content
        : (hm.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      if (txt) rendered.push({ role: "system", text: txt });
    } else if (hm.role === "toolResult") {
      const t = toolById[hm.toolCallId];
      if (t) {
        t.result = Array.isArray(hm.content)
          ? hm.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
          : (typeof hm.content === "string" ? hm.content : "");
      }
    }
  }
  return rendered;
}

if (!fs.existsSync(SESSION)) {
  console.error(`SKIP: session fixture not found: ${SESSION}`);
  process.exit(0);
}

let pass = 0;
const ok = (n) => { console.log(`  ok  ${n}`); pass++; };
const bytes = (s) => Buffer.byteLength(String(s), "utf8");

console.log("\nresumed-transcript reconstruction (real compacted session)\n");

const sm = SessionManager.open(SESSION);

// --- reproduce the bug --------------------------------------------------------
{
  assert.equal(sm.messages?.length ?? 0, 0, "fixture must be a compacted session");
  ok("reproduces the bug: session.messages is EMPTY for this compacted session");
}
{
  const ctx = sm.buildContextEntries();
  assert.ok(ctx.length < 5, `model context should be collapsed, got ${ctx.length}`);
  assert.equal(ctx[0].type, "compaction", "model context starts at the summary");
  ok(`model context is correctly collapsed to ${ctx.length} entries (compaction first)`);
}
{
  const branch = sm.getBranch();
  assert.equal(branch.length, 15, `durable branch should hold 15 entries, got ${branch.length}`);
  ok("durable branch still holds all 15 entries on disk");
}

// --- the fix ------------------------------------------------------------------
const history = uiTranscript(sm, { messages: [] });
{
  assert.ok(history.length > 0, "uiTranscript must not be empty");
  const roles = history.map((m) => m.role);
  assert.ok(roles.includes("user"), "must include the operator's prompt");
  assert.ok(roles.includes("assistant"), "must include the assistant turn");
  assert.ok(roles.includes("toolResult"), "must include tool results");
  assert.ok(roles.includes("system"), "must include the compaction notice");
  ok(`uiTranscript rebuilds ${history.length} entries: ${[...new Set(roles)].join(", ")}`);
}
{
  const user = history.find((m) => m.role === "user");
  const txt = typeof user.content === "string"
    ? user.content
    : user.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  assert.ok(/slowness/i.test(txt), `expected the original prompt, got: ${txt.slice(0, 80)}`);
  ok("the original prompt is recovered verbatim");
}
{
  // Display trim must bound the frame; the 750 KB event log cannot go down the socket.
  const worst = Math.max(
    ...history
      .filter((m) => m.role === "toolResult")
      .map((m) => Math.max(...(m.content || []).map((c) => bytes(c.text || "")))),
  );
  assert.ok(
    worst <= TRANSCRIPT_TOOL_RESULT_MAX + 200,
    `a tool result is still ${worst} B (cap ${TRANSCRIPT_TOOL_RESULT_MAX})`,
  );
  const total = bytes(JSON.stringify(history));
  assert.ok(total < 150_000, `ready frame too big: ${total} B`);
  ok(`biggest tool result trimmed to ${worst} B; whole frame ${total.toLocaleString("en-US")} B`);
}

// --- what the browser actually renders ----------------------------------------
{
  const rendered = hydrate(history);
  assert.ok(rendered.length >= 3, `browser should render >=3 bubbles, got ${rendered.length}`);
  assert.ok(rendered.some((r) => r.role === "user"), "no user bubble");
  const asst = rendered.find((r) => r.role === "assistant");
  assert.ok(asst, "no assistant bubble");
  assert.equal(asst.tools.length, 7, `expected the 7-tool batch, got ${asst.tools.length}`);
  assert.ok(asst.tools.every((t) => t.result.length > 0), "every tool card must show output");
  assert.ok(
    rendered.some((r) => r.role === "system" && /summarised/.test(r.text)),
    "compaction divider must be visible to the operator",
  );
  console.log("\n  rendered transcript:");
  for (const r of rendered) {
    const label = r.role === "assistant" ? `assistant (${r.tools.length} tool cards)` : r.role;
    console.log(`    - ${label}: ${JSON.stringify((r.text || "").slice(0, 64))}`);
  }
  ok(`browser renders ${rendered.length} bubbles including all 7 tool cards`);
}

// --- non-compacted + brand-new sessions must be unaffected --------------------
{
  const fresh = uiTranscript({ getBranch: () => [] }, { messages: [] });
  assert.deepEqual(fresh, [], "a brand-new session stays empty");
  const fallback = uiTranscript(null, { messages: [{ role: "user", content: "hi" }] });
  assert.equal(fallback.length, 1, "falls back to session.messages when no branch");
  const noCompaction = uiTranscript(
    { getBranch: () => [
      { type: "message", message: { role: "user", content: "a" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "b" }] } },
    ] },
    { messages: [] },
  );
  assert.equal(noCompaction.length, 2, "ordinary session passes through unchanged");
  assert.ok(!noCompaction.some((m) => m.role === "system"), "no spurious divider");
  ok("new / fallback / non-compacted sessions behave unchanged");
}

console.log(`\n${pass} assertions passed.\n`);
