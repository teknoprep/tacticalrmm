// Email from a PRE-SALES DISCOVERY session follows the window's switches (owner ruling
// 2026-09-16): our own people need Write mode or a click; anyone else needs the
// "Allow customer email" switch AND a click. No network - trmm.sendEmail is stubbed.
import { strict as assert } from "node:assert";
import test from "node:test";
import { buildDecisionTools } from "../src/tools.js";
import { trmm } from "../src/trmm.js";

const sent = [];
trmm.sendEmail = async (args) => { sent.push(args); return { ok: true, id: 1 }; };

const HD = `exports.operations={}; exports.meta={}; exports.mutating=[]; exports.opClasses={};`;

// A gate that behaves like the real one, so the test exercises OUR rules, not a stub's.
function gateFor({ writeMode, allowEmail, approves }) {
  const asked = [];
  const gate = async (kind, summary) => {
    asked.push({ kind, summary });
    if (kind === "device") {
      if (!writeMode) return { ok: false, reason: "the chat is in READ-ONLY mode - switch on Write mode to make device changes." };
      return { ok: true };
    }
    if (kind === "email") {
      if (!allowEmail) return { ok: false, reason: "customer email is turned OFF" };
      return { ok: !!approves };
    }
    return { ok: false, reason: "unexpected kind " + kind };
  };
  return { gate, asked };
}

function tools(opts) {
  const { gate, asked } = gateFor(opts);
  const built = buildDecisionTools({
    helpdeskCode: HD, helpdeskApi: { base_url: "x", api_key: "y" },
    ticketRef: "", leadRef: "LEAD/837", surface: "discovery", gate,
    actorEmail: "tech@blueuc.com", actorName: "A Tech",
    internalDomains: ["blueuc.com"],
  });
  return { send: built.tools.find((t) => t.name === "send_email"), asked };
}

test("the email tool exists on a discovery session at all", () => {
  const { send } = tools({ writeMode: true, allowEmail: false, approves: false });
  assert.ok(send, "send_email must be available - techs need to send themselves findings");
});

test("emailing OUR OWN people is allowed once Write mode is on", async () => {
  sent.length = 0;
  const { send, asked } = tools({ writeMode: true, allowEmail: false, approves: false });
  const r = await send.execute("1", { to: "chris@blueuc.com", subject: "scope", body: "findings" });
  assert.equal(asked[0].kind, "device", "internal mail is governed by Write mode, not the customer switch");
  assert.equal(sent.length, 1, "it should actually send");
  assert.equal(sent[0].to, "chris@blueuc.com");
  assert.ok(!/REFUSED/.test(r.content[0].text));
});

test("emailing our own people is refused in read-only, and says which switch", async () => {
  sent.length = 0;
  const { send } = tools({ writeMode: false, allowEmail: false, approves: false });
  const r = await send.execute("1", { to: "chris@blueuc.com", subject: "scope", body: "findings" });
  assert.equal(sent.length, 0);
  assert.match(r.content[0].text, /REFUSED/);
  assert.match(r.content[0].text, /Write mode/, "the refusal must name the switch that fixes it");
});

test("emailing the PROSPECT needs the customer-email switch, not just Write mode", async () => {
  sent.length = 0;
  const { send, asked } = tools({ writeMode: true, allowEmail: false, approves: true });
  const r = await send.execute("1", { to: "bremington@omegadesign.com", subject: "quote", body: "hi" });
  assert.equal(asked[0].kind, "email", "an outside recipient is governed by the customer-email switch");
  assert.equal(sent.length, 0, "Write mode alone must not reach a prospect");
  assert.match(r.content[0].text, /REFUSED/);
});

test("emailing the prospect goes through when the switch is on AND the tech approves", async () => {
  sent.length = 0;
  const { send } = tools({ writeMode: false, allowEmail: true, approves: true });
  await send.execute("1", { to: "bremington@omegadesign.com", subject: "quote", body: "hi" });
  assert.equal(sent.length, 1);
});

test("the prospect does NOT get it when the tech declines the prompt", async () => {
  sent.length = 0;
  const { send } = tools({ writeMode: true, allowEmail: true, approves: false });
  const r = await send.execute("1", { to: "bremington@omegadesign.com", subject: "quote", body: "hi" });
  assert.equal(sent.length, 0);
  assert.match(r.content[0].text, /REFUSED/);
});

test("a mixed recipient list is treated as external", async () => {
  sent.length = 0;
  const { send, asked } = tools({ writeMode: true, allowEmail: false, approves: true });
  await send.execute("1", { to: "chris@blueuc.com, bremington@omegadesign.com", subject: "q", body: "b" });
  assert.equal(asked[0].kind, "email", "one outside address makes the whole send external");
  assert.equal(sent.length, 0);
});
