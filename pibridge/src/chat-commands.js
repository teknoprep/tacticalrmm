// chat-commands.js
//
// The window's switches, typed.
//
// WHY THIS EXISTS
// ---------------
// Write mode, Auto-approve, Auto-credential and Allow customer email are toggles in the
// browser's toolbar. A technician who has walked away from the desk and is following the
// same conversation on a phone has no toolbar - the Remote Pi app renders a chat and
// nothing else. Before this, "turn Write mode on" from a car park meant phoning someone
// at a desk, or walking back to one.
//
// So the switches get a second, textual surface. `/write on` does EXACTLY what clicking
// the toggle does, because it calls the same setter and emits the same state frame; the
// browser's toolbar moves under your finger when the phone flips it, and vice versa.
//
// PERMISSION IS NOT NEGOTIABLE HERE
// ---------------------------------
// A command is not a back door. Every switch carries the same `allowed` fact the toggle
// is built from - computed by Django when the session token was minted - and a command
// aimed at a switch this role does not carry is REFUSED with the reason, never silently
// dropped and never quietly applied. The rule is the one the rest of the bridge follows:
// receiving an instruction over a socket cannot grant the permission to obey it.
//
// A refusal is also never a lie about state: it reports what the switch actually is.
//
// WHAT IS NOT A COMMAND
// ---------------------
// Only a leading slash whose word MATCHES a command on this surface is intercepted.
// "/etc/fstab looks wrong" is a sentence about a file and goes to the model untouched -
// treating every leading slash as a command would quietly eat real questions.

/** Accepted spellings for "on" and "off". Phones autocapitalise; be forgiving. */
const TRUTHY = new Set(["on", "yes", "y", "true", "1", "enable", "enabled", "allow"]);
const FALSY = new Set(["off", "no", "n", "false", "0", "disable", "disabled", "deny", "block"]);

/**
 * Every command the bridge knows. `switchKey` entries only appear on a surface that
 * actually passed that switch in - the device chat has no customer email, and offering a
 * command that cannot work is worse than not offering it.
 */
const CATALOG = [
  {
    name: "write",
    aliases: ["w", "writemode", "write-mode", "readwrite"],
    kind: "switch",
    switchKey: "write",
    usage: "/write [on|off]",
    desc: "Write mode - let Pi change things on the device. Actions still need approval.",
  },
  {
    name: "approve",
    aliases: ["autoapprove", "auto-approve", "aa", "approvals"],
    kind: "switch",
    switchKey: "approve",
    usage: "/approve [on|off]",
    desc: "Auto-approve - stop asking before each device action.",
  },
  {
    name: "credentials",
    aliases: ["credential", "creds", "autocred", "auto-credential", "autocredential"],
    kind: "switch",
    switchKey: "credentials",
    usage: "/credentials [on|off]",
    desc: "Auto-credential - use stored IT Notebook logins without asking. Privileged rows still ask every time.",
  },
  {
    name: "email",
    aliases: ["customeremail", "customer-email", "mail"],
    kind: "switch",
    switchKey: "email",
    usage: "/email [on|off]",
    desc: "Allow Pi to email the customer from this conversation.",
  },
  {
    name: "label",
    aliases: ["name", "title"],
    kind: "label",
    usage: "/label <text>",
    desc: "Name this conversation. Also the name a paired phone shows. Blank clears it.",
  },
  {
    name: "status",
    aliases: ["state", "switches"],
    kind: "status",
    usage: "/status",
    desc: "Show every switch, the model and the label.",
  },
  {
    name: "help",
    aliases: ["?", "h", "commands"],
    kind: "help",
    usage: "/help",
    desc: "List the commands you can use in this window.",
  },
  {
    name: "compact",
    kind: "passthrough",
    usage: "/compact [note]",
    desc: "Summarise the conversation so far to free up context.",
  },
];

function parseValue(arg) {
  const a = String(arg || "").trim().toLowerCase();
  if (!a) return "toggle";
  if (TRUTHY.has(a)) return true;
  if (FALSY.has(a)) return false;
  if (a === "toggle" || a === "flip") return "toggle";
  return null; // said something, but not something we can read as on/off
}

const onOff = (v) => (v ? "ON" : "OFF");

/**
 * @param {object} o
 * @param {Record<string, {
 *   allowed: boolean,          // the role's permission - the only authority
 *   get: () => boolean,
 *   set: (v: boolean) => void, // must emit the same state frame the toolbar does
 *   denied?: string,           // why this role cannot have it
 *   on?: string, off?: string, // one line of consequence, shown after a change
 *   label?: string,
 * }>} o.switches         which switches this surface has
 * @param {{get: () => string, set: (v: string) => void}} [o.label]
 * @param {() => object} [o.info]   extra facts for /status (model, machine, ticket...)
 * @param {function} [o.log]
 */
export function makeChatCommands({ switches = {}, label = null, info = null, log = null } = {}) {
  /** Commands that exist on THIS surface. */
  const available = CATALOG.filter((c) => {
    if (c.kind === "switch") return !!switches[c.switchKey];
    if (c.kind === "label") return !!label;
    return true;
  });

  function find(word) {
    const w = String(word || "").toLowerCase();
    return available.find((c) => c.name === w || (c.aliases || []).includes(w)) || null;
  }

  function niceName(c) {
    const s = c.kind === "switch" ? switches[c.switchKey] : null;
    return s?.label || c.name;
  }

  /**
   * One sentence describing where a switch stands NOW, and what that means.
   *
   * The same words whether the switch was clicked in the toolbar or typed from a phone,
   * because the phone has no toolbar to watch: a toggle flipped at the desk has to arrive
   * in the pocket as a sentence or the two surfaces quietly disagree about what is armed.
   */
  function describe(switchKey) {
    const c = available.find((x) => x.switchKey === switchKey);
    const s = switches[switchKey];
    if (!c || !s) return "";
    const now = !!s.get();
    const note = now ? s.on : s.off;
    return `${niceName(c)} is now ${onOff(now)}.${note ? ` ${note}` : ""}`;
  }

  /**
   * Recognise a command in a prompt. Returns null for ordinary text - including a
   * leading slash that is part of a path or a question.
   */
  function parse(text) {
    const raw = String(text || "").trim();
    if (!raw.startsWith("/")) return null;
    if (raw === "/") return { cmd: find("help"), arg: "" };
    const m = /^\/([A-Za-z?][A-Za-z0-9?_-]*)\s*([\s\S]*)$/.exec(raw);
    if (!m) return null;
    const cmd = find(m[1]);
    if (!cmd) return null; // not ours: "/etc/hosts is missing" is a sentence
    return { cmd, arg: m[2].trim() };
  }

  function statusLines() {
    const out = [];
    for (const c of available) {
      if (c.kind !== "switch") continue;
      const s = switches[c.switchKey];
      out.push(`- ${niceName(c)}: ${s.allowed ? onOff(s.get()) : "not available to your role"}`);
    }
    if (label) out.push(`- Label: ${label.get() || "(none)"}`);
    for (const [k, v] of Object.entries((info && info()) || {})) {
      if (v !== undefined && v !== null && v !== "") out.push(`- ${k}: ${v}`);
    }
    return out;
  }

  function helpText() {
    const lines = ["Commands you can use here:"];
    for (const c of available) {
      const s = c.kind === "switch" ? switches[c.switchKey] : null;
      const tail = s && !s.allowed ? "  (not available to your role)" : "";
      lines.push(`  ${c.usage}${tail}`);
      lines.push(`      ${c.desc}`);
    }
    lines.push("Anything not in this list is a message for Pi, slash or no slash.");
    return lines.join("\n");
  }

  return {
    parse,
    describe,

    /** Autocomplete payload for the browser. Includes what is refused, and says so. */
    spec() {
      return available.map((c) => {
        const s = c.kind === "switch" ? switches[c.switchKey] : null;
        return {
          name: c.name,
          aliases: c.aliases || [],
          usage: c.usage,
          desc: c.desc,
          args: c.kind === "switch" ? ["on", "off"] : [],
          allowed: s ? !!s.allowed : true,
          denied: s && !s.allowed ? (s.denied || "Your role does not carry this permission.") : "",
          state: s && s.allowed ? onOff(s.get()) : "",
        };
      });
    },

    /**
     * Run a parsed command.
     * @returns {{reply: string, passthrough?: boolean, changed?: boolean}}
     */
    run(parsed, who = "browser") {
      const { cmd, arg } = parsed;

      if (cmd.kind === "passthrough") return { reply: "", passthrough: true };
      if (cmd.kind === "help") return { reply: helpText() };
      if (cmd.kind === "status") return { reply: ["This window right now:", ...statusLines()].join("\n") };

      if (cmd.kind === "label") {
        const next = arg.replace(/\s+/g, " ").trim().slice(0, 120);
        label.set(next);
        log?.("command /label", who, next || "(cleared)");
        return {
          reply: next ? `Label set to "${next}".` : "Label cleared.",
          changed: true,
        };
      }

      // switch
      const s = switches[cmd.switchKey];
      if (!s.allowed) {
        log?.(`command /${cmd.name} refused`, who, "role permission");
        return {
          reply:
            `${niceName(cmd)} is not available to your role, so it stays ${onOff(s.get())}. ` +
            (s.denied || "Ask an administrator for the permission if you need it."),
        };
      }
      const want = parseValue(arg);
      if (want === null) {
        return { reply: `Say "${`/${cmd.name}`} on" or "${`/${cmd.name}`} off". ${niceName(cmd)} is ${onOff(s.get())}.` };
      }
      const before = !!s.get();
      const next = want === "toggle" ? !before : !!want;
      if (next === before) {
        return { reply: `${niceName(cmd)} is already ${onOff(before)}.` };
      }
      s.set(next);
      const after = !!s.get();
      if (after !== next) {
        // The setter refused. Report what IS, never what was asked for.
        return { reply: `${niceName(cmd)} could not be changed; it is ${onOff(after)}.` };
      }
      log?.(`command /${cmd.name} ${onOff(after)}`, who);
      return { reply: describe(cmd.switchKey), changed: true };
    },
  };
}
