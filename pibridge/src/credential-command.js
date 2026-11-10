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
import { randomInt, randomUUID } from "node:crypto";
import { SECRETS } from "./secret-store.js";
import { rememberGeneratedSecret } from "./generated-secrets.js";
import { auditReset } from "./reset-audit.js";

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

// reset_device_password (2026-11-10). A local account's password is reset to a NEW value that
// the bridge generates. The model names the device and the account and never sees the value.
//
//   - The new password goes in as a hex environment variable (PI_PASS), exactly like a stored
//     login. The command text refers to $PI_USER / $PI_PASS only.
//   - It is registered with the secret registry before anything runs, so it is scrubbed from
//     the output and from every later model input and outbound message.
//   - It is shown to ONE person: the technician driving this window, in a one-time dialog. It is
//     not in the transcript, not in the model's context and not sent to viewers. If no one is
//     driving the window the reset does not start.
//   - The account must change the password at its next login (chage -d 0 / logonpasswordchg).
//   - A change to the device: the usual device gate (Write mode, the judge, the technician's approval).

const RESET_TEMPLATES = {
  bash: String.raw`printf '%s:%s\n' "$PI_USER" "$PI_PASS" | chpasswd && chage -d 0 "$PI_USER" && echo "password set for $PI_USER; it must be changed at the next login"`,
  powershell: String.raw`$p = ConvertTo-SecureString $env:PI_PASS -AsPlainText -Force; Set-LocalUser -Name $env:PI_USER -Password $p; net user $env:PI_USER /logonpasswordchg:yes | Out-Null; "password set for $env:PI_USER; it must be changed at the next login"`,
};
const USERNAME_RE = /^[A-Za-z0-9._-]{1,32}$/;
const PW_LOWER = "abcdefghijkmnpqrstuvwxyz";
const PW_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PW_DIGIT = "23456789";
const PW_SYMBOL = "!@#%^*-_+"; // no "=" or ":" - they are delimiters in the digest matcher

/** A new password: 20 characters, at least one of each class, uniformly chosen (crypto RNG). */
export function generatePassword(len = 20) {
  const all = PW_LOWER + PW_UPPER + PW_DIGIT + PW_SYMBOL;
  const pick = (s) => s[randomInt(s.length)];
  const out = [pick(PW_LOWER), pick(PW_UPPER), pick(PW_DIGIT), pick(PW_SYMBOL)];
  while (out.length < len) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) { const j = randomInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join("");
}

export { RESET_TEMPLATES, USERNAME_RE };

export function passwordResetTool({
  deviceGate, reveal, runScript, getScriptId = scriptId,
  actor = {}, persist = rememberGeneratedSecret, audit = auditReset,
}) {
  const t = (s) => ({ content: [{ type: "text", text: s }], details: {} });
  const run = runScript || ((id, opts, o) => trmm.runScript(id, opts, o));
  const driving = () => !!reveal?.available?.();
  return {
    name: "reset_device_password",
    label: "Reset a local password",
    description:
      "Reset the password of a LOCAL account on a device to a new password that the bridge generates. " +
      "Use this only when the technician asks for a password reset. You will NOT see the new password: " +
      "it is shown to the technician in a dialog, and the account must change it at its next login. " +
      "Tell the technician to change it right away. Changes still need Write mode and pass the judge.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "Target RMM agent_id" }),
      shell: Type.String({ description: "bash | powershell" }),
      username: Type.String({ description: "Local account name (letters, digits, dot, dash, underscore)" }),
      reason: Type.Optional(Type.String({ description: "Why, in a few words (shown to the technician)" })),
    }),
    execute: async (_id, p, signal) => {
      const shell = String(p.shell || "bash").toLowerCase() === "powershell" ? "powershell" : "bash";
      const username = String(p.username || "").trim();
      const audited = (outcome, extra = {}) => {
        try {
          audit({ actor_email: actor.email || "", actor_name: actor.name || "", agent_id: String(p.agent_id || ""),
            username, reason: String(p.reason || ""), shell, outcome, ...extra });
        } catch (e) { console.error("reset audit failed:", e?.message || e); }
      };
      if (!USERNAME_RE.test(username)) { audited("refused_invalid_name"); return t("Refused: the account name must be letters, digits, dot, dash or underscore (max 32)."); }
      if (!driving()) { audited("refused_no_technician"); return t("NOT STARTED: no technician is driving this window to show the new password to. Ask them to take over the chat, then try again."); }
      if (!deviceGate) { audited("refused_no_gate"); return t("NOT PERMITTED - this window has no device approval channel."); }
      const template = RESET_TEMPLATES[shell];
      const g = await deviceGate(
        `RESET the local password of account "${username}" on agent ${p.agent_id} [${shell}]. ` +
          `A new password is generated by the bridge and shown only to the technician; the account must change it at next login.` +
          (p.reason ? ` Reason: ${String(p.reason).slice(0, 160)}.` : "") + `\n\n${template}`,
      );
      if (!g?.ok) { audited("refused_approval", { judge_reason: String(g?.reason || "").slice(0, 200) }); return t("REFUSED: " + (g?.reason || "the technician did not approve the password reset.")); }
      // The technician may have left while the approval was open. Check again: a password that
      // cannot be shown must not be set.
      if (!driving()) { audited("refused_no_technician_after_approval"); return t("NOT STARTED: the technician left before the reset ran. Nothing was changed."); }

      const pw = generatePassword();
      const label = `generated password: ${username} on ${p.agent_id}`;
      // Registered before anything runs: exact matching for this process, a digest for after a restart.
      SECRETS.add(label, pw);
      try { persist({ registry: SECRETS, label, value: pw }); } catch (e) { console.error("reset digest not saved:", e?.message || e); }
      const sid = await getScriptId(shell).catch(() => null);
      if (!sid) { audited("failed_no_script"); return t(`The runner script "${SCRIPT_NAMES[shell]}" is missing in TRMM - tell the technician.`); }
      let raw = "";
      try {
        const out = await run(p.agent_id, {
          script: sid, args: [], timeout: 60, output: "wait",
          env_vars: [`PI_CMD_HEX=${hex(template)}`, `PI_USER_HEX=${hex(username)}`, `PI_PASS_HEX=${hex(pw)}`, `PI_URL_HEX=${hex("")}`],
        }, { signal });
        raw = typeof out === "string" ? out : JSON.stringify(out);
      } catch (e) {
        // The value may or may not have reached the device. Say so; do not reveal it.
        audited("failed_run", { note: "the password may or may not have been set" });
        return t("reset_device_password failed; the account may or may not have changed. Ask the technician to reset it again. " + scrub(String(e?.message || e), { user: username, pass: pw }));
      }
      const login = { user: username, pass: pw };
      if (!raw.includes(`password set for ${username}`)) {
        audited("unconfirmed", { note: "the script did not confirm; the password may or may not have been set" });
        return t("The password was NOT confirmed as set: " + scrub(raw, login).slice(0, 2000) + " Ask the technician to reset it again.");
      }
      if (!driving()) {
        audited("set_not_shown", { note: "set, but no technician was driving the window to show it" });
        return t("The password was set, but no technician is driving this window to show it to. Tell the operator to reset it again.");
      }
      reveal.send({
        type: "secret_reveal",
        id: randomUUID(),
        kind: "generated_password",
        username,
        device: String(p.agent_id),
        value: pw,
        notice: "Shown once. Pass it to the account holder and ask them to change it right away. It is not stored in this chat.",
      });
      audited("set_shown", { shown_to_driver: true });
      return t(`The password for "${username}" on ${p.agent_id} was set and shown to the technician, who has been asked to change it right away. ` +
        "The value is not in this conversation and must not be repeated, saved or sent anywhere.");
    },
  };
}
