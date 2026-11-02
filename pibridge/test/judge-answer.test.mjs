// An answer given in the Queue's question form must reach the judge IN FULL (TICKET/63160,
// 2026-10-25): the quoted question used to come first and use up the line budget, so the
// judge never saw "yes" and denied the action as unconfirmed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief, techLine } from "../src/judge.js";

const QUESTION = "Do you want the artwork applied to the live Odoo now? Looking at " +
  "https://jamesnewell.coach/jn_race_coach/static/src/img/logo.png and .../banner.png first. " +
  "If yes, say \"yes, apply the logo and banner\" and I'll set the company logo, the website logo " +
  "and insert the banner strip at the top of the homepage (homepage view and logo field backed up first). " +
  "If not, tell me what to change.";
const said = `(Answering your question: "${QUESTION.slice(0, 400)}...")\nyes apply the logo and banner... once i see it i might change it`;

test("the technician's answer is in the brief even when the question is long", () => {
  const brief = buildBrief({ kind: "device change", summary: "write logo", subject: "TICKET/63160",
    techSaid: [{ at: "2026-10-25T15:39:02Z", text: said }], session: null });
  assert.match(brief, /- yes apply the logo and banner\.\.\. once i see it i might change it/);
  assert.match(brief, /ANSWER to your question: "Do you want the artwork applied/);
});

test("the answer comes first and the question is only context", () => {
  const line = techLine({ text: said }, 400);
  assert.ok(line.startsWith("yes apply the logo and banner"));
});

test("ordinary chat lines are unchanged", () => {
  assert.equal(techLine({ text: "restart the spooler" }, 400), "restart the spooler");
  assert.match(techLine({ text: "x".repeat(500) }, 400), /\.\.\.\[100 more chars\]$/);
});
