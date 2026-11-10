// Credential gate: the process-wide secret registry and the guards that use it.
// No pi-SDK dependency here, so helpdesk and tool code can import it freely.
// The session wrapper that applies these to every model session is in session-guard.js.
//
// Every module that starts a model session imports createAgentSession from here, not from
// the pi SDK. The guard then:
//   1. wraps every custom tool: its output is redacted, and its input is refused if it
//      contains a registered credential value (in any encoding). The model should only
//      ever name a credential (company + label); the brokered tools inject the value
//      themselves, server-side, which bypasses this wrapper by design.
//   2. wraps the system prompt, so a registered value cannot reach the prompt.
// Notebook values are registered where they are read (registerNotebookSecrets), so the
// registry knows every value the bridge has ever handed to a helpdesk operation.

import { SecretRegistry, wrapToolRedaction } from "./secret-registry.js";
import { loadGeneratedSecrets } from "./generated-secrets.js";

export const SECRETS = new SecretRegistry();

// Generated-password digests from before a restart (generated-secrets.js). Loaded once per process.
try {
  loadGeneratedSecrets({ registry: SECRETS });
} catch (e) {
  console.error("generated-secrets: could not load digests:", e?.message || e);
}

const BLOCK_MSG =
  "BLOCKED - this would send a stored credential value to the tool. Name the credential " +
  "by company and label instead; the value is supplied to the brokered tool server-side.";

/** Refuse a tool call whose arguments carry a registered secret value, in any encoding. */
export function guardToolInput(tool) {
  if (!tool || typeof tool.execute !== "function" || tool.execute.__inputGuarded) return tool;
  const original = tool.execute;
  const guarded = async (id, params, ...rest) => {
    const blob = typeof params === "string" ? params : JSON.stringify(params ?? {});
    if (SECRETS.redact(blob) !== blob) {
      return { content: [{ type: "text", text: BLOCK_MSG }], details: { blocked: true } };
    }
    return original(id, params, ...rest);
  };
  guarded.__inputGuarded = true;
  tool.execute = guarded;
  return tool;
}

/** JSON for anything the bridge writes to disk: registered values are replaced before it is stored. */
export function redactedJSON(value, indent) {
  return JSON.stringify(SECRETS.redactDeep(value), null, indent);
}

/** Redaction on output, DLP on input. Idempotent. */
export function guardTool(tool) {
  return wrapToolRedaction(guardToolInput(tool), SECRETS);
}

/** Register every value of a notebook read (all columns except the visible ones). */
export function registerNotebookSecrets(result) {
  const SHOW = /^(info|label|name|system|description|service|link|url|portal|address|host|site|user|username|user ?name|login|email|e-?mail|admin user|account)$/i;
  if (!result || !Array.isArray(result.notebooks)) return 0;
  let n = 0;
  for (const nb of result.notebooks) {
    const cols = Array.isArray(nb?.columns) ? nb.columns : [];
    const rows = Array.isArray(nb?.rows) ? nb.rows : [];
    const company = nb?.company || "?";
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const label = String(row[0] ?? "").trim() || "row";
      row.forEach((cell, i) => {
        const h = String(cols[i] ?? "").trim();
        if (!h || SHOW.test(h)) return;
        n += SECRETS.add(`${company} / ${label} / ${h}`, String(cell ?? ""));
      });
    }
  }
  return n;
}
