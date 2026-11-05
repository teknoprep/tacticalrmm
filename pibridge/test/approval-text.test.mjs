// THE APPROVAL BAND MUST BE DECIDABLE AT A GLANCE (owner, 2026-11-05: "it's so long I need a
// crazy big monitor to get it approved ... just give a summary of what it's asking aproval
// for"). A long command is shortened for the person - never paraphrased, never hidden from the
// judge, and it always says that it was cut.
import test from "node:test";
import assert from "node:assert/strict";
import { compactAsk, ASK_MAX_CHARS } from "../src/approval-text.js";

const SCRIPT = Array.from({ length: 120 }, (_, i) => `Set-Mailbox -Identity user${i} -GrantSendOnBehalfTo x`).join("\n");
const ASK = `Run a command that MODIFIES PC01 [powershell]:\n\n${SCRIPT}`;

test("a long command is cut to a readable ask", () => {
  const ask = compactAsk(ASK);
  assert.ok(ask.length < ASK_MAX_CHARS + 200, `still huge: ${ask.length}`);
  assert.ok(ask.split("\n").length <= 10, "still a wall of lines");
  // The asking line - what, which machine, which shell - survives whole.
  assert.match(ask, /^Run a command that MODIFIES PC01 \[powershell\]:/);
  // What it is doing is still visible: the command's OWN first lines, not a description of them.
  assert.match(ask, /Set-Mailbox -Identity user0 -GrantSendOnBehalfTo x/);
});

test("a cut ask says it was cut, and how much is missing", () => {
  const ask = compactAsk(ASK);
  assert.match(ask, /more lines, \d+ more characters not shown/);
  assert.match(ask, /the whole thing is in the tool call in the transcript above/);
});

test("a short ask is passed through untouched", () => {
  const short = "Run a command that MODIFIES PC01 [powershell]:\n\nRestart-Service Spooler";
  assert.equal(compactAsk(short), short);
  assert.equal(compactAsk("Send this reply to the customer on TICKET/63100:\n\nOn our way."),
    "Send this reply to the customer on TICKET/63100:\n\nOn our way.");
});

test("a long ONE-LINER is cut too - it has no blank line to protect", () => {
  const one = `Run on device [bash]: curl -s ${"-H 'X: y' ".repeat(120)}`;
  const ask = compactAsk(one);
  assert.ok(ask.length < ASK_MAX_CHARS + 200);
  assert.match(ask, /^Run on device \[bash\]: curl -s /);
  assert.match(ask, /not shown/);
});

test("the cut lands on a line boundary, not mid-statement", () => {
  const ask = compactAsk(ASK);
  const shown = ask.split("\n\n")[1];
  // Every shown line is a complete line of the script (the last one may be the note's line).
  for (const line of shown.split("\n")) {
    assert.ok(SCRIPT.split("\n").includes(line) || line.startsWith("… ["), `partial line: ${line}`);
  }
});

test("nothing that fits the limits is reported as too long", () => {
  assert.equal(compactAsk("x".repeat(ASK_MAX_CHARS)), "x".repeat(ASK_MAX_CHARS));
  assert.match(compactAsk("x".repeat(ASK_MAX_CHARS + 1)), /not shown/);
});

test("judge verdicts are appended AFTER the cut, so they are never the part trimmed", () => {
  // Mirrors requestApproval in server.js: compactAsk(summary) + judgeLine(verdict).
  const judge = "\n\nJudge (opus): APPROVE, low risk. Ordinary mailbox grant.";
  const ask = compactAsk(ASK) + judge;
  assert.match(ask, /Judge \(opus\): APPROVE, low risk\. Ordinary mailbox grant\.$/);
});
