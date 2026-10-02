// run_device_command_with_credential (owner, 2026-09-26).
//
// A command on ANY RMM agent that needs a stored login - a CLI sign-in, an API call to a
// service on that host (UniFi, a firewall, a hypervisor) - without the password ever passing
// through a model, a command line, TRMM's history or the audit log.
//
//   - The model names the IT Notebook row (company + label). The bridge reads it server-side
//     with the TECHNICIAN's own Odoo permissions.
//   - It runs a fixed TRMM script ("Pi.dev - credentialed command (bash|powershell)"). The
//     command, user, password and link go in as HEX environment variables (TRMM splits env
//     values on "=", and hex has none). The script decodes them into $PI_USER / $PI_PASS /
//     $PI_URL and evals the command. TRMM records the script name, not its environment.
//   - The output is scrubbed of the password (plain, URL-encoded, JSON-escaped, base64 of
//     user:pass) before the model sees it.
//   - Use of the login: an authorizer ruling that named this row, or the credential gate
//     (Auto-credential / the technician's click). A change to the device: the usual device
//     gate (Write mode, the judge, approval).
import { Type } from "typebox";
import { trmm } from "./trmm.js";
import { resolveLogin } from "./authorizer.js";

const SCRIPT_NAMES = {
  bash: "Pi.dev - credentialed command (bash)",
  powershell: "Pi.dev - credentialed command (powershell)",
};
let scriptIds = null;
async function scriptId(shell) {
  if (!scriptIds) {
    // The runner scripts are hidden in the TRMM script list (nobody should run them by hand).
    const all = await trmm.listScripts({ timeoutMs: 20000, query: "showHiddenScripts=true" });
    scriptIds = {};
    for (const s of Array.isArray(all) ? all : []) {
      for (const [k, n] of Object.entries(SCRIPT_NAMES)) if (s?.name === n) scriptIds[k] = s.id;
    }
  }
  return scriptIds[shell] || null;
}

const hex = (s) => Buffer.from(String(s ?? ""), "utf8").toString("hex");

// Printing the secret on purpose. The scrubber would catch it anyway; refusing says why.
const PRINTS_SECRET = new RegExp(
  "\\b(echo|printf|print|write-host|write-output|out-host|cat|tee)\\b[^|;&\\n]*\\$\\{?(env:)?PI_PASS" +
  "|\\bprintenv\\b|(^|[;&|]\\s*)env\\s*($|[;&|])|(^|[;&|]\\s*)set\\s*($|[;&|])|\\bexport\\s+-p\\b|\\bdeclare\\s+-x\\b" +
  "|\\b(get-childitem|gci|dir|ls)\\s+env:|\\$env:PI_PASS\\s*($|[;|>])|\\bPI_PASS\\b[^\\n]*>\\s*[^&\\s]", "i");
const CRED_STORE = /partner[._]secure[._]note|shared[._]totp|secure_note|res_users_apikeys/i;
// An API call that writes. mutatingMatch knows shell commands, not HTTP verbs.
const HTTP_WRITE = /(-X|--request)\s*['"]?(POST|PUT|PATCH|DELETE)\b|--data(-raw|-binary|-urlencode)?\b|\s-d\s|-Method\s+['"]?(Post|Put|Patch|Delete)\b|--json\b/i;

function scrub(raw, login) {
  let out = String(raw ?? "");
  const pass = String(login?.pass || "");
  if (pass.length >= 3) {
    const forms = new Set([
      pass, encodeURIComponent(pass), JSON.stringify(pass).slice(1, -1),
      Buffer.from(`${login.user || ""}:${pass}`).toString("base64"),
      Buffer.from(pass).toString("base64"),
    ]);
    for (const f of forms) if (f && f.length >= 3) out = out.split(f).join("[REDACTED]");
  }
  return out;
}

/**
 * @param deviceGate  async (summary) => {ok, reason}  - Write mode + judge + approval
 * @param secretGate  async (summary, opts) => {ok, reason} | null
 * @param authorizerRef () => authorizer | null
 * @param mutatingMatch (command, isWindows) => string|null
 */
export function credentialCommandTool({ hd, deviceGate, secretGate, authorizerRef, mutatingMatch, ticketRef = "" }) {
  const t = (s) => ({ content: [{ type: "text", text: s }], details: {} });
  return {
    name: "run_device_command_with_credential",
    label: "Run with stored login",
    description:
      "Run a command on ANY RMM agent that needs a stored IT Notebook login, without you ever seeing the password. " +
      "Name the row (company = exact Odoo company, label = exact row label from helpdesk_call get_partner_credentials, which shows labels with values masked). The command reads " +
      "$PI_USER, $PI_PASS and $PI_URL (PowerShell: $env:PI_USER, $env:PI_PASS, $env:PI_URL) - e.g. a CLI login or " +
      "curl -sk -c /tmp/c -H 'Content-Type: application/json' -d \"{\\\"username\\\":\\\"$PI_USER\\\",\\\"password\\\":\\\"$PI_PASS\\\"}\" https://127.0.0.1:11443/api/auth/login. " +
      "Never print the variables; the password is scrubbed from the output anyway. Changes still need Write mode and pass the judge.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "Target RMM agent_id" }),
      shell: Type.String({ description: "bash | powershell" }),
      command: Type.String({ description: "The command; use $PI_USER / $PI_PASS / $PI_URL for the login" }),
      company: Type.String({ description: "Exact Odoo company that owns the IT Notebook row" }),
      label: Type.String({ description: "Exact IT Notebook row label" }),
      timeout: Type.Optional(Type.Number({ description: "Seconds (default 60)" })),
    }),
    execute: async (_id, p, signal) => {
      const shell = String(p.shell || "bash").toLowerCase() === "powershell" ? "powershell" : "bash";
      const cmd = String(p.command || "");
      if (!/PI_(PASS|USER|URL)/.test(cmd)) return t("This command does not use $PI_USER/$PI_PASS/$PI_URL - run it with run_device_command instead.");
      if (PRINTS_SECRET.test(cmd)) return t("BLOCKED - the command would print or save the password. Pass $PI_PASS straight to the program that needs it (login flag, curl body) and never echo, log or write it.");
      if (CRED_STORE.test(cmd)) return t("BLOCKED - that touches the credential store directly. Name the row in company/label instead.");
      if (!hd) return t("The IT Notebook is not available in this window.");

      // 1. May the login be used?
      const auth = authorizerRef?.();
      const granted = auth?.credentialGranted?.(p.company, p.label);
      const login = await resolveLogin(hd, p.company, p.label).catch((e) => ({ error: String(e?.message || e) }));
      if (login.error) {
        return t(`No stored login found: ${login.error}.` +
          (login.labels?.length ? ` Rows with a password for ${login.company}: ${login.labels.join("; ")}.` : "") +
          " Use one of those exact labels.");
      }
      if (!granted) {
        if (!secretGate) return t("NOT PERMITTED - this window has no credential-approval channel.");
        const g = await secretGate(
          `USE (not reveal) the stored login "${login.label}" of ${login.company} in a command on agent ${p.agent_id}` +
            (ticketRef ? ` for ${ticketRef}` : "") + `. The AI will NOT see the password.\n\n${cmd}`,
          { privileged: true },
        );
        if (!g?.ok) return t((g?.reason || "Using that stored login was not permitted.") + " Do not retry; say what you need it for.");
      }

      // 2. Is it a change to the device?
      const win = shell === "powershell";
      if (mutatingMatch?.(cmd, win) || HTTP_WRITE.test(cmd)) {
        const g = await deviceGate(`Run a command that MODIFIES ${p.agent_id} [${shell}] using the stored login "${login.label}" (${login.company}):\n\n${cmd}`);
        if (!g?.ok) return t("REFUSED: " + (g?.reason || "the technician did not approve that change."));
      }

      // 3. Run it.
      const sid = await scriptId(shell).catch(() => null);
      if (!sid) return t(`The runner script "${SCRIPT_NAMES[shell]}" is missing in TRMM - tell the technician.`);
      const timeout = p.timeout && p.timeout > 0 ? Math.min(Number(p.timeout), 600) : 60;
      try {
        const out = await trmm.runScript(p.agent_id, {
          script: sid, args: [], timeout, output: "wait",
          env_vars: [`PI_CMD_HEX=${hex(cmd)}`, `PI_USER_HEX=${hex(login.user)}`, `PI_PASS_HEX=${hex(login.pass)}`, `PI_URL_HEX=${hex(login.link)}`],
        }, { signal });
        const raw = typeof out === "string" ? out : JSON.stringify(out);
        const clean = scrub(raw, login);
        return t(`[ran with the stored login "${login.label}" (${login.company}); password never shown]\n` +
          (clean.length > 20000 ? clean.slice(0, 20000) + `\n...[${clean.length - 20000} more chars]` : clean));
      } catch (e) {
        return t("run_device_command_with_credential failed: " + scrub(String(e?.message || e), login));
      }
    },
  };
}
