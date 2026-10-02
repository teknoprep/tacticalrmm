// MFA HANDSHAKE (owner, 2026-09-27). "Ask the technician in the chat before Microsoft phones
// them" cannot be a prompt rule: a model that clicks "Call me" unprompted rings somebody who is
// not ready, and every failed attempt counts against the account (TICKET/60427 locked a tenant
// admin out with AADSTS50053 x4 exactly that way). So the clicks that MAKE A PHONE RING are held
// in code until the technician has actually said yes in this chat.
import test from "node:test";
import assert from "node:assert/strict";
import { mfaPhoneGate, techReadyForMfa, MFA_TRIGGER } from "../src/tools.js";

const text = (t) => ({ content: [{ type: "text", text: t }], details: {} });
const clickLabel = (label) => ({
  name: "operator_desktop_click_label",
  execute: async (_id, p) => text(`CLICKED ${p.targetLabel}`),
});
const run = async (label, techTurns) => {
  const tool = clickLabel(label);
  mfaPhoneGate([tool], { techTurns, text });
  const res = await tool.execute("id", { targetLabel: label, targetType: "Button" });
  return res.content.map((c) => c.text).join("");
};

test("the buttons that contact the technician are recognised", () => {
  for (const l of ["Call me", "Text me", "Send notification", "Send a code", "Verify my identity",
    "Use another method", "I can't use my Microsoft Authenticator app right now", "Send request", "Get a code"])
    assert.ok(MFA_TRIGGER.test(l), l);
  for (const l of ["Next", "Sign in", "Add members", "Save", "Search for users", "Clear", "Full Access"])
    assert.ok(!MFA_TRIGGER.test(l), l);
});

test("clicking a contact-the-tech button before they agreed is HELD, with the ask spelled out", async () => {
  const msg = await run("Call me", []);                       // nothing said yet
  assert.match(msg, /^HELD/);
  assert.match(msg, /pause_queue/);
  assert.match(msg, /do not click it again/i);
  assert.doesNotMatch(msg, /CLICKED/);
});

test("a yes in the technician's most recent turn lets the click through", async () => {
  assert.match(await run("Call me", [{ text: "yes go ahead" }]), /CLICKED Call me/);
  assert.match(await run("Text me", [{ text: "ready" }]), /CLICKED Text me/);
});

test("an old yes is not consent for a new prompt - the LAST word is what counts", async () => {
  assert.match(await run("Call me", [{ text: "yes" }, { text: "actually hold on a minute" }]), /^HELD/);
  assert.match(await run("Call me", [{ text: "yes" }, { text: "what does it say on the page?" }]), /^HELD/,
    "a question is not a yes");
});

test("a plain no is never consent", async () => {
  for (const t of ["no", "not yet", "wait", "don't call me yet", "I'm busy"])
    assert.match(await run("Call me", [{ text: t }]), /^HELD/, t);
});

test("ordinary clicks are untouched (no handshake noise on normal work)", async () => {
  assert.match(await run("Add members", []), /CLICKED Add members/);
  assert.match(await run("Save", []), /CLICKED Save/);
  assert.match(await run("Next", []), /CLICKED Next/);
});

test("typing a TOTP code is not gated - a stored code needs nobody", async () => {
  const tool = { name: "operator_desktop_type", execute: async (_id, p) => text(`TYPED ${p.text}`) };
  mfaPhoneGate([tool], { techTurns: [], text });
  const res = await tool.execute("id", { text: "123456" });
  assert.match(res.content[0].text, /TYPED 123456/);
});

test("techReadyForMfa: yes unless the newest turn is a refusal or silence", () => {
  assert.equal(techReadyForMfa([{ text: "ok" }]), true);
  assert.equal(techReadyForMfa([{ text: "yes" }, { text: "no" }]), false);
  assert.equal(techReadyForMfa([]), false);
  assert.equal(techReadyForMfa(null), false);
  assert.equal(techReadyForMfa([{ text: "when will it ring?" }]), false);
});
