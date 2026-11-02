// A retry the technician asked for must reach the judge as an instruction (TICKET/62735).
import test from "node:test";
import assert from "node:assert/strict";
import { retryInstruction, buildBrief } from "../src/judge.js";

const t = (...texts) => texts.map((text, i) => ({ at: `2026-10-19T20:4${i}:00Z`, text }));

test("explicit retry phrasings are detected in the newest tech turn", () => {
  for (const s of ["retry again... we should have fixed it", "try again", "Try it again please",
    "run it again", "rerun that", "give it one more go", "ok do it again", "have another go"]) {
    assert.ok(retryInstruction(t("earlier", s)), s);
  }
});

test("negated or absent retry is not detected", () => {
  for (const s of ["don't retry that", "do not try again", "hold off on retrying", "close the ticket",
    "no more retries please", "what failed?"]) {
    assert.equal(retryInstruction(t(s)), null, s);
  }
});

test("only the NEWEST turn counts; bridge-injected turns are skipped", () => {
  assert.equal(retryInstruction(t("try again", "now close the ticket")), null);
  assert.ok(retryInstruction(t("try again",
    "[auto-continue from the bridge, not the technician] Your last message said what you would do next")));
});

test("an answered-question wrapper and attachments do not hide or fake intent", () => {
  const wrapped = '(Answering your question: "Shall I try again or stop?")\nstop, leave it\n\n[[pi-attachment:KB recall|1]]';
  assert.equal(retryInstruction(t(wrapped)), null);
  const yes = '(Answering your question: "Want me to stop?")\nno - try again\n\n[[pi-attachment:KB recall (2)|9]]\nrerun';
  assert.ok(retryInstruction(t(yes)));
});

test("the brief states the retry instruction; without one it does not", () => {
  const b = buildBrief({ kind: "sales", summary: "create_quotation", techSaid: t("retry again... we should have fixed it"), session: { messages: [] } });
  assert.match(b, /EXPLICITLY ASKED FOR A RETRY.*retry again/);
  assert.match(b, /NOT a reason to deny/);
  const n = buildBrief({ kind: "sales", summary: "create_quotation", techSaid: t("make a quote"), session: { messages: [] } });
  assert.doesNotMatch(n, /ASKED FOR A RETRY/);
});
