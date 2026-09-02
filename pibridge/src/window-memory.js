// What state was this conversation left in?
//
// Model, Write mode, Auto-approve, Auto-credential and Allow-customer-email. One file per
// conversation, restored when the window reopens, and every one of them re-checked against
// the permissions of whoever is opening it.
//
// THE PROBLEM. Every window opened on the GLOBAL default model. A technician who switched
// to Grok for a job, then hit F5 (or came back after the socket dropped), landed back on
// Sonnet without being told - and since a model switch re-caches the whole conversation
// into the new provider, they paid for the switch twice and often did not notice they were
// no longer on the model they had chosen. `set_model` persisted nothing: the history index
// recorded the model a session STARTED on and was never updated, so the choice existed
// only in the memory of one WebSocket.
//
// SCOPE IS THE CONVERSATION, NOT THE SESSION. A refresh of the device chat does not resume
// the old session - it starts a new one against the same agent - so remembering per
// session_id would remember nothing in the exact case this exists for. The key is what the
// technician thinks of as "this window": the agent for a device chat, the ticket for a
// decision chat. That is the same key the history index already uses.
//
// ACCESS IS RE-CHECKED PER PERSON, EVERY TIME. The memory records what was used, not who
// may use it. `allowed_models` in the session blob is computed by Django for the caller,
// so a remembered model that this technician's role does not carry simply loses to the
// default. Recall can therefore never widen anyone's access: the worst it can do is name a
// model that gets ignored.
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";

// Same layout as history.js: one directory per conversation key. Decision keys contain a
// slash ("decision:TICKET/60427") and become a nested directory, which is what the history
// index already does with them.
function memoryPath(scopeKey) {
  const dir = path.join(CONFIG.sessionsRoot, String(scopeKey));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "last-model.json");
}

/** Whole remembered record for a conversation, or {} - tolerating the older
 *  model-only file shape, which had provider/model_id at the top level. */
function readRecord(scopeKey) {
  if (!scopeKey) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(memoryPath(scopeKey), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeRecord(scopeKey, rec) {
  try {
    fs.writeFileSync(memoryPath(scopeKey), JSON.stringify(rec, null, 2));
  } catch {
    /* preference only */
  }
}

/**
 * Record the state of one switch. Merges, so each setter can record only its own.
 *
 * NOTE the values stored are what the technician CHOSE, not what they were permitted.
 * Someone with write rights leaves Write mode on; a colleague without them opens the same
 * window read-only and the memory is not rewritten by that. Storing the granted value
 * instead would let one person's missing permission silently erase another's setting.
 */
export function rememberSwitch(scopeKey, name, value, by = "") {
  if (!scopeKey || !SWITCHES.includes(name)) return;
  const rec = readRecord(scopeKey);
  rec.switches = { ...(rec.switches || {}), [name]: !!value };
  rec.by = by || rec.by || "";
  rec.at = new Date().toISOString();
  writeRecord(scopeKey, rec);
}

export const SWITCHES = ["write", "auto_approve", "auto_credential", "allow_email"];

/**
 * The switch states this window should reopen with.
 *
 * Same rule as the model: memory NAMES a state, it never grants one. Every switch is
 * re-checked against this caller's permissions, so a window left in Write mode by someone
 * who has that right opens read-only for someone who does not - and says so.
 *
 * Precedence: this conversation's memory, then the person's own saved default (which
 * Django puts in the blob), then the surface default.
 */
export function chooseSwitches(scopeKey, blob = {}) {
  const remembered = readRecord(scopeKey).switches || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(remembered, k);
  const restored = [];
  const denied = [];

  const mutateAllowed = !!blob.mutate_allowed;
  let write = has("write") ? !!remembered.write : !!blob.allow_mutating;
  if (has("write") && !!remembered.write !== !!blob.allow_mutating) restored.push("Write mode");
  if (write && !mutateAllowed) {
    write = false;
    if (has("write")) { restored.pop(); denied.push("Write mode"); }
  }

  const aaAllowed = !!(blob.autoapprove_allowed);
  let autoApprove = has("auto_approve") ? !!remembered.auto_approve : !!blob.auto_approve;
  if (has("auto_approve") && remembered.auto_approve) restored.push("Auto-approve");
  if (autoApprove && !aaAllowed) {
    autoApprove = false;
    if (has("auto_approve")) { restored.pop(); denied.push("Auto-approve"); }
  }

  const acAllowed = !!(blob.autocredential_allowed);
  let autoCredential = has("auto_credential") ? !!remembered.auto_credential : !!blob.auto_credential;
  if (has("auto_credential") && remembered.auto_credential) restored.push("Auto-credential");
  if (autoCredential && !acAllowed) {
    autoCredential = false;
    if (has("auto_credential")) { restored.pop(); denied.push("Auto-credential"); }
  }

  // No role permission of its own - it is a per-window switch on the ticket surface.
  const allowEmail = has("allow_email") ? !!remembered.allow_email : blob.allow_email !== false;
  if (has("allow_email") && !allowEmail) restored.push("Customer email OFF");

  return { readonly: !write, autoApprove, autoCredential, allowEmail, restored, denied };
}

/**
 * Record the model this conversation is now using.
 * Never throws: losing this preference must not be able to break a chat.
 */
export function remember(scopeKey, { provider, model_id, group_id, by = "" } = {}) {
  if (!scopeKey || !provider || !model_id) return;
  const rec = readRecord(scopeKey);
  const next = { ...rec, provider, model_id, by, at: new Date().toISOString() };
  // null is a real choice ("single model, no group"). Omit the key to leave it alone.
  if (group_id !== undefined) next.group_id = group_id;
  writeRecord(scopeKey, next);
}

/** What this conversation last used, or null. */
export function recall(scopeKey) {
  if (!scopeKey) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(memoryPath(scopeKey), "utf8"));
    if (!raw?.provider || !raw?.model_id) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * The model this window should actually open on.
 *
 * @param scopeKey        agent id, or `decision:<ticket>`
 * @param blob            the minted session blob (carries the caller's allowed_models)
 * @returns {{ provider, model_id, thinking_level?, display_name?, source, remembered? }}
 *
 * `source` says WHY, because "why am I on this model" is the question a technician asks
 * when the answer surprises them:
 *   "requested"  - the browser asked for a specific model (AI History resume, or a picker
 *                  choice carried into a reconnect). An explicit ask always wins.
 *   "remembered" - the model this conversation was last using, and the caller may use it.
 *   "default"    - nothing remembered, or what was remembered is not available to this
 *                  person (`remembered` then carries what was denied, for the log).
 */
export function chooseModel(scopeKey, blob) {
  return chooseTarget(scopeKey, blob);
}

function groupOrchestrator(group) {
  if (!group) return null;
  return group.orchestrator
    || (group.members || group.roles || []).find((m) => m.role === "orchestrator")
    || null;
}

/**
 * Model + group this window should open on.
 *
 * Precedence:
 *   1. Explicit group_id / model_id from the browser (this click / this refresh
 *      carrying a saved picker value).
 *   2. What THIS conversation last used, if the caller may still use it.
 *   3. The default agent group, else the starred model.
 *
 * A remembered group or model that this person cannot use loses to the default.
 * Recall never widens access.
 */
export function chooseTarget(scopeKey, blob) {
  const allowed = Array.isArray(blob?.allowed_models) ? blob.allowed_models : [];
  const groups = Array.isArray(blob?.agent_groups) ? blob.agent_groups : [];
  const fallback = {
    provider: blob?.provider,
    model_id: blob?.model_id,
    thinking_level: blob?.thinking_level,
    source: "default",
    group: blob?.agent_group || null,
  };
  const findGroup = (id) => groups.find((g) => Number(g.id) === Number(id)) || null;
  const fromGroup = (group, source) => {
    const o = groupOrchestrator(group);
    if (!o) return { ...fallback, group, source };
    return {
      provider: o.provider,
      model_id: o.model_id,
      thinking_level: o.thinking_level || blob?.thinking_level,
      display_name: o.display_name,
      source,
      group,
    };
  };
  const fromAllowed = (provider, modelId, source) => {
    const match = allowed.find(
      (m) => m.model_id === modelId && (!provider || m.provider === provider),
    );
    if (!match) return null;
    return {
      provider: match.provider,
      model_id: match.model_id,
      thinking_level: match.thinking_level || blob?.thinking_level,
      display_name: match.display_name,
      source,
      group: null,
    };
  };

  // Browser named a group (including "none") — that click wins.
  if (blob?.group_requested) {
    if (blob.agent_group) return fromGroup(blob.agent_group, "requested_group");
    if (blob.model_requested) return { ...fallback, source: "requested", group: null };
  } else if (blob?.model_requested && !blob.agent_group) {
    return { ...fallback, source: "requested", group: null };
  }

  const last = recall(scopeKey);
  if (last && last.group_id != null && last.group_id !== "") {
    const g = findGroup(last.group_id);
    if (g) return fromGroup(g, "remembered_group");
    return { ...fallback, remembered: `group:${last.group_id}` };
  }
  if (last && Object.prototype.hasOwnProperty.call(last, "group_id") && last.group_id == null && last.model_id) {
    const hit = fromAllowed(last.provider, last.model_id, "remembered");
    if (hit) return hit;
    return { ...fallback, group: null, remembered: `${last.provider}/${last.model_id}` };
  }
  if (last?.model_id && !last.group_id) {
    const hit = fromAllowed(last.provider, last.model_id, "remembered");
    if (hit) return hit;
    return { ...fallback, remembered: `${last.provider}/${last.model_id}` };
  }

  if (blob.agent_group) return fromGroup(blob.agent_group, "agent_group");
  return fallback;
}
