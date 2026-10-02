// LAZY CAPABILITIES (owner, 2026-09-27 - context trim).
//
// WHY. Every tool schema and every system-prompt section is re-sent on EVERY turn, and
// compaction never shrinks them (it rewrites conversation history only). Measured on
// TICKET/61871 (2026-09-27): 18,573 tokens before the model did anything, ~95% of it
// boilerplate. The worst single block was the Operator desktop: 16 operator_* tools plus a
// prompt section, sent on every ticket for ONE allowlisted workstation.
//
// WHAT. Capabilities a ticket rarely needs start OFF. One small tool, load_capability,
// turns a capability on for the rest of the chat:
//   - its tools join the active tool set (pi re-reads the set before every model call,
//     so they are callable on the very next step of the same run), and
//   - its instructions arrive as the TOOL RESULT, not in the system prompt, so the cached
//     prompt prefix never changes.
// A capability can also auto-load when a helpdesk_call operation that belongs to it is
// used (see wrapHelpdeskCall) - the rules are prepended to that first result.
//
// Authority is untouched: capability classes (capabilities.js), Write mode, approvals, the
// judge and the credential gate all still apply to a loaded tool exactly as before. This
// module only decides what is ADVERTISED.
//
// Rollback: docs/CONTEXT-TRIM-ROLLBACK.md.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const text = (s) => ({ content: [{ type: "text", text: s }], details: {} });

/**
 * @param {object} opts
 * @param {Record<string, {summary: string, tools?: object[], instructions?: string|(() => string),
 *         requires?: string[], ops?: string[]}>} opts.capabilities
 *   Only capabilities with something to offer should be passed (no tools and no text = omit).
 * @param {(msg: string) => void} [opts.log]
 */
export function makeLazyCapabilities({ capabilities, log = () => {} }) {
  const caps = Object.fromEntries(
    Object.entries(capabilities || {}).filter(([, c]) => c && ((c.tools && c.tools.length) || c.instructions)),
  );
  const loaded = new Set();
  let session = null;

  const toolNamesOf = (name) => (caps[name]?.tools || []).map((t) => t.name);
  const hiddenNames = () => {
    const out = new Set();
    for (const name of Object.keys(caps)) if (!loaded.has(name)) for (const n of toolNamesOf(name)) out.add(n);
    return out;
  };
  const instructionsOf = (name) => {
    const i = caps[name]?.instructions;
    return String((typeof i === "function" ? i() : i) || "").trim();
  };

  function applyToSession() {
    if (!session) return;
    const hidden = hiddenNames();
    const all = new Set([...session.getActiveToolNames(), ...Object.keys(caps).flatMap(toolNamesOf)]);
    session.setActiveToolsByName([...all].filter((n) => !hidden.has(n)));
  }

  /** Turn a capability (and anything it requires) on. Returns the text to show the model. */
  function enable(name, why = "") {
    const order = [];
    const visit = (n) => {
      if (!caps[n] || order.includes(n)) return;
      for (const r of caps[n].requires || []) visit(r);
      order.push(n);
    };
    visit(name);
    const fresh = order.filter((n) => !loaded.has(n));
    for (const n of fresh) loaded.add(n);
    if (fresh.length) {
      applyToSession();
      log(`capability on: ${fresh.join(", ")}${why ? ` (${why})` : ""}`);
    }
    return order.map((n) => {
      const tools = toolNamesOf(n);
      const head = `CAPABILITY "${n}" is ON${fresh.includes(n) ? "" : " (it already was)"}` +
        (tools.length ? ` - tools now available: ${tools.join(", ")}` : "") + ".";
      const body = instructionsOf(n);
      return body ? `${head}\n${body}` : head;
    }).join("\n\n");
  }

  const names = Object.keys(caps);
  const tool = names.length ? defineTool({
    name: "load_capability",
    label: "Load capability",
    description:
      "Some tools and rules are OFF until a job needs them, to keep this chat small. Load one when the work " +
      "calls for it (it stays on for the rest of the chat). Loading is free of side effects and needs no " +
      "permission. Capabilities:\n" +
      names.map((n) => `  - ${n}: ${caps[n].summary}`).join("\n"),
    parameters: Type.Object({
      name: Type.String({ description: `One of: ${names.join(", ")}` }),
    }),
    execute: async (_id, p) => {
      const name = String(p?.name || "").trim().toLowerCase();
      if (!caps[name]) return text(`Unknown capability "${p?.name}". Available: ${names.join(", ")}.`);
      return text(enable(name, "load_capability"));
    },
  }) : null;

  /**
   * Bind to the live session and hide every capability that is not loaded. If the
   * conversation being resumed already USED a capability's tools (or loaded it), it is
   * turned back on so a reconnect does not take tools away mid-job.
   */
  function attach(s) {
    session = s;
    try {
      const used = new Set();
      for (const m of s.messages || []) {
        for (const c of (Array.isArray(m?.content) ? m.content : [])) {
          if (c?.type !== "toolCall") continue;
          if (c.name === "load_capability" && caps[String(c.arguments?.name || "").toLowerCase()]) {
            used.add(String(c.arguments.name).toLowerCase());
          }
          for (const n of names) if (toolNamesOf(n).includes(c.name)) used.add(n);
        }
      }
      for (const n of used) for (const r of [...(caps[n].requires || []), n]) if (caps[r]) loaded.add(r);
      if (used.size) log(`capability restored from transcript: ${[...used].join(", ")}`);
    } catch { /* a transcript we cannot read just starts with everything off */ }
    applyToSession();
  }

  /**
   * helpdesk_call operations that belong to a capability (e.g. the TOTP ops) auto-load it
   * the first time they are used, with the capability's rules PREPENDED to that result.
   */
  function wrapHelpdeskCall(helpdeskTool) {
    if (!helpdeskTool || helpdeskTool.execute?.__lazyCaps) return;
    const opOwner = {};
    for (const n of names) for (const op of caps[n].ops || []) opOwner[op] = n;
    if (!Object.keys(opOwner).length) return;
    const original = helpdeskTool.execute;
    const wrapped = async (id, params, ...rest) => {
      const owner = opOwner[String(params?.operation || "")];
      const preface = owner && !loaded.has(owner) ? enable(owner, `helpdesk_call ${params.operation}`) : "";
      const res = await original(id, params, ...rest);
      if (!preface) return res;
      const content = Array.isArray(res?.content) ? res.content : [];
      return { ...res, content: [{ type: "text", text: `${preface}\n\n--- ${params.operation} result ---` }, ...content] };
    };
    wrapped.__lazyCaps = true;
    helpdeskTool.execute = wrapped;
  }

  return {
    tool,
    attach,
    enable,
    wrapHelpdeskCall,
    isLoaded: (n) => loaded.has(n),
    hiddenNames,
    names: () => names.slice(),
  };
}

// Operations a TICKET chat should not see in the helpdesk_call catalog. They stay CALLABLE
// (authority is capabilities.js's job, not this list's) - they are just not advertised,
// because a tool list reads to the model as a to-do list and every line is re-sent each turn.
//   - CRM/opportunity ops belong to the discovery surface.
//   - TOTP ops are listed by the "totp" capability when it loads.
// Matched by name pattern rather than a fixed list so a deployment's own naming still works.
export const TICKET_CHAT_UNADVERTISED = [/opportunit/i, /totp/i];
export const TOTP_OP_RE = /totp/i;
