// Auto-credential: when it covers a read, and when a human still has to answer.
//
// Reported 2026-08-25: "even with auto-credential on it still asks for approval". The
// gate was behaving as written - the model was escalating to the PRIVILEGED rows on its
// own initiative after every ordinary read, and privileged rows prompt. These tests pin
// both halves: the ordinary read must be silent, and the escalation must only be silent
// when the technician actually asked for it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { privilegedCredentialAuthorisation, notebookWriteAuthorisation } from "../src/authorisation.js";

const turns = (...texts) => texts.map((text, i) => ({ at: `2026-08-25T10:0${i}:00Z`, text }));

test("the technician asking for the admin login authorises the privileged read", () => {
  for (const said of [
    "grab the domain admin password for them",
    "use the administrator account",
    "what's the privileged row for this company?",
    "get me the admin credentials",
    "the password for the admin account please",
    "log in with the root login",
  ]) {
    assert.ok(privilegedCredentialAuthorisation(turns(said)), `should authorise: ${said}`);
  }
});

test("ordinary conversation does not authorise a privileged read", () => {
  for (const said of [
    "can you check why the printer is offline",
    "read the notebook and tell me the wifi password",
    "the user cannot log in to their laptop",
    "look at the credentials for the standard account",
    "reset the spooler service",
  ]) {
    assert.equal(privilegedCredentialAuthorisation(turns(said)), null, `should NOT authorise: ${said}`);
  }
});

test("a refusal ends the search and is not out-voted by an older instruction", () => {
  // The technician changed their mind. The newest word wins, and a refusal is operative
  // rather than merely unmatched.
  assert.equal(
    privilegedCredentialAuthorisation(turns("get the admin password", "actually don't use the admin account")),
    null,
  );
  assert.equal(privilegedCredentialAuthorisation(turns("not the domain admin one")), null);
  assert.equal(privilegedCredentialAuthorisation(turns("do this without the admin login")), null);
});

test("the newest instruction is the operative one", () => {
  const auth = privilegedCredentialAuthorisation(
    turns("don't touch the admin account", "ok go ahead and use the admin credentials"),
  );
  assert.ok(auth, "a later explicit instruction re-authorises");
  assert.match(auth.text, /go ahead/);
});

test("the model cannot authorise itself - only the technician's turns are read", () => {
  // The caller passes technician turns only; this asserts the function has no other
  // channel. A model that could authorise itself by asserting 'you told me to' is not
  // gated at all.
  assert.equal(privilegedCredentialAuthorisation([]), null);
  assert.equal(privilegedCredentialAuthorisation(null), null);
  assert.equal(privilegedCredentialAuthorisation(undefined), null);
});

test("the notebook-write test still behaves after the shared-scan refactor", () => {
  assert.ok(notebookWriteAuthorisation(turns("save that to the IT notebook")));
  assert.ok(notebookWriteAuthorisation(turns("IT Notebook: add a row for grafana")));
  assert.equal(notebookWriteAuthorisation(turns("add a note about the notebook")), null,
    "an action aimed at a NOTE must not authorise a credential write");
  assert.equal(notebookWriteAuthorisation(turns("don't save it to the notebook, just show me")), null);
});

// ---- the gate itself ---------------------------------------------------------------
// makeCredentialGate lives in server.js, which opens sockets on import. Re-declared here
// against the same contract: if these two diverge the tests are worthless, so the shape is
// kept deliberately small and the behaviours asserted are the ones written in the comment
// block above the real one.
function gateHarness({ on, allowed, said = [], answer = true }) {
  const log = [];
  const prompts = [];
  const gate = makeGate({
    isOn: () => on,
    allowed,
    techSaid: turns(...said),
    prompt: async (ask) => { prompts.push(ask); return answer; },
    log: (...a) => log.push(a.join(" ")),
    key: "k", sessionId: () => "s",
  });
  return { gate, prompts, log };
}

// Mirror of server.js makeCredentialGate.
function makeGate({ isOn, allowed, techSaid, prompt, log, key, sessionId }) {
  const sid = () => (typeof sessionId === "function" ? sessionId() : sessionId);
  return async function credentialGate(summary, opts = {}) {
    if (isOn() && allowed && !opts.privileged) {
      log("credential read auto-permitted (Auto-credential)", key, sid(), String(summary).slice(0, 160));
      return { ok: true };
    }
    if (opts.privileged && isOn() && allowed) {
      const auth = privilegedCredentialAuthorisation(techSaid);
      if (auth) {
        log("privileged credential read authorised by tech", key, sid(), `"${auth.text.slice(0, 120)}"`);
        return { ok: true, authorised_by: auth };
      }
    }
    const ok = await prompt(summary);
    if (!ok) return { ok: false, reason: "the technician did not permit reading the stored credentials." };
    log("credential read permitted by tech", key, sid(), String(summary).slice(0, 160));
    return { ok: true };
  };
}

test("Auto-credential ON: an ordinary read does not prompt", async () => {
  const h = gateHarness({ on: true, allowed: true });
  const r = await h.gate("Read STORED CREDENTIALS for Acme");
  assert.equal(r.ok, true);
  assert.equal(h.prompts.length, 0, "this is the whole point of the switch");
  assert.ok(h.log.some((l) => l.includes("auto-permitted")), "silent is not the same as unrecorded");
});

test("Auto-credential ON: a self-directed privileged read still prompts", async () => {
  const h = gateHarness({ on: true, allowed: true, said: ["fix the printer please"] });
  const r = await h.gate("… PRIVILEGED ROWS …", { privileged: true });
  assert.equal(r.ok, true);
  assert.equal(h.prompts.length, 1, "the model escalating on its own must reach a human");
});

test("Auto-credential ON: a privileged read the technician asked for does not prompt", async () => {
  const h = gateHarness({ on: true, allowed: true, said: ["get me the domain admin password"] });
  const r = await h.gate("… PRIVILEGED ROWS …", { privileged: true });
  assert.equal(r.ok, true);
  assert.equal(h.prompts.length, 0, "a prompt confirming what they just typed protects nobody");
  assert.ok(r.authorised_by, "and the authorising sentence is carried for the record");
  assert.ok(h.log.some((l) => l.includes("authorised by tech")));
});

test("the role permission outranks the switch", async () => {
  const h = gateHarness({ on: true, allowed: false });
  await h.gate("Read STORED CREDENTIALS for Acme");
  assert.equal(h.prompts.length, 1, "a switch cannot grant a permission the role lacks");
});

test("switch OFF: every read prompts", async () => {
  const h = gateHarness({ on: false, allowed: true });
  await h.gate("Read STORED CREDENTIALS for Acme");
  assert.equal(h.prompts.length, 1);
});

test("a denied prompt refuses the read and says so", async () => {
  const h = gateHarness({ on: false, allowed: true, answer: false });
  const r = await h.gate("Read STORED CREDENTIALS for Acme");
  assert.equal(r.ok, false);
  assert.match(r.reason, /did not permit/);
});
