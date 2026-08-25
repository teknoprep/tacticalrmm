// Which model does a window open on?
//
// Reported: "if i refresh a window it doesn't default to the model that is default.. but
// that last model used". Before this, `set_model` persisted nothing, so the choice lived
// only inside one WebSocket - a refresh silently put the technician back on the global
// default, and since switching model re-caches the whole conversation into the new
// provider, they paid for the switch a second time without being told they had lost it.
//
// The rule that must not break: recall names a model, it never grants one. Access is
// re-checked against the CALLER's allowed_models every single time.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PI_SESSIONS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-memory-"));
const { remember, recall, chooseModel } = await import("../src/window-memory.js");

const SONNET = { provider: "anthropic", model_id: "claude-sonnet-4-5", display_name: "Sonnet 4.5", thinking_level: "medium" };
const GROK = { provider: "xai", model_id: "grok-4.5", display_name: "Grok 4.5", thinking_level: "high" };
const GPT = { provider: "openai", model_id: "gpt-5.6-sol", display_name: "GPT-5.6", thinking_level: "medium" };

/** A minted blob: `provider`/`model_id` are the GLOBAL DEFAULT, allowed_models the role's. */
const blob = (allowed, extra = {}) => ({
  provider: SONNET.provider,
  model_id: SONNET.model_id,
  thinking_level: "medium",
  allowed_models: allowed,
  ...extra,
});

test("nothing remembered: the global default", () => {
  const pick = chooseModel("agent-fresh", blob([SONNET, GROK]));
  assert.equal(pick.model_id, SONNET.model_id);
  assert.equal(pick.source, "default");
});

test("the model this window last used is what it reopens on", () => {
  remember("agent-1", { provider: GROK.provider, model_id: GROK.model_id, by: "chris" });
  const pick = chooseModel("agent-1", blob([SONNET, GROK]));
  assert.equal(pick.model_id, GROK.model_id, "this is the whole feature");
  assert.equal(pick.provider, GROK.provider);
  assert.equal(pick.source, "remembered");
  assert.equal(pick.thinking_level, GROK.thinking_level, "the model's own thinking level comes with it");
});

test("someone whose role lacks that model gets the default, and we say what was denied", () => {
  remember("agent-2", { provider: GROK.provider, model_id: GROK.model_id });
  const pick = chooseModel("agent-2", blob([SONNET])); // this technician has no Grok
  assert.equal(pick.model_id, SONNET.model_id);
  assert.equal(pick.source, "default");
  assert.equal(pick.remembered, "xai/grok-4.5", "so the window can explain itself");
});

test("recall cannot widen access - an empty allowed list yields the default", () => {
  remember("agent-3", { provider: GROK.provider, model_id: GROK.model_id });
  const pick = chooseModel("agent-3", blob([]));
  assert.equal(pick.source, "default");
});

test("an explicit request from the browser outranks the memory", () => {
  // AI History "Continue" with a model in the URL, or a picker choice carried into a
  // reconnect. The person in front of the window just said what they want.
  remember("agent-4", { provider: GROK.provider, model_id: GROK.model_id });
  const pick = chooseModel("agent-4", blob([SONNET, GROK], { model_requested: true }));
  assert.equal(pick.model_id, SONNET.model_id, "the blob already carries what was asked for");
  assert.equal(pick.source, "requested");
});

test("a same-id model from a different provider is not a match", () => {
  // Two providers can serve the same model id. Matching on id alone would silently switch
  // provider - and therefore which API key and which bill.
  remember("agent-5", { provider: "openrouter", model_id: GROK.model_id });
  const pick = chooseModel("agent-5", blob([GROK]));
  assert.equal(pick.source, "default");
});

test("the newest choice wins", () => {
  remember("agent-6", { provider: GROK.provider, model_id: GROK.model_id });
  remember("agent-6", { provider: GPT.provider, model_id: GPT.model_id });
  assert.equal(chooseModel("agent-6", blob([SONNET, GROK, GPT])).model_id, GPT.model_id);
});

test("a ticket key with a slash in it round-trips", () => {
  // decision:TICKET/60427 becomes a nested directory, same as the history index does.
  remember("decision:TICKET/60427", { provider: GROK.provider, model_id: GROK.model_id });
  assert.equal(recall("decision:TICKET/60427").model_id, GROK.model_id);
  assert.equal(chooseModel("decision:TICKET/60427", blob([SONNET, GROK])).source, "remembered");
});

test("who set it is recorded", () => {
  remember("agent-7", { provider: GROK.provider, model_id: GROK.model_id, by: "fred" });
  const r = recall("agent-7");
  assert.equal(r.by, "fred");
  assert.ok(r.at, "and when");
});

test("a corrupt or missing memory file is simply no memory", () => {
  assert.equal(recall("never-seen"), null);
  const dir = path.join(process.env.PI_SESSIONS_ROOT, "agent-8");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "last-model.json"), "{ not json");
  assert.equal(recall("agent-8"), null);
  assert.equal(chooseModel("agent-8", blob([SONNET])).source, "default");
});

test("incomplete writes are ignored rather than half-remembered", () => {
  remember("agent-9", { provider: "", model_id: GROK.model_id });
  remember("agent-9", { provider: GROK.provider, model_id: "" });
  remember("", { provider: GROK.provider, model_id: GROK.model_id });
  assert.equal(recall("agent-9"), null);
});

// ---- the switches ------------------------------------------------------------------
// "on refreshes whatever options are enabled (like write mode) stay enabled". Same rule as
// the model: memory NAMES a state, it never grants one - every switch is re-checked
// against the permissions of whoever is opening the window.
const { rememberSwitch, chooseSwitches } = await import("../src/window-memory.js");

/** A blob for a technician with every right, and the surface defaults. */
const full = (extra = {}) => ({
  mutate_allowed: true, autoapprove_allowed: true, autocredential_allowed: true,
  allow_mutating: false, auto_approve: false, auto_credential: false, allow_email: true,
  ...extra,
});

test("nothing remembered: the surface defaults, untouched", () => {
  const s = chooseSwitches("w-none", full());
  assert.equal(s.readonly, true, "Write mode off by default");
  assert.equal(s.autoApprove, false);
  assert.equal(s.autoCredential, false);
  assert.equal(s.allowEmail, true);
  assert.deepEqual(s.restored, []);
});

test("Write mode left ON comes back ON", () => {
  rememberSwitch("w-write", "write", true, "chris");
  const s = chooseSwitches("w-write", full());
  assert.equal(s.readonly, false, "this is the reported ask");
  assert.deepEqual(s.restored, ["Write mode"]);
});

test("Write mode left OFF stays OFF even where the surface defaults to ON", () => {
  rememberSwitch("w-off", "write", false, "chris");
  const s = chooseSwitches("w-off", full({ allow_mutating: true }));
  assert.equal(s.readonly, true, "an explicit OFF is a choice, not an absence");
});

test("every switch round-trips", () => {
  for (const [name, key] of [["auto_approve", "autoApprove"], ["auto_credential", "autoCredential"]]) {
    rememberSwitch(`w-${name}`, name, true, "chris");
    assert.equal(chooseSwitches(`w-${name}`, full())[key], true, name);
  }
  rememberSwitch("w-email", "allow_email", false, "chris");
  assert.equal(chooseSwitches("w-email", full()).allowEmail, false, "customer email OFF is remembered");
});

test("a colleague without the permission does NOT get the remembered switch", () => {
  rememberSwitch("w-perm", "write", true, "chris");
  rememberSwitch("w-perm", "auto_approve", true, "chris");
  rememberSwitch("w-perm", "auto_credential", true, "chris");
  const s = chooseSwitches("w-perm", full({
    mutate_allowed: false, autoapprove_allowed: false, autocredential_allowed: false,
  }));
  assert.equal(s.readonly, true, "read-only for someone who cannot write");
  assert.equal(s.autoApprove, false);
  assert.equal(s.autoCredential, false);
  assert.deepEqual(s.denied.sort(), ["Auto-approve", "Auto-credential", "Write mode"],
    "and the window can say why it did not come back the way they left it");
  assert.deepEqual(s.restored, []);
});

test("a denial does not erase the setting for the person who owns it", () => {
  // The colleague above opened it read-only; the original technician must still find
  // Write mode on when they come back.
  const s = chooseSwitches("w-perm", full());
  assert.equal(s.readonly, false);
  assert.equal(s.autoApprove, true);
});

test("switch memory and model memory share one record without clobbering", () => {
  remember("w-both", { provider: "xai", model_id: "grok-4.5", by: "chris" });
  rememberSwitch("w-both", "write", true, "chris");
  assert.equal(recall("w-both").model_id, "grok-4.5", "recording a switch must not lose the model");
  assert.equal(chooseSwitches("w-both", full()).readonly, false);
  remember("w-both", { provider: "anthropic", model_id: "claude-opus-5" });
  assert.equal(chooseSwitches("w-both", full()).readonly, false, "and changing the model must not lose the switches");
});

test("an unknown switch name is ignored", () => {
  rememberSwitch("w-bad", "delete_everything", true, "chris");
  assert.deepEqual(chooseSwitches("w-bad", full()).restored, []);
});
