// The one place every AI session is created, so the credential gate applies to all of them.
//
// Every module that starts a model session imports createAgentSession from here, not from
// the pi SDK. It wraps each custom tool (output redacted, input refused if it carries a
// registered credential value) and the system prompt. See secret-store.js for the rules.

import { createAgentSession as piCreateAgentSession } from "@earendil-works/pi-coding-agent";
import { SECRETS, guardTool } from "./secret-store.js";

/** Drop-in replacement for the pi SDK's createAgentSession. */
export async function createAgentSession(opts = {}) {
  const o = { ...opts };
  if (Array.isArray(o.customTools)) o.customTools = o.customTools.map(guardTool);
  if (o.resourceLoader && typeof o.resourceLoader.getSystemPrompt === "function") {
    const orig = o.resourceLoader.getSystemPrompt.bind(o.resourceLoader);
    o.resourceLoader.getSystemPrompt = (...a) => SECRETS.redact(orig(...a));
  }
  const created = await piCreateAgentSession(o);
  // Every model call receives the conversation history, including the model's own earlier
  // tool calls. Redact that history on the way out too, so a value the model wrote itself
  // never comes back to it. (The SDK chains transformContext, so this runs last.)
  const agent = created?.session?.agent;
  if (agent) {
    const prev = agent.transformContext;
    agent.transformContext = async (messages, signal) => {
      const base = prev ? await prev(messages, signal) : messages;
      return SECRETS.redactDeep(base);
    };
  }
  return created;
}
