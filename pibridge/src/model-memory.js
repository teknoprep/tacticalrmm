// Which model was this conversation last using?
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

/**
 * Record the model this conversation is now using.
 * Never throws: losing this preference must not be able to break a chat.
 */
export function remember(scopeKey, { provider, model_id, by = "" } = {}) {
  if (!scopeKey || !provider || !model_id) return;
  try {
    fs.writeFileSync(
      memoryPath(scopeKey),
      JSON.stringify({ provider, model_id, by, at: new Date().toISOString() }, null, 2),
    );
  } catch {
    /* preference only */
  }
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
  const allowed = Array.isArray(blob?.allowed_models) ? blob.allowed_models : [];
  const fallback = {
    provider: blob?.provider,
    model_id: blob?.model_id,
    thinking_level: blob?.thinking_level,
    source: "default",
  };

  // An explicit request from the browser is a deliberate act by the person in front of the
  // window; it outranks anything remembered. Django has already refused any model this
  // caller may not use before it reached the blob.
  if (blob?.model_requested) return { ...fallback, source: "requested" };

  const last = recall(scopeKey);
  if (!last) return fallback;

  const match = allowed.find(
    (m) => m.model_id === last.model_id && (!last.provider || m.provider === last.provider),
  );
  if (!match) {
    // Remembered but not permitted for THIS person - the "someone else resumes it" case.
    return { ...fallback, remembered: `${last.provider}/${last.model_id}` };
  }
  return {
    provider: match.provider,
    model_id: match.model_id,
    thinking_level: match.thinking_level || blob?.thinking_level,
    display_name: match.display_name,
    source: "remembered",
  };
}
