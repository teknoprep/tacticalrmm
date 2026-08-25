import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import crypto from "node:crypto";
import { trmm } from "./trmm.js";
import { loadHelpdesk } from "./helpdesk-runtime.js";
import { loadSales } from "./sales-runtime.js";
import { gateOp, allowedOps, CAPS_MODE } from "./capabilities.js";
let operatorPlugin = null;
try {
  operatorPlugin = await import("file:///opt/pi-ai-operator/integrations/pi-trmm-bridge/operator-tools.js");
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") console.warn("Pi AI Operator plugin unavailable:", error?.message || error);
}

// ---- Tool result size caps --------------------------------------------------
// Unbounded tool output is what silently kills a chat. Measured on a real stalled
// session (2026-08-04, agent AVgiDUib...): one 7-day get_event_logs returned
// 750 KB / 3,351 events, a second 693 KB, and get_device_details 246 KB - of which
// `services` (124 KB), `wmi_detail` (62 KB) and `all_timezones` (10 KB, pure noise)
// were 80%. A parallel batch of 7 such tools pushed ~609k tokens into a 200k-token
// context window, so the turn ended with stopReason="length" before the model wrote
// a single word - and billed $7.52. Every bulk tool now SHAPES its payload
// (actionable fields first) and HARD-CAPS the bytes it may return.
const MAX_TOOL_RESULT_BYTES = Number(process.env.PI_MAX_TOOL_RESULT_BYTES || 60000);

/** Truncate a string to a byte budget with an explicit, model-readable marker. */
function capString(s, maxBytes = MAX_TOOL_RESULT_BYTES, what = "output") {
  const str = String(s ?? "");
  const full = Buffer.byteLength(str, "utf8");
  if (full <= maxBytes) return str;
  let out = str.slice(0, maxBytes);
  while (out.length && Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -512);
  return (
    out +
    `\n\n[TRUNCATED by pi-trmm-bridge: ${what} was ${full} bytes, cap is ${maxBytes}. ` +
    `Do NOT retry the same broad call - narrow it (fewer days, a filter, a specific name), ` +
    `or use run_command_on_device with capture_as to hold large output out of context.]`
  );
}

/**
 * Serialize a value under a byte budget. Arrays are truncated ELEMENT-WISE so the
 * model always receives VALID JSON plus an explicit "showing X of Y" line, which is
 * far more useful than JSON cut mid-token.
 */
function capJson(value, { maxBytes = MAX_TOOL_RESULT_BYTES, what = "result" } = {}) {
  if (Array.isArray(value)) {
    const total = value.length;
    let keep = total;
    let json = JSON.stringify(value, null, 2);
    while (keep > 0 && Buffer.byteLength(json, "utf8") > maxBytes) {
      keep = Math.max(0, Math.floor(keep * 0.7) - 1);
      json = JSON.stringify(value.slice(0, keep), null, 2);
    }
    if (keep < total) {
      return (
        `NOTE: showing ${keep} of ${total} ${what} entries (capped at ${maxBytes} bytes). ` +
        `Narrow the request (filter/fewer days) to see the rest - do not re-run this call as-is.\n\n` +
        json
      );
    }
    return json;
  }
  return capString(JSON.stringify(value, null, 2), maxBytes, what);
}

// Top-level agent fields that are pure bulk and never worth spending context on.
// `wmi_detail` and the full `services` table are reachable deliberately via
// run_command_on_device when a specific question actually needs them.
const AGENT_BULK_FIELDS = ["all_timezones", "wmi_detail", "services"];

/**
 * Shape a TRMM agent record for the model: keep every actionable field, replace the
 * three bulk fields with compact summaries. Stopped-but-Automatic services are the
 * only part of the 289-row service table that is diagnostically interesting, so that
 * is what survives.
 */
function shapeAgentDetails(agent) {
  const a = { ...(agent || {}) };
  const notes = [];
  const services = Array.isArray(a.services) ? a.services : null;
  const wmi = a.wmi_detail;
  for (const k of AGENT_BULK_FIELDS) delete a[k];

  // Same rule as get_device_hardware: TRMM answers "unknown" / "error getting
  // make/model" / OEM filler when it has nothing, and a model repeating that to a
  // customer as an asset tag is worse than saying "not recorded". null means unknown.
  for (const k of ["serial_number", "make_model"])
    if (k in a) a[k] = hwValue(a[k]);

  if (services) {
    const auto = services.filter(
      (s) => /auto/i.test(String(s?.start_type || s?.startType || "")) &&
        !/running/i.test(String(s?.status || "")),
    );
    a.services_summary = {
      total: services.length,
      running: services.filter((s) => /running/i.test(String(s?.status || ""))).length,
      automatic_but_not_running: auto.slice(0, 40).map((s) => ({
        name: s?.name,
        display_name: s?.display_name || s?.displayName,
        status: s?.status,
        start_type: s?.start_type || s?.startType,
      })),
      automatic_but_not_running_count: auto.length,
    };
    notes.push(
      `full 'services' table (${services.length} rows) omitted to protect context - ` +
        `query a specific service with run_command_on_device (e.g. Get-Service <name>)`,
    );
  }
  if (wmi) {
    notes.push(
      "'wmi_detail' omitted to protect context - if you need a hardware/WMI fact, ask for " +
        "that one class with run_command_on_device (e.g. Get-CimInstance Win32_PhysicalMemory)",
    );
  }
  notes.push("'all_timezones' omitted (UI data, no diagnostic value)");
  a._omitted_for_context = notes;
  return a;
}

// Exported for the size-cap regression test (test/tool-caps.test.mjs).
export { capString, capJson, shapeAgentDetails };

// ---- Hardware inventory (serial / make / model) ------------------------------
// TRMM keeps hardware facts in Agent.wmi_detail and exposes them as serial_number /
// make_model on the agent LIST endpoint (AgentTableSerializer). They are STORED, so
// they are readable for devices that are offline/decommissioned - no shell, no live
// WMI, no UI login. Verified 2026-08-12: 1085 of 1182 agents carry a serial, incl.
// agents last seen in 2024. The detail endpoint does NOT carry serial_number, which
// is why get_device_details alone could never answer "what's this machine's serial".
// Junk that OEMs and TRMM itself put in these fields. A model that reports "To Be
// Filled By O.E.M." as a serial number to a customer is worse than one that says
// "not recorded", so every one of these becomes null.
const HW_EXACT_JUNK = /^(unknown|error|none|null|n\/?a|na|nil|invalid|default|0+|-+|x+|\.+)$/i;
const HW_JUNK_PREFIX =
  /^(to be filled|filled by o\.?e\.?m|default string|system serial number|chassis serial|base board|not specified|not applicable|no asset|no dimm|error getting|unknown)/i;
/** Placeholder hardware strings become null - a model must not report "unknown" as fact. */
function hwValue(s) {
  const v = String(s ?? "").trim();
  if (!v || HW_EXACT_JUNK.test(v) || HW_JUNK_PREFIX.test(v)) return null;
  return v;
}

// The fleet list is ~1.3 MB / ~1.5s. It never reaches a model (rows are slimmed
// below), but a chat asking several inventory questions in a row should not refetch
// it each time. Short TTL so a freshly-onboarded device shows up quickly.
const HW_CACHE_TTL_MS = 60_000;
let _hwCache = { at: 0, rows: null };
async function fleetAgents(signal) {
  const now = Date.now();
  if (_hwCache.rows && now - _hwCache.at < HW_CACHE_TTL_MS) return _hwCache.rows;
  const rows = await trmm.listAgents({}, { signal });
  if (Array.isArray(rows)) _hwCache = { at: now, rows };
  return Array.isArray(rows) ? rows : [];
}

/**
 * READ-ONLY hardware/asset inventory tool. Shared by the triage, decision-chat and
 * report surfaces: none of them could see a serial number before, because the only
 * hardware-bearing tools required an ONLINE device (run_device_command) or a
 * device-scoped session (get_device_details).
 */
function deviceHardwareTool() {
  const text = (s) => ({ content: [{ type: "text", text: s }], details: {} });
  return defineTool({
    name: "get_device_hardware",
    label: "Get device hardware (serial / make / model)",
    description:
      "Hardware/asset inventory for devices: SERIAL NUMBER, make/model, OS, client, site, " +
      "status, last seen, last user. Reads the hardware details TRMM already has STORED, so " +
      "it WORKS FOR OFFLINE DEVICES - no shell, no WMI query, no reboot needed. Filter by " +
      "client_name, hostname_contains or agent_ids (from find_devices). Use " +
      "only_missing_serial=true to list devices whose serial TRMM never captured (those are " +
      "the only ones that need a live query). serial/make_model come back null when TRMM " +
      "holds no real value - report null as unknown, never invent one.",
    parameters: Type.Object({
      client_name: Type.Optional(Type.String({ description: "RMM client name or part of it (e.g. 'BlueCloud')" })),
      hostname_contains: Type.Optional(Type.String({ description: "Hostname substring (e.g. 'pve')" })),
      agent_ids: Type.Optional(Type.Array(Type.String(), { description: "Specific agent_ids (from find_devices)" })),
      only_missing_serial: Type.Optional(Type.Boolean({ description: "Only devices with no stored serial" })),
      limit: Type.Optional(Type.Number({ description: "Max rows to return (default 150, max 1000; auto-reduced to fit the size cap)" })),
      offset: Type.Optional(Type.Number({ description: "Skip this many matches - page through a big client" })),
    }),
    execute: async (_id, p, signal) => {
      try {
        const all = await fleetAgents(signal);
        const cn = String(p.client_name || "").trim().toLowerCase();
        const hn = String(p.hostname_contains || "").trim().toLowerCase();
        const ids = new Set(Array.isArray(p.agent_ids) ? p.agent_ids : []);
        const matches = all.filter((a) =>
          (!cn || String(a.client_name || "").toLowerCase().includes(cn)) &&
          (!hn || String(a.hostname || "").toLowerCase().includes(hn)) &&
          (!ids.size || ids.has(a.agent_id)) &&
          (!p.only_missing_serial || !hwValue(a.serial_number)));
        if (!matches.length) {
          const clients = [...new Set(all.map((a) => a.client_name).filter(Boolean))].sort();
          return text(capJson({
            matched: 0,
            note: "No device matched. Check the client name against known_clients, or search by " +
                  "hostname_contains instead.",
            known_clients: clients,
          }, { what: "device hardware" }));
        }
        const offset = Math.max(0, Number(p.offset) || 0);
        const limit = Math.min(Math.max(1, Number(p.limit) || 150), 1000);
        const page = matches.slice(offset, offset + limit);
        const row = (a) => ({
          hostname: a.hostname,
          serial: hwValue(a.serial_number),
          make_model: hwValue(a.make_model),
          client: a.client_name,
          site: a.site_name,
          os: a.operating_system,
          plat: a.plat,
          type: a.monitoring_type,
          status: a.status,
          last_user: a.logged_username && a.logged_username !== "-" ? a.logged_username : null,
          last_seen: a.last_seen,
          agent_id: a.agent_id,
        });
        const withSerial = matches.filter((a) => hwValue(a.serial_number)).length;
        const payload = (devices) => ({
          matched: matches.length,
          showing: `${offset + 1}-${offset + devices.length} of ${matches.length}`,
          with_serial: withSerial,
          missing_serial: matches.length - withSerial,
          source: "TRMM stored hardware details (valid for offline devices; may be as old as last_seen)",
          next_offset: offset + devices.length < matches.length ? offset + devices.length : null,
          devices,
        });
        // Fit the PAGE to the byte cap by dropping whole ROWS (measuring exactly how
        // capJson will serialise it), so the model always gets VALID JSON plus an honest
        // next_offset to page with - never JSON cut mid-token.
        let devices = page.map(row);
        while (devices.length > 1 &&
               Buffer.byteLength(JSON.stringify(payload(devices), null, 2), "utf8") > MAX_TOOL_RESULT_BYTES)
          devices = devices.slice(0, Math.max(1, Math.floor(devices.length * 0.8) - 1));
        return text(capJson(payload(devices), { what: "device hardware" }));
      } catch (e) {
        return text(`get_device_hardware failed: ${e?.message || e}`);
      }
    },
  });
}

/** System-prompt blurb from the Operator plugin (empty when disabled/unavailable). */
export function operatorPromptSection(operatorPolicy) {
  try {
    return operatorPlugin?.operatorPromptSection?.(operatorPolicy) || "";
  } catch {
    return "";
  }
}

// --- Web research (the bridge host has internet) -----------------------------
function _stripHtml(h) {
  return String(h || "")
    .replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
async function _webSearch(query, n = 6) {
  const res = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PiDevAI/1.0)" },
  });
  const html = await res.text();
  const links = [], snips = [];
  let m;
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = linkRe.exec(html))) {
    let url = m[1];
    const u = url.match(/uddg=([^&]+)/);
    if (u) url = decodeURIComponent(u[1]);
    links.push({ url, title: _stripHtml(m[2]) });
  }
  while ((m = snipRe.exec(html))) snips.push(_stripHtml(m[1]));
  return links.slice(0, n).map((l, i) => ({ ...l, snippet: snips[i] || "" }));
}
async function _webFetch(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; PiDevAI/1.0)" }, redirect: "follow" });
  let html = await res.text();
  html = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  return _stripHtml(html).slice(0, 9000);
}
export function webTools() {
  const text = (s) => ({ content: [{ type: "text", text: s }], details: {} });
  const web_search = defineTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web for how-to steps, vendor documentation, or error lookups (e.g. 'how to " +
      "accept a Google Drive shared link'). Returns top results with titles, URLs and snippets; " +
      "use web_fetch to read a promising page before you write instructions.",
    parameters: Type.Object({ query: Type.String({ description: "Search query" }) }),
    execute: async (_id, p) => {
      try {
        const r = await _webSearch(p.query);
        return text(r.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join("\n\n") || "(no results)");
      } catch (e) { return text("web_search failed: " + (e?.message || e)); }
    },
  });
  const web_fetch = defineTool({
    name: "web_fetch",
    label: "Fetch web page",
    description: "Fetch a URL and return its readable text (to read a how-to/doc page found via web_search).",
    parameters: Type.Object({ url: Type.String({ description: "URL to fetch" }) }),
    execute: async (_id, p) => {
      try { return text(await _webFetch(p.url)); }
      catch (e) { return text("web_fetch failed: " + (e?.message || e)); }
    },
  });
  return [web_search, web_fetch];
}

// Best-effort classification of a shell/powershell command as "mutating" (i.e.
// it changes the system) so a READ-ONLY session can refuse it. This is a
// guardrail, not a sandbox: arbitrary shell can be obfuscated. The hard
// guarantee for read-only sessions is at the TOOL level (write-only tools are
// removed); this adds a strong deterrent for run_command_on_device.
const NIX_MUTATE = [
  /\brm\b/, /\brmdir\b/, /\bunlink\b/, /\bshred\b/, /\bdd\b/, /\bmkfs\.?\w*/,
  /\bfdisk\b/, /\bparted\b/, /\bwipefs\b/, /\bmkswap\b/, /\btruncate\b/,
  /\bchmod\b/, /\bchown\b/, /\bchattr\b/, /\bsetfacl\b/,
  /\bmv\b/, /\bcp\b/, /\bln\b/, /\btee\b/,
  /\bsystemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask|kill)/,
  /\bservice\s+\S+\s+(start|stop|restart|reload)/, /\binvoke-rc\.d\b/,
  /\b(apt|apt-get|aptitude|dpkg|yum|dnf|rpm|zypper|apk|snap|flatpak|pip|pip3|npm|yarn|gem|cargo)\b[^\n]*\b(install|remove|purge|erase|autoremove|upgrade|dist-upgrade|add|del|delete|uninstall)\b/,
  /\b(reboot|shutdown|halt|poweroff|telinit|init)\b/,
  /\b(kill|pkill|killall)\b/,
  /\b(useradd|userdel|usermod|groupadd|groupdel|passwd|chpasswd|adduser|deluser)\b/,
  /\bcrontab\b/, /\b(iptables|ip6tables|nft|ufw|firewall-cmd)\b/,
  /\b(mount|umount|swapon|swapoff)\b/,
  /\bsed\b[^|]*\s-\w*i/, /\bperl\b[^|]*\s-\w*i/,
  /\beval\b/, /\|\s*(sh|bash|zsh)\b/,
  /\b(qm|pct|pvesm|pveceph|ha-manager|pvecm)\s+(create|destroy|set|start|stop|delete|remove|add|migrate|rollback)/,
];
const WIN_MUTATE = [
  /\bRemove-\w+/i, /\bSet-\w+/i, /\bNew-\w+/i, /\bStop-\w+/i, /\bRestart-\w+/i,
  /\bSuspend-\w+/i, /\bStart-(Service|Process|ScheduledTask)\b/i,
  /\bDisable-\w+/i, /\bEnable-\w+/i, /\bClear-\w+/i, /\bRename-\w+/i,
  /\bMove-\w+/i, /\bCopy-Item\b/i, /\b(Install|Uninstall|Update|Register|Unregister)-\w+/i,
  /\b(Add|Set)-Content\b/i, /\bOut-File\b/i, /\bExport-\w+/i,
  /\bFormat-Volume\b/i, /\b(Restart|Stop)-Computer\b/i,
  /\b(del|erase|rd|rmdir|move|ren|rename|xcopy|robocopy|copy)\b/i,
  /\breg(\.exe)?\s+(add|delete|import)\b/i,
  /\bsc(\.exe)?\s+(create|config|delete|stop|start|failure)\b/i,
  /\bnet(\.exe)?\s+(stop|start|user|localgroup|group)\b/i,
  /\b(shutdown|bcdedit|diskpart|fsutil|takeown|icacls|cacls|attrib)\b/i,
  /\bformat\b(?!-)/i, /\bschtasks\b[^\n]*\/(create|delete|change)/i,
  /\bmsiexec\b/i, /\b(winget|choco)\s+(install|uninstall|upgrade|remove)\b/i,
];
function mutatingMatch(command, isWindows) {
  for (const re of isWindows ? WIN_MUTATE : NIX_MUTATE) {
    const m = command.match(re);
    if (m) return m[0];
  }
  return null;
}

// PRIVILEGED (identity/access) command patterns - creating/removing users, group/
// permission changes, licenses, mailbox delegates, password/MFA resets. These require
// an APPROVED support contact's authorization (never auto-run for an unauthorized
// requester), enforced deterministically in run_device_command.
const PRIVILEGED_PATTERNS = [
  // Active Directory
  /\bnew-aduser\b/i, /\bremove-aduser\b/i, /\bset-aduser\b/i, /\benable-adaccount\b/i, /\bdisable-adaccount\b/i,
  /\bnew-adgroup\b/i, /\b(add|remove)-adgroupmember\b/i, /\bset-adaccountpassword\b/i, /\bunlock-adaccount\b/i,
  // Local accounts / groups
  /\bnew-localuser\b/i, /\bremove-localuser\b/i, /\bset-localuser\b/i, /\b(add|remove)-localgroupmember\b/i,
  /\bnet\s+user\s+\S+.*\/(add|delete|active)/i, /\bnet\s+localgroup\b.*\/(add|delete)/i,
  /\bdsadd\b/i, /\bdsrm\b/i, /\bdsmod\s+user\b/i,
  // Microsoft 365 / Entra / Exchange Online
  /\bnew-msoluser\b/i, /\bset-msoluser(password)?\b/i, /\bnew-mguser\b/i, /\b(update|set)-mguser\b/i,
  /\bnew-azureaduser\b/i, /\bset-azureaduser\b/i, /\b(add|remove)-azureadgroupmember\b/i, /\b(add|remove)-mggroupmember\b/i,
  /\bnew-mailbox\b/i, /\bset-mailbox\b/i, /\b(add|remove)-mailboxpermission\b/i, /\b(add|remove)-recipientpermission\b/i,
  /\bset-msolusslicense\b/i, /\bset-mguserlicense\b/i, /\b(set|update)-mguserlicense\b/i,
  // Passwords / MFA (someone else's)
  /\b(set|reset)-\w*password\b/i, /\bset-msolusermfa\b/i, /\b(set|update)-mfa\b/i,
  // ACL / share permission changes
  /\bset-acl\b/i, /\bicacls\b.*\/(grant|deny|remove)/i, /\bcacls\b.*\/(g|d|e)/i,
];
// Mask anything that looks like a secret before it reaches an approval prompt, an audit
// line or the chat transcript. The technician must see WHICH fields are being written and
// to which row, and must NOT need the password splashed across the conversation to find
// out. (The owner's own words when asking for this feature: "I did not put the password in
// the ticket note - secrets stay out of chatter.")
//
// Keyed on the FIELD NAME, not the value: guessing at values is how a redactor misses the
// one that mattered, and an IT Notebook column is named by a human who intended it to be
// read - "Admin Pass", "api_key", "Secret".
const SECRETISH_FIELD = /(pass|pwd|secret|token|api[_\s-]?key|private[_\s-]?key|credential|passphrase)/i;
export function describeSecretFields(fields) {
  const out = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "object") continue;
    const s = String(v);
    out.push(SECRETISH_FIELD.test(k)
      ? `  ${k} = ******** (${s.length} chars, hidden)`
      : `  ${k} = ${s.length > 120 ? s.slice(0, 120) + "\u2026" : s}`);
  }
  return out.join("\n");
}

/**
 * Build everything the technician and the audit trail need for an IT Notebook write:
 * the approval prompt (with secret-looking columns masked) and the column names for the
 * provenance note. Pure and exported so it is testable - the inline version of this was
 * where a ReferenceError hid until a technician hit it in production.
 *
 * Accepts the shapes the model actually sends: a named-column object under `row`
 * (preferred), `fields`, or a positional `values` array.
 */
export function notebookWriteSummary({ operation = "", args = {}, params = {}, ticketRef = "" } = {}) {
  const A = args || {};
  const P = params || {};
  const pick = (...names) => {
    for (const n of names) {
      if (A[n] !== undefined && A[n] !== null && A[n] !== "") return A[n];
      if (P[n] !== undefined && P[n] !== null && P[n] !== "") return P[n];
    }
    return undefined;
  };

  const named = pick("row", "fields");
  const values = pick("values");
  const who = pick("company_name", "partner_id") ?? "this company";
  const notebook = pick("notebook_id", "notebook") ?? "IT Notebook";
  // What identifies the row being touched, for the prompt and the note.
  const rowRef = pick("row_id", "match_info", "match_value") ??
    (named && typeof named === "object" && !Array.isArray(named) ? named.Info || named.info : "") ?? "";

  let shown = "";
  let columns = [];
  if (named && typeof named === "object" && !Array.isArray(named)) {
    shown = describeSecretFields(named);
    columns = Object.keys(named).filter((k) => {
      const v = named[k];
      return v !== undefined && v !== null && v !== "" && typeof v !== "object";
    });
  } else if (Array.isArray(values)) {
    // Positional form: there are no column names to key masking on, so mask every
    // non-empty value. A technician approving a positional write is approving the row,
    // and guessing which slot is the password is exactly how one gets printed.
    shown =
      `  ${values.length} positional values (all hidden - a positional write has no column\n` +
      `  names to tell a password from a hostname, so none are shown):\n` +
      values
        .map((v, i) => {
          const s = v == null ? "" : String(v);
          return `  [${i}] = ${s ? `******** (${s.length} chars, hidden)` : "(blank)"}`;
        })
        .join("\n");
    columns = [`${values.length} positional values`];
  }

  const del = /delete|remove|unlink/i.test(String(operation));
  const verb = del ? "DELETE a row from" : rowRef ? "SAVE (create or update) a row in" : "SAVE a new row to";
  // `notebook` falls back to the words "IT Notebook", so do not print them twice.
  const label = String(notebook) === "IT Notebook" ? "the IT Notebook" : `IT Notebook ${notebook}`;
  const summary =
    `${verb} ${label} for ${who}` +
    `${rowRef ? ` (row: ${rowRef})` : ""}${ticketRef ? `, on ${ticketRef}` : ""}:\n\n` +
    `${shown || "(no field values supplied)"}\n\n` +
    `This changes what the stored documentation says. Passwords are hidden above.`;

  return { summary, columns, rowRef: rowRef || "", notebook, who, operation: String(operation) };
}

export function privilegedMatch(command) {
  const s = String(command || "");
  return PRIVILEGED_PATTERNS.some((re) => re.test(s));
}

// Builds the device-scoped toolset.
//
// Single-machine mode (machines.length === 1): identical behavior/shape to the
// original implementation - tools are hard-bound to the one agentId and have
// NO `machine` parameter.
//
// Multi-machine mode (machines.length > 1): every device-facing tool gains a
// REQUIRED `machine` parameter (the hostname label shown in the system prompt)
// so the model explicitly targets one of the session's machines per call. The
// model can never reach a machine outside the session's set.
//
// Mutating tools go through `gate(summary)` which resolves to true (approved)
// or false (denied).
// ---- FILE CAPTURE STORE -----------------------------------------------------------
// WHY THIS EXISTS. The only route off a managed device is a command's stdout, and stdout
// normally comes back as the tool RESULT - i.e. straight into the model's context. A
// 500KB export therefore cost ~130k tokens to read and another ~130k to pass on as a
// tool argument, so large files were simply impossible to send.
//
// A capture keeps the bytes HERE and returns only a receipt (size, lines, sha256,
// first/last line). The model references the capture by name to attach or email it, so a
// 50MB file costs the same tokens as a 5KB one - and the model cannot truncate or
// fabricate what it never handled.
//
// One store per toolset build, i.e. per session: captures cannot leak between sessions.
const CAPTURE_MAX_BYTES = 64 * 1024 * 1024;

function makeCaptureStore() {
  const captures = new Map();
  let total = 0;
  return {
    names: () => [...captures.keys()],
    get: (name) => captures.get(String(name || "")),
    put(name, data, from) {
      const bytes = Buffer.byteLength(data, "utf8");
      if (total + bytes > CAPTURE_MAX_BYTES)
        return { error: `capture store full (${total} bytes held); nothing captured` };
      const lines = data.length ? data.split(/\r?\n/) : [];
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      const sha256 = crypto.createHash("sha256").update(data, "utf8").digest("hex");
      if (captures.has(name)) total -= captures.get(name).bytes;
      captures.set(name, { data, bytes, lines: lines.length, sha256, from, at: Date.now() });
      total += bytes;
      return {
        name, bytes, lines: lines.length, sha256,
        first_line: lines.length ? lines[0].slice(0, 200) : "",
        last_line: lines.length > 1 ? lines[lines.length - 1].slice(0, 200) : "",
      };
    },
  };
}

// The receipt handed back instead of the file content.
function captureReceipt(rec, extra = "") {
  return (
    `Captured ${rec.bytes} bytes (${rec.lines} lines) as "${rec.name}" - the content is held by ` +
    `the bridge and was NOT loaded into your context.\n` +
    `sha256: ${rec.sha256}\nfirst line: ${rec.first_line}\n` +
    (rec.last_line ? `last line: ${rec.last_line}\n` : "") +
    `Reference it by name to send it${extra}. Do not re-run the command to read the contents; ` +
    `if you need to inspect it, run a separate command printing only a small sample (e.g. head).`
  );
}

export function buildTools({
  machines: machinesIn,
  // legacy single-machine call shape
  agentId,
  plat,
  gate,
  includeReport = false,
  // Whether this session is allowed to write at all (role/super). When false the
  // write-only tools are removed entirely (hard read-only).
  mutateAllowed = true,
  // Live read-only state. Even when mutateAllowed, the operator can start (and
  // toggle) read-only; write tools + destructive run_command refuse while true.
  // Back-compat: callers may pass `readonly` (fixed) instead.
  readonly = undefined,
  isReadonly = undefined,
  jobRef = null,
  // Global-Settings-defined ticketing API: {base_url, api_key}. When set, the
  // generic helpdesk_api_request tool is exposed (and the legacy env-based
  // create_ticket is not). The admin HELPDESK POLICY prompt documents usage.
  helpdeskApi = null,
  helpdeskCode = "",
  // WHICH capability surface this toolset is for (see capabilities.js). Required in
  // practice: an unrecognised surface denies every mutating helpdesk class, so a new
  // call site cannot quietly inherit full ticket authority by omitting it.
  surface = null,
  // Classes explicitly authorised for THIS run by whoever configured it (e.g. an AI task
  // whose author declared a reply register). Intersected with capabilities.GRANTABLE, so
  // this can only ever add `customer` - never closing or routing authority.
  grants = [],
  // The credential-read policy (server.js makeCredentialGate). Kept SEPARATE from `gate`
  // on purpose: `gate` here is the device-approval helper, which returns true when
  // Auto-approve is on, and Auto-approve has never covered the customer's stored logins.
  // Absent, a `secret` operation is refused outright rather than falling back to `gate` -
  // a missing credential policy must not silently downgrade to the device one.
  secretGate = null,
  // Product code verifies the technician's OWN chat text before global/shared KB
  // authoring. The model cannot grant this to itself by claiming it was asked.
  globalKnowledgeAuthorisation = () => null,
  // Optional standalone Pi AI Operator policy injected by Django after applying the
  // global machine allowlist and this technician's per-agent permissions.
  operatorPolicy = null,
  operatorActor = "",
  // Session tech identity — used by send_email so SMTP From can be the human, not a bot.
  actorEmail = "",
  actorName = "",
}) {
  if (readonly !== undefined && isReadonly === undefined) {
    // fixed read-only (headless): map onto the new model
    mutateAllowed = !readonly;
    isReadonly = () => readonly;
  }
  if (isReadonly === undefined) isReadonly = () => !mutateAllowed;
  const hardReadonly = !mutateAllowed;
  const machines = (machinesIn && machinesIn.length
    ? machinesIn
    : [{ agentId, hostname: "", plat, role: "" }]
  ).map((m) => ({
    agentId: m.agentId,
    hostname: m.hostname || "",
    plat: m.plat,
    role: m.role || "",
    // preserve device_facts so the helpdesk context (deviceUrl for the ticket
    // "jump to device" link, client/site) survives into hdContext below.
    facts: m.facts || null,
  }));
  const multi = machines.length > 1;

  // Unique label per machine (hostname, deduped with #N when two machines
  // share a hostname). These labels are what the model passes as `machine`.
  const seen = new Map();
  for (const m of machines) {
    const base = (m.hostname || m.agentId).trim();
    const n = (seen.get(base.toLowerCase()) || 0) + 1;
    seen.set(base.toLowerCase(), n);
    m.label = n === 1 ? base : `${base}#${n}`;
  }
  const byLabel = new Map(machines.map((m) => [m.label.toLowerCase(), m]));
  const byAgentId = new Map(machines.map((m) => [m.agentId, m]));
  const labels = machines.map((m) => m.label);

  const anyWindows = machines.some((m) => m.plat === "windows");
  const allWindows = machines.every((m) => m.plat === "windows");
  const isWindows = machines[0].plat === "windows"; // single-machine semantics

  const verdict = { status: null, summary: "", details: "" };

  const text = (s) => ({ content: [{ type: "text", text: s }], details: {} });
  const denied = () =>
    text("The operator DENIED this action. Do not retry it; ask what to do instead.");
  // Read-only is a DEVICE control only: it never blocks ticket work (reply, note,
  // create, KB) - those have their own approval + customer-email controls.
  const roDenied = () =>
    text(
      "This session is currently READ-ONLY on the devices, so this DEVICE action is not " +
        "allowed right now. " +
        (mutateAllowed
          ? "Tell the operator they can toggle write mode on to change the machine."
          : "An operator with write (mutate) rights must change the machine.") +
        " Ticket actions (reply, note, create, KB) are unaffected and still available.",
    );

  // Resolve the `machine` param to a machine entry, or throw a model-friendly error.
  function target(p) {
    if (!multi) return machines[0];
    const raw = String(p.machine || "").trim();
    const m = byLabel.get(raw.toLowerCase()) || byAgentId.get(raw);
    if (!m) {
      throw new Error(
        `Unknown machine '${raw}'. Valid machines in this session: ${labels.join(", ")}`,
      );
    }
    return m;
  }

  // Prefix approval summaries with the target hostname in multi mode.
  const gateFor = (m, summary) => gate(multi ? `[${m.label}] ${summary}` : summary);

  // Adds the required `machine` param in multi mode.
  function params(shape = {}) {
    if (!multi) return Type.Object(shape);
    return Type.Object({
      machine: Type.String({
        description: `Target machine for this call. One of: ${labels.join(", ")}`,
      }),
      ...shape,
    });
  }

  const forThis = multi ? "the TARGETED machine" : "THIS device";

  const get_device_details = defineTool({
    name: "get_device_details",
    label: "Get device details",
    description:
      `Get details about ${forThis} (hardware, OS, disks, IPs, checks status, custom fields). ` +
      `The bulk 'services' table, 'wmi_detail' and 'all_timezones' are summarised/omitted to ` +
      `protect context - query a specific service or WMI class with run_command_on_device instead.`,
    parameters: params({}),
    execute: async (_id, p, signal) => {
      const a = await trmm.getAgent(target(p).agentId, { signal });
      return text(capJson(shapeAgentDetails(a), { what: "device detail" }));
    },
  });

  const winShellNote = [
    "On Windows machines each call is a FRESH, non-interactive shell (cmd or powershell);",
    "combine steps with ';' (powershell) or '&' (cmd).",
  ].join(" ");
  const nixShellNote = [
    "On Linux/Unix machines each call is a FRESH, non-interactive /bin/bash shell (usually root);",
    "chain steps with ';' or '&&', use 'cd /path && ...', multi-line scripts and heredocs are fine, add 2>&1 to capture errors.",
  ].join(" ");
  const shellDescription = multi
    ? [
        "Run a command on ONE of this session's machines (pick it with the required 'machine' parameter).",
        "Working directory and environment are NOT preserved between calls.",
        allWindows ? winShellNote : anyWindows ? `${winShellNote} ${nixShellNote}` : nixShellNote,
      ].join(" ")
    : isWindows
      ? [
          "Run a command on THIS Windows device. Each call is a FRESH, non-interactive shell",
          "(cmd or powershell) - working directory and environment are NOT preserved between calls.",
          "Combine multiple steps in one call. For powershell use ';' between statements; for cmd use '&'.",
          "You can send multi-line scripts. Prefer powershell for anything non-trivial.",
        ].join(" ")
      : [
          "Run a command on THIS device in a FRESH, non-interactive /bin/bash shell (runs as the",
          "agent's service account, typically root). Working directory and environment are NOT",
          "preserved between calls, so treat each call as a standalone script: chain steps with",
          "';' or '&&', use 'cd /path && ...' when you need a directory, and you may send full",
          "multi-line scripts or heredocs. Redirect stderr with 2>&1 when you want to see errors.",
        ].join(" ");

  const run_command_on_device = defineTool({
    name: "run_command_on_device",
    label: "Run command on device",
    description: shellDescription,
    parameters: params({
      command: Type.String({
        description:
          "The full command or script to execute. May contain pipes, redirects, multiple" +
          " statements, and multiple lines.",
      }),
      shell: Type.Optional(
        Type.String({
          description: anyWindows
            ? "'cmd' or 'powershell' (default powershell); ignored on non-Windows machines"
            : "ignored on this platform (always /bin/bash)",
        }),
      ),
      run_as_user: Type.Optional(
        Type.Boolean({
          description:
            "Run as the currently logged-in interactive user instead of the service account" +
            " (default false). Only works when a user is logged in.",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({ description: "Max seconds to wait (default 60, max 900)" }),
      ),
      capture_as: Type.Optional(
        Type.String({
          description:
            "Hold this command's output in the bridge under this name INSTEAD of returning it " +
            "to you. You get a receipt (size, line count, sha256, first/last line) rather than " +
            "the content, so the size costs you no context. Use this for files you intend to " +
            "send - e.g. `cat /tmp/export.csv` with capture_as='export' then attach_capture. " +
            "For binary files pipe through base64 and set decode_base64 on attach_capture.",
        }),
      ),
    }),
    execute: async (_id, p, signal) => {
      const m = target(p);
      const win = m.plat === "windows";
      const shell = win ? (p.shell === "cmd" ? "cmd" : "powershell") : "/bin/bash";
      const timeout = p.timeout && p.timeout > 0 ? Math.min(p.timeout, 900) : 60;
      if (isReadonly()) {
        const hit = mutatingMatch(p.command, win);
        if (hit) {
          return text(
            `BLOCKED: this session is currently READ-ONLY, but the command appears to modify the system ` +
              `(matched "${hit}"). Only read-only/diagnostic commands are permitted right now. ` +
              `${mutateAllowed ? "The operator can enable write mode to apply changes." : "An operator with write (mutate) rights must make changes."}`,
          );
        }
      }
      const ok = await gateFor(m, `Run on device [${shell}]: ${p.command}`);
      if (!ok) return denied();
      // On Linux, self-terminate the command with `timeout` so a hung command
      // (e.g. a stuck Proxmox `qm list`/pmxcfs) returns promptly with partial
      // output instead of blocking the whole chat until the transport timeout.
      let cmd = p.command;
      if (!win) {
        const q = "'" + p.command.replace(/'/g, "'\\''") + "'";
        const note =
          `[pi] command did not finish within ${timeout}s and was terminated (partial output above; the command or the device is hung)`;
        cmd =
          `timeout --preserve-status --signal=TERM -k 5 ${timeout}s /bin/bash -c ${q}; ` +
          `__ec=$?; if [ $__ec -eq 124 ] || [ $__ec -eq 143 ]; then echo ${"'" + note + "'"}; fi`;
      }
      const out = await trmm.sendCmd(
        m.agentId,
        {
          shell,
          cmd,
          timeout: timeout + 10,
          runAsUser: !!p.run_as_user,
        },
        { signal },
      );
      const s = typeof out === "string" ? out : JSON.stringify(out);
      // Captured: keep the bytes here and hand back a receipt, not the content.
      if (p.capture_as && String(p.capture_as).trim()) {
        const name = String(p.capture_as).trim().slice(0, 80);
        const rec = capStore.put(name, s, `${m.hostname || m.agentId}: ${p.command.slice(0, 120)}`);
        if (rec.error) return text(rec.error);
        return text(captureReceipt(rec, " with attach_capture or send_email"));
      }
      return text(
        s.length
          ? capString(s, MAX_TOOL_RESULT_BYTES, `output of \`${p.command.slice(0, 80)}\``)
          : "(command produced no output; exit assumed success)",
      );
    },
  });

  const list_scripts = defineTool({
    name: "list_scripts",
    label: "List scripts",
    description: "List scripts available in the TRMM script library (id, name, shell, description).",
    parameters: Type.Object({}),
    execute: async (_id, _p, signal) => {
      const scripts = await trmm.listScripts({ signal });
      const slim = (Array.isArray(scripts) ? scripts : []).map((s) => ({
        id: s.id,
        name: s.name,
        shell: s.shell,
        description: s.description,
      }));
      return text(JSON.stringify(slim, null, 2));
    },
  });

  const run_script_on_device = defineTool({
    name: "run_script_on_device",
    label: "Run library script on device",
    description: `Run a saved TRMM library script on ${forThis} by its numeric script id (use list_scripts first).`,
    parameters: params({
      script_id: Type.Number({ description: "Numeric id of the library script" }),
      args: Type.Optional(Type.Array(Type.String(), { description: "Script arguments" })),
      timeout: Type.Optional(Type.Number({ description: "Seconds (default 90)" })),
    }),
    execute: async (_id, p, signal) => {
      if (isReadonly()) return roDenied();
      const m = target(p);
      const timeout = p.timeout && p.timeout > 0 ? Math.min(p.timeout, 900) : 90;
      const ok = await gateFor(m, `Run library script #${p.script_id} on device`);
      if (!ok) return denied();
      const out = await trmm.runScript(
        m.agentId,
        {
          script: p.script_id,
          args: p.args || [],
          timeout,
          output: "wait",
        },
        { signal },
      );
      return text(typeof out === "string" ? capString(out) : capJson(out, { what: "helpdesk" }));
    },
  });

  const list_processes = defineTool({
    name: "list_processes",
    label: "List processes",
    description:
      `List running processes on ${forThis}, ranked by CPU then memory. Returns the top ` +
      `processes plus totals, not the whole table - raise 'limit' only if you truly need more.`,
    parameters: params({
      limit: Type.Optional(
        Type.Number({ description: "How many top processes to return (default 40, max 200)" }),
      ),
    }),
    execute: async (_id, p, signal) => {
      const procs = await trmm.listProcesses(target(p).agentId, { signal });
      if (!Array.isArray(procs)) return text(capJson(procs, { what: "process" }));
      const limit = Math.min(Math.max(Number(p.limit) || 40, 1), 200);
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      const ranked = [...procs].sort(
        (a, b) => num(b.cpu_percent) - num(a.cpu_percent) || num(b.membytes) - num(a.membytes),
      );
      const totalMem = procs.reduce((n, x) => n + num(x.membytes), 0);
      const payload = {
        total_processes: procs.length,
        showing_top: Math.min(limit, ranked.length),
        ranked_by: "cpu_percent desc, then membytes desc",
        total_memory_bytes_all_processes: totalMem,
        processes: ranked.slice(0, limit),
      };
      return text(capJson(payload, { what: "process" }));
    },
  });

  const kill_process = defineTool({
    name: "kill_process",
    label: "Kill process",
    description: `Kill a process on ${forThis} by PID.`,
    parameters: params({ pid: Type.Number({ description: "Process id to kill" }) }),
    execute: async (_id, p, signal) => {
      if (isReadonly()) return roDenied();
      const m = target(p);
      const ok = await gateFor(m, `Kill process PID ${p.pid} on device`);
      if (!ok) return denied();
      const out = await trmm.killProcess(m.agentId, p.pid, { signal });
      return text(typeof out === "string" ? capString(out) : capJson(out, { what: "helpdesk" }));
    },
  });

  const get_event_logs = defineTool({
    name: "get_event_logs",
    label: "Get Windows event logs",
    description: multi
      ? "Get Windows event logs from a Windows machine in this session."
      : "Get Windows event logs from THIS device.",
    parameters: params({
      log_type: Type.String({ description: "Application, System, or Security" }),
      days: Type.Optional(Type.Number({ description: "How many days back (default 1, max 30)" })),
      include_info: Type.Optional(
        Type.Boolean({
          description:
            "Include INFO/SUCCESS events too (default false). INFO is ~95% of a Windows log and " +
            "will exhaust your context - only set true when hunting a specific informational event.",
        }),
      ),
      source_contains: Type.Optional(
        Type.String({ description: "Only events whose source matches this text (case-insensitive)" }),
      ),
      max_entries: Type.Optional(
        Type.Number({ description: "Max events to return (default 150, max 500)" }),
      ),
    }),
    execute: async (_id, p, signal) => {
      const m = target(p);
      if (m.plat !== "windows") {
        throw new Error(`${m.label} is not a Windows machine; event logs are Windows-only.`);
      }
      const days = Math.min(Math.max(Number(p.days) || 1, 1), 30);
      const out = await trmm.eventLog(m.agentId, p.log_type, days, { signal });
      if (!Array.isArray(out)) return text(capJson(out, { what: "event" }));
      const total = out.length;
      const wanted = /^(error|critical|warning)$/i;
      let rows = p.include_info ? out : out.filter((e) => wanted.test(String(e?.eventType || "")));
      const droppedInfo = total - rows.length;
      if (p.source_contains) {
        const needle = String(p.source_contains).toLowerCase();
        rows = rows.filter((e) => String(e?.source || "").toLowerCase().includes(needle));
      }
      // Newest first, then trim each message - a single stack-trace event can be 8 KB.
      rows = [...rows].reverse().map((e) => ({
        ...e,
        message: capString(String(e?.message ?? ""), 600, "event message"),
      }));
      const max = Math.min(Math.max(Number(p.max_entries) || 150, 1), 500);
      const payload = {
        log_type: p.log_type,
        days,
        total_events_in_window: total,
        severity_filter: p.include_info ? "ALL (info included)" : "ERROR/CRITICAL/WARNING only",
        info_events_suppressed: p.include_info ? 0 : droppedInfo,
        source_contains: p.source_contains || null,
        returned: Math.min(max, rows.length),
        matching_after_filter: rows.length,
        events: rows.slice(0, max),
      };
      return text(capJson(payload, { what: "event" }));
    },
  });

  const list_software = defineTool({
    name: "list_software",
    label: "List installed software",
    description: `List installed software on ${forThis} (name, version, publisher).`,
    parameters: params({
      name_contains: Type.Optional(
        Type.String({ description: "Only software whose name matches this text (case-insensitive)" }),
      ),
    }),
    execute: async (_id, p, signal) => {
      const sw = await trmm.listSoftware(target(p).agentId, { signal });
      const list = Array.isArray(sw?.software) ? sw.software : Array.isArray(sw) ? sw : null;
      if (!list) return text(capJson(sw, { what: "software" }));
      let rows = list.map((s) => ({ name: s?.name, version: s?.version, publisher: s?.publisher }));
      if (p.name_contains) {
        const needle = String(p.name_contains).toLowerCase();
        rows = rows.filter((s) => String(s?.name || "").toLowerCase().includes(needle));
      }
      return text(
        capJson(
          { total_installed: list.length, returned: rows.length, software: rows },
          { what: "software" },
        ),
      );
    },
  });

  const get_checks = defineTool({
    name: "get_checks",
    label: "Get checks",
    description: `Get monitoring checks and their status for ${forThis}.`,
    parameters: params({}),
    execute: async (_id, p, signal) =>
      text(capJson(await trmm.getChecks(target(p).agentId, { signal }), { what: "check" })),
  });

  const get_tasks = defineTool({
    name: "get_tasks",
    label: "Get automated tasks",
    description: `Get automated tasks for ${forThis}.`,
    parameters: params({}),
    execute: async (_id, p, signal) =>
      text(capJson(await trmm.getTasks(target(p).agentId, { signal }), { what: "task" })),
  });

  const reboot_device = defineTool({
    name: "reboot_device",
    label: "Reboot device",
    description: multi ? "Reboot the targeted machine now." : "Reboot THIS device now.",
    parameters: params({}),
    execute: async (_id, p, signal) => {
      if (isReadonly()) return roDenied();
      const m = target(p);
      const ok = await gateFor(m, `REBOOT the device now`);
      if (!ok) return denied();
      const out = await trmm.reboot(m.agentId, { signal });
      return text(typeof out === "string" ? capString(out) : capJson(out, { what: "helpdesk" }));
    },
  });

  const send_email = defineTool({
    name: "send_email",
    label: "Send email",
    description:
      "Send an email through the RMM server's configured SMTP (the same mail settings" +
      " Tactical RMM uses for alerts). Use this when the operator asks for results," +
      " findings, or alerts to be emailed (e.g. to alerts@ or support@). Write a clear" +
      " subject and put the full findings in the body. Only send email when the" +
      " operator/task instructions ask for it." +
      " For a nicely FORMATTED email, also pass `html` (a full HTML body); it is sent" +
      " as multipart/alternative with `body` as the plain-text fallback, so ALWAYS" +
      " provide a readable plain-text `body` too. IMPORTANT: email clients strip" +
      " <style> blocks and external CSS - use INLINE styles only (style=\"...\" on each" +
      " element), a table-based layout, and no <script>. Do NOT put HTML tags in `body`." +
      " From identity is chosen SERVER-SIDE (do not invent it): if the technician's" +
      " account email is on an allowlisted company domain, From is that tech's address" +
      " AND display name (their real name). Otherwise From is a unique pi-*@ address" +
      " with the company brand display name (e.g. BlueCloud Support). Do not pass" +
      " from_address/from_name unless the operator explicitly asks for a specific sender.",
    parameters: Type.Object({
      to: Type.String({
        description:
          "Recipient email address(es), comma-separated for multiple" +
          " (e.g. 'alerts@example.com' or 'alerts@example.com, support@example.com')",
      }),
      subject: Type.String({ description: "Email subject line" }),
      body: Type.String({ description: "Plain-text email body with the full details (also the fallback for HTML clients). No HTML tags here." }),
      html: Type.Optional(
        Type.String({
          description:
            "Optional full HTML body for a formatted email. Use INLINE styles only" +
            " (email clients strip <style>/external CSS); table-based layout; no <script>.",
        }),
      ),
      from_address: Type.Optional(
        Type.String({
          description:
            "Usually OMIT. Optional sender override only if the operator asks. A full" +
            " address (with '@') is used only when its domain is allowlisted; a bare word" +
            " becomes the local part on the server's mail domain. Display name is still" +
            " server-chosen (tech name vs company brand) — you cannot set it.",
        }),
      ),
      attach_capture_name: Type.Optional(
        Type.String({
          description:
            "Name of a capture (from capture_as) to attach to this email. The bridge holds " +
            "the bytes, so file size costs you no context. This is the ONLY way to email a " +
            "large file - never paste file contents into `body`.",
        }),
      ),
      attachment_filename: Type.Optional(
        Type.String({ description: "Filename the recipient sees, e.g. export.csv (required with attach_capture_name)" }),
      ),
      decode_base64: Type.Optional(
        Type.Boolean({ description: "Decode the capture from base64 first (for binary files such as xlsx/pdf)" }),
      ),
    }),
    execute: async (_id, p, signal) => {
      let att = null;
      if (p.attach_capture_name) {
        const cap = capStore.get(p.attach_capture_name);
        if (!cap)
          return text(
            `No capture named "${p.attach_capture_name}". Available: ${capStore.names().join(", ") || "(none)"}.`,
          );
        if (!p.attachment_filename)
          return text("attachment_filename is required when attaching a capture.");
        att = {
          attachment_base64: p.decode_base64
            ? cap.data.replace(/\s+/g, "")
            : Buffer.from(cap.data, "utf8").toString("base64"),
          attachment_filename: p.attachment_filename,
          bytes: cap.bytes,
          lines: cap.lines,
        };
      }
      const ok = await gate(
        `Send email to ${p.to}: "${p.subject}"` +
          (att ? ` WITH ATTACHMENT ${att.attachment_filename} (${att.bytes} bytes, ${att.lines} lines)` : ""),
      );
      if (!ok) return denied();
      const out = await trmm.sendEmail(
        {
          to: p.to,
          subject: p.subject,
          body: p.body,
          html: p.html,
          from_address: p.from_address,
          // from_name is server policy (tech real name vs brand) — never model-supplied
          job_ref: jobRef,
          actor_email: actorEmail || undefined,
          actor_name: actorName || undefined,
          attachment_base64: att ? att.attachment_base64 : undefined,
          attachment_filename: att ? att.attachment_filename : undefined,
        },
        { signal },
      );
      return text(typeof out === "string" ? capString(out) : capJson(out, { what: "helpdesk" }));
    },
  });

  // Deterministic, system-AGNOSTIC ticketing. The integration is defined by the
  // admin in Global Settings -> "Helpdesk Integration Code" (helpdesk.js), which
  // exports named operations (create_ticket, reply_to_ticket, add_note,
  // submit_report, resolve_customer, ...). This tool lets the model invoke those
  // operations by name; ALL API mechanics live in that code. The policy prompt
  // documents WHEN to use each operation and with what args.
  // Single-device sessions expose a deep link to the device so the integration
  // can put a "jump to device" link in the ticket (multi-device -> ambiguous, omit).
  const hdContext =
    machines.length === 1
      ? {
          deviceUrl: machines[0]?.facts?.device_url || "",
          hostname: machines[0]?.hostname || machines[0]?.facts?.hostname || "",
          client: machines[0]?.facts?.client || "",
          site: machines[0]?.facts?.site || "",
          agentId: machines[0]?.agentId || "",
        }
      : {};
  let hd = null, hdError = "";
  try { hd = loadHelpdesk(helpdeskCode, helpdeskApi, hdContext); }
  catch (e) { hdError = e.message; }
  const hdOps = hd ? hd.names : [];
  // Tracks whether a ticketing operation actually FAILED (API/exception), so the
  // headless caller can raise an RMM alert only in that (shouldn't-happen) case.
  const helpdeskState = { error: false, detail: "" };
  // Only advertise operations this surface may actually use, so the model is not shown
  // authority it does not have. This is NOT the control - execute() re-checks, because
  // the model can name an operation it was never shown.
  const hdVisible = hd
    ? allowedOps({ surface, names: hdOps, opClasses: hd.opClasses, mutating: hd.mutating, grants })
    : [];
  const opList = hdVisible
    .map((n) => `  - ${n}${hd.meta[n] ? ": " + hd.meta[n] : ""}`)
    .join("\n");
  const helpdesk_call = defineTool({
    name: "helpdesk_call",
    label: "Helpdesk operation",
    description:
      "Perform a helpdesk/ticketing operation (create ticket, reply to the " +
      "customer, add an internal note, look up a customer, etc.). Exactly WHEN " +
      "and HOW to use each operation (and its args) is defined in the HELPDESK " +
      "POLICY in your instructions - follow it. These are TICKET actions: they do NOT " +
      "require the session's Write mode (that controls changes to the DEVICES), but a " +
      "mutating one still asks the operator to approve it. Available operations:\n" +
      (opList || "  (none configured)"),
    parameters: Type.Object({
      operation: Type.String({ description: "Operation name (one listed above)" }),
      args: Type.Optional(
        Type.String({
          description:
            "JSON object of arguments for the operation, e.g. " +
            '{"ticket":"TICKET/123","message":"..."}',
        }),
      ),
      summary: Type.String({
        description: "One-line summary of what this does (shown to the operator for approval)",
      }),
    }),
    execute: async (_id, p) => {
      if (!hd)
        return text(
          `Helpdesk integration code is not configured or failed to load${hdError ? ": " + hdError : ""}.`,
        );
      const op = String(p.operation || "").trim();
      if (!hd.operations[op])
        return text(`Unknown helpdesk operation "${op}". Available: ${hdVisible.join(", ")}.`);
      // Capability check (ISSUES.md F1). Default-deny: an operation the deployment
      // declares mutating but does not classify is refused here.
      const cap = gateOp({ surface, op, opClasses: hd.opClasses, mutating: hd.mutating, grants, ref: jobRef });
      if (!cap.allowed && cap.enforced)
        return text(
          `Not permitted on this surface: ${cap.reason}. ` +
            `Do not retry it. If a person needs to authorise this, say so in an internal note instead.`,
        );
      let args = {};
      if (p.args) {
        try { args = JSON.parse(p.args); }
        catch (e) { return text(`args must be valid JSON: ${e.message}`); }
      }
      // CREDENTIALS. Class `secret` - the customer's live usernames and passwords. This is
      // NOT routed through `gate`: a credential read is not a mutating operation, so the
      // mutating check below would let it straight through, and `gate` would honour
      // Auto-approve even if it did catch it. It gets its own policy or it does not run.
      if (cap.cls === "secret") {
        if (!secretGate)
          return text(
            "Not permitted: this surface has no credential-approval channel, so stored " +
              "logins cannot be read here. Do not retry, and do not ask the customer for " +
              "their password.",
          );
        const who = args.company_name || args.partner_id || "this company";
        const wantsPriv = !!args.include_privileged;
        // The privileged flag travels as DATA, not as a phrase in the summary: it decides
        // whether Auto-credential may cover this read, and a gate must never have to parse
        // English to work that out.
        const g = await secretGate(
          `Read STORED CREDENTIALS (IT Notebook) for ${who}. ` +
            `The AI will be able to see the usernames and passwords it returns.` +
            (wantsPriv
              ? ` IT IS ALSO ASKING FOR THE PRIVILEGED ROWS, which are normally withheld.`
              : ` Privileged rows will be withheld.`),
          { privileged: wantsPriv },
        );
        if (!g.ok)
          return text(
            (g.reason || "Reading the stored credentials was not permitted.") +
              " Do not retry it and do not ask the customer for their password.",
          );
      }
      let globalKnowledgeAuth = null;
      if (op === "create_global_kb_article") {
        try { globalKnowledgeAuth = globalKnowledgeAuthorisation(); } catch (e) { /* deny below */ }
        if (!globalKnowledgeAuth) {
          return text(
            "Not permitted: a GLOBAL KB article may be created only when the technician " +
              "explicitly asks in this chat to create/write/publish a global KB article. " +
              "Do not retry or substitute the company-scoped upsert_ai_kb_article operation.",
          );
        }
      }
      // The technician's direct global-KB instruction is itself the authorisation; do
      // not ask them to confirm the same action again. All other mutating calls retain
      // their normal approval behavior.
      if (hd.mutating.has(op) && !globalKnowledgeAuth) {
        const ok = await gate(`Helpdesk: ${p.summary || op}`);
        if (!ok) return denied();
      }
      try {
        const result = await hd.operations[op](args);
        let out = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        if (hd.apiKey) out = out.split(hd.apiKey).join("***");
        return text(out || "(done)");
      } catch (e) {
        let msg = e && e.message ? e.message : String(e);
        if (hd.apiKey) msg = msg.split(hd.apiKey).join("***");
        helpdeskState.error = true; helpdeskState.detail = `${op}: ${msg}`;
        return text(`Helpdesk operation "${op}" failed: ${msg}`);
      }
    },
  });

  // For scheduled/unattended runs: a tool the AI calls once to report its verdict.
  const report_result = defineTool({
    name: "report_result",
    label: "Report result",
    description:
      "Call this EXACTLY ONCE at the very end to report your verdict for this scheduled" +
      " check. status='ok' when everything is healthy, 'warning' for minor/degraded issues," +
      " 'alert' for serious problems that need attention. summary is a one-line headline;" +
      " details is the supporting evidence.",
    parameters: Type.Object({
      status: Type.String({ description: "'ok' | 'warning' | 'alert'" }),
      summary: Type.String({ description: "One-line headline of the finding" }),
      details: Type.Optional(Type.String({ description: "Supporting details / evidence" })),
    }),
    execute: async (_id, p) => {
      const s = (p.status || "").toLowerCase();
      verdict.status = ["ok", "warning", "alert"].includes(s) ? s : "warning";
      verdict.summary = p.summary || "";
      verdict.details = p.details || "";
      return text("Result recorded.");
    },
  });

  // Durable per-device memory. NOT gated and allowed in read-only mode: it writes
  // to the device's Pi.dev memory in RMM, never to the device itself.
  const save_device_note = defineTool({
    name: "save_device_note",
    label: "Save device note",
    description:
      "Save a durable note about " + forThis + " to its Pi.dev memory so FUTURE " +
      "Pi runs start with this context. Record ONLY stable, reusable facts that make " +
      "future work faster: the device's role/purpose, key install paths, service/" +
      "container names, disk/volume layout, where credentials live (NOT the secrets " +
      "themselves), vendor/model quirks, and fixes that worked. Keep each note to ONE " +
      "SHORT line (~200 chars max - the server truncates longer notes). Be terse; prefer " +
      "updating an existing fact over piling on near-duplicates. Do NOT save transient " +
      "state, secrets, or personal data.",
    parameters: params({
      note: Type.String({ description: "One concise, durable fact about this device." }),
    }),
    execute: async (_id, p, signal) => {
      const m = target(p);
      try {
        await trmm.saveDeviceNote(m.agentId, p.note, { signal });
        return text("Saved to device memory.");
      } catch (e) {
        return text("Could not save device note: " + (e?.message || e));
      }
    },
  });

  const get_device_notes = defineTool({
    name: "get_device_notes",
    label: "Read device notes",
    description:
      "Read the durable Pi.dev memory notes already saved on " + forThis + " (its role, disk/volume " +
      "layout, service/container names, vendor quirks, and past fixes). Use this to recall what's " +
      "already known about the machine before diagnosing.",
    parameters: params({}),
    execute: async (_id, p, signal) => {
      const m = target(p);
      try {
        const out = await trmm.getDeviceNotes(m.agentId, { signal });
        const notes = (out && out.notes) || "";
        return text(notes ? notes : "(no device notes saved yet)");
      } catch (e) { return text("Could not read device notes: " + (e?.message || e)); }
    },
  });

  const schedule_action = defineTool({
    name: "schedule_action",
    label: "Schedule an action",
    description:
      "Schedule work to run AUTOMATICALLY at a specific time on " + forThis + " (e.g. a maintenance " +
      "window). The job runs ONCE at run_at, then removes itself and reports back. Confirm the exact " +
      "time and action with the operator first. run_at is ISO 8601 (UTC 'Z' or with offset).",
    parameters: params({
      run_at: Type.String({ description: "ISO 8601 datetime, e.g. 2026-07-24T07:00:00Z" }),
      action: Type.String({ description: "Exactly what to do at that time (clear and specific)" }),
      allow_mutating: Type.Optional(Type.Boolean({ description: "Allow changes on the device (default true)" })),
    }),
    execute: async (_id, p) => {
      const m = target(p);
      try {
        const out = await trmm.scheduleAction({
          agent_id: m.agentId, ticket_ref: "", action: p.action,
          run_at: p.run_at, allow_mutating: p.allow_mutating !== false,
        });
        return text(typeof out === "string" ? capString(out) : capJson(out, { what: "helpdesk" }));
      } catch (e) { return text("schedule_action failed: " + (e?.message || e)); }
    },
  });

  const list_scheduled_actions = defineTool({
    name: "list_scheduled_actions",
    label: "List scheduled AI actions",
    description:
      "List one-shot AI scheduled jobs (the ones created by schedule_action). Use this before " +
      "cancelling, or when finishing a ticket to find leftover follow-up jobs that are now " +
      "superseded. Defaults to status=scheduled for this device.",
    parameters: params({
      status: Type.Optional(Type.String({ description: "Filter: scheduled|running|done|error|cancelled (default scheduled)" })),
      ticket_ref: Type.Optional(Type.String({ description: "Optional ticket ref filter, e.g. TICKET/59074" })),
    }),
    execute: async (_id, p) => {
      const m = target(p);
      try {
        const out = await trmm.listScheduledActions({
          agent_id: m.agentId,
          ticket_ref: p.ticket_ref || undefined,
          status: p.status || "scheduled",
        });
        return text(JSON.stringify(out, null, 2));
      } catch (e) { return text("list_scheduled_actions failed: " + (e?.message || e)); }
    },
  });

  const cancel_scheduled_action = defineTool({
    name: "cancel_scheduled_action",
    label: "Cancel a scheduled AI action",
    description:
      "Delete/cancel a one-shot scheduled AI job by id (from list_scheduled_actions or the id " +
      "returned by schedule_action). Use this when the work is already done, the plan changed, " +
      "or a later job superseded an earlier one — do NOT leave stale follow-ups to fire.",
    parameters: params({
      id: Type.Number({ description: "Scheduled action id (e.g. 31)" }),
    }),
    execute: async (_id, p) => {
      try {
        const out = await trmm.deleteScheduledAction(p.id);
        return text(JSON.stringify(out || { ok: true, id: p.id, cancelled: true }));
      } catch (e) { return text("cancel_scheduled_action failed: " + (e?.message || e)); }
    },
  });

  const capStore = makeCaptureStore();

  const attach_capture = defineTool({
    name: "attach_capture",
    label: "Attach a captured file to a ticket",
    description:
      "Attach a file previously captured with run_command_on_device(capture_as=...) to a " +
      "ticket. THIS is how you send a large file: the bytes are held by the bridge and " +
      "never pass through your context, so size costs you nothing. Set to_customer=true " +
      "to send it as the branded customer reply (an email actually goes out); leave it " +
      "false to attach it as a staff-only internal note. Use decode_base64=true if the " +
      "captured output was base64 (i.e. the file is binary, such as xlsx or pdf).",
    parameters: Type.Object({
      capture: Type.String({ description: "Name given to capture_as" }),
      ticket: Type.String({ description: "Ticket reference, e.g. TICKET/55726" }),
      filename: Type.String({ description: "Filename the recipient sees, e.g. remittance.csv" }),
      message: Type.String({ description: "The note text, or the customer-facing reply body" }),
      to_customer: Type.Optional(Type.Boolean({ description: "true = email the customer (default false = internal note)" })),
      decode_base64: Type.Optional(Type.Boolean({ description: "Decode the capture from base64 first (binary files)" })),
    }),
    execute: async (_id, p) => {
      if (!hd) return text("Helpdesk integration is not configured.");
      const cap = capStore.get(p.capture);
      if (!cap)
        return text(
          `No capture named "${p.capture}". Available: ${capStore.names().join(", ") || "(none)"}. ` +
            `Run the command again with capture_as to create one.`,
        );
      const op = p.to_customer ? "reply_to_ticket" : "attach_file";
      // Same capability gate as any other helpdesk write: a customer-visible send is the
      // "customer" class and is refused on surfaces that may not contact customers.
      const gateRes = gateOp({ surface, op, opClasses: hd.opClasses, mutating: hd.mutating, grants, ref: jobRef });
      if (!gateRes.allowed && gateRes.enforced) return text(`Not permitted on this surface: ${gateRes.reason}`);
      const ok = await gate(
        `Helpdesk: attach ${p.filename} (${cap.bytes} bytes, ${cap.lines} lines) to ${p.ticket}` +
          (p.to_customer ? " AND EMAIL IT TO THE CUSTOMER" : " as an internal note"),
      );
      if (!ok) return denied();
      const file = { filename: p.filename };
      if (p.decode_base64) file.content_base64 = cap.data.replace(/\s+/g, "");
      else file.content = cap.data;
      try {
        const res = await hd.operations[op]({ ticket: p.ticket, message: p.message, files: [file] });
        if (res && res.error) return text(`attach failed: ${res.error}`);
        return text(
          `Attached ${p.filename} to ${p.ticket} (${cap.bytes} bytes, ${cap.lines} lines, ` +
            `sha256 ${cap.sha256.slice(0, 16)}...). ` +
            (p.to_customer ? "Customer reply SENT with the file attached." : "Posted as a staff-only internal note.") +
            ` Result: ${JSON.stringify(res)}`,
        );
      } catch (e) {
        return text(`attach failed: ${e?.message || e}`);
      }
    },
  });

  const operatorTools = operatorPlugin?.buildOperatorTools({
    Type, defineTool, text, operatorPolicy, operatorActor, surface: "pi-chat",
    // A brokered PowerShell run is a device change like any other: hand the Operator
    // tools this session's real controls rather than letting them invent their own.
    approve: async (summary) => ({ ok: await gate(summary) }),
    isReadonly,
    mutatingMatch,
  }) || [];

  let tools = [
    get_device_details,
    // Fleet/asset facts (serial, make/model) straight from TRMM's stored inventory:
    // works for devices this session cannot reach, so an inventory report no longer
    // has a hole where every offline machine should be.
    deviceHardwareTool(),
    run_command_on_device,
    list_scripts,
    run_script_on_device,
    list_processes,
    kill_process,
    list_software,
    get_checks,
    get_tasks,
    reboot_device,
    send_email,
    save_device_note,
    get_device_notes,
    schedule_action,
    list_scheduled_actions,
    cancel_scheduled_action,
  ];
  if (hd) tools.push(helpdesk_call);
  if (hd) tools.push(attach_capture);
  if (anyWindows) tools.push(get_event_logs);

  if (hardReadonly) {
    // no mutate rights at all: drop the destructive actions entirely (a scheduled
    // action could run changes later, so drop it too for read-only-only users).
    const drop = new Set(["run_script_on_device", "kill_process", "reboot_device", "schedule_action", "cancel_scheduled_action"]);
    tools = tools.filter((t) => !drop.has(t.name));
  }
  if (includeReport) tools.push(report_result);
  if (operatorTools.length) tools.push(...operatorTools);

  // Names that require approval when approval mode is on.
  const mutating = new Set([
    "attach_capture",
    "run_command_on_device",
    "run_script_on_device",
    "kill_process",
    "reboot_device",
    "send_email",
    "helpdesk_call",
    "schedule_action",
    "cancel_scheduled_action",
  ]);

  return { tools, mutating, verdict, machines, helpdeskState };
}

// ---------------------------------------------------------------------------
// Report mode: no device access. Used by the end-of-batch finalizer to compile
// ONE combined report. Exposes a DETERMINISTIC submit_report tool (single call,
// atomic create-or-update - no LLM API orchestration) + report_result. This is
// deliberately NOT the free-form helpdesk_api_request: a fixed-format fleet
// report must never fan out into dozens of calls or duplicate tickets.
export function buildReportTools({ helpdeskCode, helpdeskApi } = {}) {
  const text = (s) => ({ content: [{ type: "text", text: s }], details: {} });
  const verdict = { status: null, summary: "", details: "" };
  let hd = null, hdError = "";
  try { hd = loadHelpdesk(helpdeskCode, helpdeskApi); }
  catch (e) { hdError = e.message; }
  const helpdeskState = { error: false, detail: "" };

  const submit_report = defineTool({
    name: "submit_report",
    label: "Submit combined report",
    description:
      "Create or update THE single combined report ticket. Call this EXACTLY ONCE" +
      " with the entire report composed in the body. If a ticket with the same" +
      " subject already exists for this customer, your body is appended as one" +
      " update note; otherwise one new ticket is created. Do NOT call it more than" +
      " once and do NOT try to write the report any other way.",
    parameters: Type.Object({
      partner_id: Type.Number({
        description: "Customer res.partner id for the report (from your instructions)",
      }),
      team_id: Type.Optional(
        Type.Number({ description: "Helpdesk team id (from your instructions)" }),
      ),
      subject: Type.String({ description: "Exact ticket subject" }),
      body: Type.String({
        description:
          "The COMPLETE report as HTML, covering every machine in one string" +
          " (headline counts, then failing, warning, OK, not-installed sections).",
      }),
    }),
    execute: async (_id, p) => {
      if (!hd || !hd.operations.submit_report) {
        helpdeskState.error = true;
        helpdeskState.detail = `submit_report unavailable${hdError ? ": " + hdError : ""}`;
        return text(
          `Report integration (submit_report) is not available${hdError ? ": " + hdError : ""}.`,
        );
      }
      try {
        const r = await hd.operations.submit_report({
          subject: p.subject,
          body: p.body,
          partner_id: p.partner_id,
          team_id: p.team_id,
        });
        let out = typeof r === "string" ? r : JSON.stringify(r);
        if (hd.apiKey) out = out.split(hd.apiKey).join("***");
        return text(`${out}. Do not call submit_report again.`);
      } catch (e) {
        let msg = e && e.message ? e.message : String(e);
        if (hd.apiKey) msg = msg.split(hd.apiKey).join("***");
        helpdeskState.error = true; helpdeskState.detail = `submit_report: ${msg}`;
        return text(`Report submit failed: ${msg}`);
      }
    },
  });

  const report_result = defineTool({
    name: "report_result",
    label: "Report result",
    description:
      "Call this EXACTLY ONCE at the end to report the outcome of building the" +
      " combined report. status='ok' if the report ticket was created/updated," +
      " 'warning' if partial, 'alert' if it failed. summary is a one-line headline.",
    parameters: Type.Object({
      status: Type.String({ description: "'ok' | 'warning' | 'alert'" }),
      summary: Type.String({ description: "One-line headline" }),
      details: Type.Optional(Type.String({ description: "Supporting details" })),
    }),
    execute: async (_id, p) => {
      const s = (p.status || "").toLowerCase();
      verdict.status = ["ok", "warning", "alert"].includes(s) ? s : "ok";
      verdict.summary = p.summary || "";
      verdict.details = p.details || "";
      return text("Result recorded.");
    },
  });

  return { tools: [submit_report, report_result], verdict, helpdeskState };
}

// ---------------------------------------------------------------------------
// Ticket-triage mode (SHADOW, Phase 1): NO device access, NO mutating helpdesk
// ops. The model may READ the ticket (get_ticket) and must then call
// submit_triage exactly once with its classification + draft. The staff-only
// shadow note is posted DETERMINISTICALLY by the caller afterwards - the model
// cannot close, reply, assign, or touch anything.
// Tools for the AI Procedures miner: ONE tool, submit_procedures, which captures the
// reusable procedures the model distilled from a batch of closed tickets.
export function buildProcedureMiningTools() {
  const text = (s) => ({ content: [{ type: "text", text: s }], details: {} });
  const collected = { procedures: [], company_kb_entry: "" };
  const submit_analysis = defineTool({
    name: "submit_analysis",
    label: "Submit mined analysis",
    description:
      "Record what you learned from THIS company's closed tickets. Call EXACTLY ONCE with:\n" +
      "1) procedures = reusable, CLIENT-AGNOSTIC troubleshooting procedures (generic problem patterns " +
      "with the steps that actually resolved them). SKIP tickets with no clear resolution, monitoring " +
      "noise, or client-specific facts.\n" +
      "2) company_kb_entry = a concise note of CLIENT-SPECIFIC knowledge for THIS company only " +
      "(recurring issues at this client, their environment/standards/quirks, key systems) - or empty " +
      "string if nothing client-specific is worth remembering. NEVER put secrets here.",
    parameters: Type.Object({
      procedures: Type.Array(Type.Object({
        title: Type.String({ description: "Short searchable title, e.g. 'Toshiba MFP prints garbled from Excel'" }),
        category: Type.String({ description: "Pick ONE from EXACTLY: Active Directory, Microsoft 365, Email, Security, Networking, Phones/VoIP, Printers, Backups, Hardware, Software, QuickBooks, Cloud Applications, Desktop Support, General. Never invent or combine." }),
        applies_to: Type.Optional(Type.String({ description: "Vendor/app/OS keywords for matching" })),
        symptom: Type.String({ description: "The observable problem" }),
        root_cause: Type.Optional(Type.String({ description: "What it actually was" })),
        fix: Type.String({ description: "The exact steps that resolved it" }),
        verification: Type.Optional(Type.String({ description: "How to confirm it is fixed" })),
        source_ticket_refs: Type.Optional(Type.Array(Type.String({ description: "Ticket ref(s) this came from" }))),
        update_code: Type.Optional(Type.String({ description: "If this matches an EXISTING procedure from the provided list, put its 7-digit code here (e.g. 0000042) to UPDATE it instead of creating a duplicate. Omit to create new." })),
      })),
      company_kb_entry: Type.Optional(Type.String({ description: "Client-specific knowledge for THIS company's KB (not generic). Empty if none." })),
    }),
    execute: async (_id, p) => {
      collected.procedures = Array.isArray(p.procedures) ? p.procedures : [];
      collected.company_kb_entry = String(p.company_kb_entry || "").trim();
      return text(`Recorded ${collected.procedures.length} procedures${collected.company_kb_entry ? " + a company KB note" : ""}.`);
    },
  });
  return { tools: [submit_analysis], collected };
}

export function buildTicketTriageTools({ helpdeskCode, helpdeskApi } = {}) {
  const text = (s) => ({ content: [{ type: "text", text: s }], details: {} });
  const verdict = { classification: "", summary: "", proposed_action: "", needs_input: false, can_help: false, client: "", affected_device: "", company_partner_id: 0 };
  let hd = null, hdError = "";
  try { hd = loadHelpdesk(helpdeskCode, helpdeskApi); }
  catch (e) { hdError = e.message; }
  const hdcall = async (op, args) => {
    if (!hd || !hd.operations[op]) return text(`operation ${op} not available`);
    try { const out = await hd.operations[op](args); return text(typeof out === "string" ? capString(out, 20000) : capJson(out, { maxBytes: 20000, what: "helpdesk" })); }
    catch (e) { return text(`${op} failed: ${e?.message || e}`); }
  };

  const get_ticket = defineTool({
    name: "get_ticket",
    label: "Read ticket",
    description:
      "Read the ticket's subject, description/body, requester and recent messages." +
      " Use this first to see what the ticket actually says.",
    parameters: Type.Object({
      ticket: Type.String({ description: "Ticket reference (id or number) to read" }),
    }),
    execute: async (_id, p, signal) => {
      if (!hd) return text("Helpdesk integration failed to load: " + hdError);
      const op = hd.operations.get_ticket;
      if (!op) return text("This helpdesk integration defines no get_ticket operation.");
      try {
        const out = await op({ ticket: p.ticket });
        return text(typeof out === "string" ? capString(out, 30000) : capJson(out, { maxBytes: 30000, what: "helpdesk" }));
      } catch (e) {
        return text("get_ticket failed: " + (e?.message || e));
      }
    },
  });

  const resolve_client = defineTool({
    name: "resolve_client",
    label: "Resolve customer company",
    description:
      "Find the customer COMPANY (Odoo partner) from the requester's email or domain" +
      " (best-match roll-up). Use for regular tickets to know which client it's for.",
    parameters: Type.Object({
      email: Type.Optional(Type.String({ description: "Requester email" })),
      domain: Type.Optional(Type.String({ description: "Email domain (if no email)" })),
    }),
    execute: async (_id, p) => hdcall("resolve_client_by_domain", { email: p.email, domain: p.domain }),
  });

  const find_devices = defineTool({
    name: "find_devices",
    label: "Find the user's device(s)",
    description:
      "Given the customer company (domain/name) and optionally the requester's" +
      " username (email local part), find the matching RMM client and the user's" +
      " device(s) + candidate devices. READ-ONLY.",
    parameters: Type.Object({
      domain: Type.Optional(Type.String()),
      company_name: Type.Optional(Type.String()),
      username: Type.Optional(Type.String({ description: "Requester username or email" })),
      person_name: Type.Optional(Type.String({ description: "Requester FULL NAME from the ticket contact - greatly improves matching (e.g. 'Jane Smith' matches login JaneSmith)" })),
      hostname: Type.Optional(Type.String({ description: "A device/server HOSTNAME named in the ticket (e.g. pve01) - the right way to find servers/infrastructure" })),
    }),
    execute: async (_id, p) => {
      try {
        const out = await trmm.resolveDevices({ domain: p.domain, company_name: p.company_name, username: p.username, person_name: p.person_name, hostname: p.hostname });
        // capJson, not slice(): a raw slice cut the JSON mid-token and handed the model
        // unparseable garbage with no indication anything was missing.
        return text(capJson(out, { what: "device match" }));
      } catch (e) { return text(`find_devices failed: ${e?.message || e}`); }
    },
  });

  const find_company = defineTool({
    name: "find_company",
    label: "Find company",
    description:
      "Find the customer COMPANY (res.partner) by NAME. Use this when the company must be inferred" +
      " from the subject/device (e.g. a server named ACME-SQL01 -> Acme Corp) and there's no" +
      " requester email domain. Returns the company partner_id to put in submit_triage.company_partner_id.",
    parameters: Type.Object({ name: Type.String({ description: "Company name" }) }),
    execute: async (_id, p) => hdcall("find_company", { name: p.name }),
  });

  const list_kb_articles = defineTool({
    name: "list_kb_articles",
    label: "List company KB articles",
    description: "List the company's IT knowledge-base article titles (by partner_id). Read the relevant one before proposing steps.",
    parameters: Type.Object({ partner_id: Type.Number() }),
    execute: async (_id, p) => hdcall("list_kb_articles", { partner_id: p.partner_id }),
  });

  const get_kb_article = defineTool({
    name: "get_kb_article",
    label: "Read a KB article",
    description: "Read one knowledge-base article's content (procedures for this company).",
    parameters: Type.Object({ id: Type.Number() }),
    execute: async (_id, p) => hdcall("get_kb_article", { id: p.id }),
  });

  const submit_triage = defineTool({
    name: "submit_triage",
    label: "Submit triage verdict",
    description:
      "Record your triage verdict for THIS ticket. Call EXACTLY ONCE, then stop." +
      " classification: alert_clean (informational/successful alert - nothing to do)," +
      " alert_actionable (alert that needs work), regular (a human/customer request)," +
      " or unknown. Set needs_input=true if a human must decide before anything can" +
      " safely proceed (ambiguous, can't identify the device/customer, risky).",
    parameters: Type.Object({
      classification: Type.String({ description: "alert_clean | alert_actionable | regular | unknown" }),
      summary: Type.String({ description: "1-2 sentence summary of what the ticket is" }),
      proposed_action: Type.String({ description: "Concise draft of what you would do (with the client/device/KB you found)" }),
      needs_input: Type.Optional(Type.Boolean({ description: "true if a human decision is required first" })),
      can_help: Type.Optional(Type.Boolean({ description: "true if you (an AI IT tech with device access, ticket tools and the company KB) can realistically resolve or make real progress on this" })),
      client: Type.Optional(Type.String({ description: "Resolved customer/RMM client, if known" })),
      company_partner_id: Type.Optional(Type.Number({ description: "The resolved CUSTOMER COMPANY's Odoo partner_id (from find_company/resolve_client) - so the ticket can be attributed to the right company. 0 if unknown." })),
      affected_device: Type.Optional(Type.String({ description: "The device this concerns, if identified" })),
    }),
    execute: async (_id, p) => {
      const c = (p.classification || "").toLowerCase().trim();
      verdict.classification = ["alert_clean", "alert_actionable", "regular", "unknown"].includes(c) ? c : "unknown";
      verdict.summary = p.summary || "";
      verdict.proposed_action = p.proposed_action || "";
      verdict.needs_input = !!p.needs_input;
      verdict.can_help = !!p.can_help;
      verdict.client = p.client || "";
      verdict.company_partner_id = Number(p.company_partner_id) || 0;
      verdict.affected_device = p.affected_device || "";
      return text("Triage recorded. Stop now.");
    },
  });

  return {
    tools: [get_ticket, resolve_client, find_company, find_devices, deviceHardwareTool(),
            list_kb_articles, get_kb_article, ...webTools(), submit_triage],
    verdict, hd, hdError,
  };
}

// ---------------------------------------------------------------------------
// Decision chat (the "Johnny 5 Need Input!" link). A tech answers the AI's
// question; the AI continues on the TICKET only - it can call any helpdesk
// operation (read the ticket, reply, note, close/cancel, clear the tag, update
// the AI KB) and look up devices, but has NO device shell access (that's Phase 3).
// Destructive/disruptive command patterns: reboots, service STOP/disable (downtime),
// and data-loss/format. These need explicit approval in the decision chat; everything
// else (diagnostics + non-disruptive fixes like restarting a stuck spooler) is allowed.
const DESTRUCTIVE = [
  /\b(reboot|shutdown|halt|poweroff|telinit|init\s+[06])\b/i,
  /\bRestart-Computer\b/i, /\bStop-Computer\b/i, /\bshutdown(\.exe)?\b/i,
  /\brm\s+-|\brmdir\b|\bunlink\b|\bshred\b|\bmkfs|\bfdisk\b|\bparted\b|\bwipefs\b|\bdd\s+if=|\btruncate\b/i,
  /\bRemove-Item\b/i, /\bFormat-Volume\b/i, /\bformat\b(?!-)/i, /\bdiskpart\b/i,
  /\b(del|erase)\s+\/|\bdel\s+\S|\berase\s+\S/i,
  /\bsystemctl\s+(stop|disable|mask)\b/i, /\bservice\s+\S+\s+stop\b/i,
  /\bStop-Service\b/i, /\bnet(\.exe)?\s+stop\b/i, /\bsc(\.exe)?\s+(stop|delete|config)\b/i,
  /\b(qm|pct)\s+(stop|destroy|delete|rollback)\b/i, /\bzpool\s+(destroy|detach|remove|offline)\b/i,
];
function isDestructive(cmd) {
  const c = String(cmd || "");
  return DESTRUCTIVE.some((re) => re.test(c));
}

export function buildDecisionTools({ helpdeskCode, helpdeskApi, ticketRef, gate, surface = null,
  creditActor = "", creditSession = "", globalKnowledgeAuthorisation = () => null,
  operatorPolicy = null, operatorActor = "",
  actorEmail = "", actorName = "",
  salesCode = "", salesApi = null, salesEnabled = false,
} = {}) {
  const text = (s) => ({ content: [{ type: "text", text: s }], details: {} });
  const capStore = makeCaptureStore();
  let hd = null, hdError = "";
  try { hd = loadHelpdesk(helpdeskCode, helpdeskApi); }
  catch (e) { hdError = e.message; }
  // Replaces the old `blockOps` name list (ISSUES.md I6): that hardcoded five
  // deployment-authored operation NAMES in product code, so a deployment naming its
  // operations differently got no protection at all - and it failed OPEN.
  const hdVisible = hd
    ? allowedOps({ surface, names: hd.names, opClasses: hd.opClasses, mutating: hd.mutating })
    : [];
  const opList = hd ? hdVisible.map((n) => `  - ${n}${hd.meta[n] ? ": " + hd.meta[n] : ""}`).join("\n") : "";

  const helpdesk_call = defineTool({
    name: "helpdesk_call",
    label: "Helpdesk operation",
    description:
      "Perform a ticketing operation on THIS ticket (read it, reply to the customer, " +
      "add an internal note, close/cancel, clear the 'Johnny 5 Need Input!' tag, update " +
      "the company AI KB, resolve the customer, etc.). Available operations:\n" + (opList || "  (none)") +
      "\n\nThis chat is already bound to this ticket - you do NOT need to pass a ticket id; it is added " +
      "automatically. Field names: add_note and reply_to_ticket use 'message'; resolve_ticket uses " +
      "'internal_note' (review note) + 'customer_html' (the HTML customer reply); close_ticket uses " +
      "'reason'; set_ticket_company uses 'company_partner_id'; KB ops use 'partner_id'/'title'/'content'.",
    parameters: Type.Object({
      operation: Type.String({ description: "Operation name (one of the list above)" }),
      message: Type.Optional(Type.String({ description: "Customer reply text (reply_to_ticket) OR internal note text (add_note)" })),
      internal_note: Type.Optional(Type.String({ description: "resolve_ticket: internal review note" })),
      customer_html: Type.Optional(Type.String({ description: "resolve_ticket: the HTML customer reply (inline styles)" })),
      reason: Type.Optional(Type.String({ description: "close_ticket / cancel reason" })),
      cancel: Type.Optional(Type.Boolean({ description: "resolve_ticket: true to cancel instead of close" })),
      company_partner_id: Type.Optional(Type.Number({ description: "set_ticket_company: correct company partner_id" })),
      partner_id: Type.Optional(Type.Number({ description: "KB ops: the company partner_id" })),
      article_id: Type.Optional(Type.Number({ description: "get_kb_article: article id" })),
      title: Type.Optional(Type.String({ description: "KB article title" })),
      content: Type.Optional(Type.String({ description: "KB article content" })),
      name: Type.Optional(Type.String({ description: "find_company: company name" })),
      domain: Type.Optional(Type.String({ description: "resolve_client_by_domain: email domain" })),
      email: Type.Optional(Type.String({ description: "requester email" })),
      args: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Any other operation-specific arguments" })),
    }),
    execute: async (_id, p) => {
      if (!hd || !hd.operations[p.operation]) return text(`operation ${p.operation} not available`);
      // Capability check, by CLASS rather than by operation name (ISSUES.md F1/I6).
      const cap = gateOp({ surface, op: p.operation, opClasses: hd.opClasses, mutating: hd.mutating, ref: ticketRef });
      if (!cap.allowed && cap.enforced)
        return text(`'${p.operation}' is NOT allowed in this mode: ${cap.reason}. A human must do that in the console. Put your recommendation in an internal note instead.`);
      if (p.operation === "create_global_kb_article") {
        let auth = null;
        try { auth = globalKnowledgeAuthorisation(); } catch (e) { /* deny below */ }
        if (!auth) {
          return text(
            "Not permitted: a GLOBAL KB article may be created only when the technician " +
              "explicitly asks in this chat to create/write/publish a global KB article. " +
              "Do not retry or substitute the company-scoped upsert_ai_kb_article operation.",
          );
        }
      }
      // Customer-email gate. In WS mode (gate provided) we ask the tech for approval
      // inline (exactly like a device-command approval); in the legacy POST mode we
      // fall back to the per-turn allowCustomerReply flag.
      let replyAuth = null;
      if (cap.cls === "customer") {
        const g = gate ? await gate("email", `Send this reply to the customer on ${ticketRef}:\n\n${(p.message || p.customer_html || "").slice(0, 800)}`) : { ok: false, reason: "no approval channel available." };
        if (!g.ok) return text(g.reason || "Customer reply not approved. Leave it as a draft.");
        // Provenance for an outbound email goes in an INTERNAL note, never appended to the
        // customer's message - the customer must not read our approval plumbing.
        replyAuth = g.authorised_by || null;
      }
      // RECORDING A CREDENTIAL (IT Notebook row). The AI may do the work; the decision to
      // write it down stays with the technician - either they instructed it in their own
      // words, or they approve the prompt. Denied outright on every other surface by
      // SURFACE_CLASSES, so this branch is the only way in.
      //
      // The prompt shows the ROW, with secret-looking fields masked. A technician cannot
      // sensibly approve "write something somewhere", and equally must not have the
      // password splashed into the transcript to find out what they are approving.
      let notebookAuth = null;
      let notebookWrote = null;
      if (cap.cls === "secret_write") {
        // Everything shown to the technician is built by notebookWriteSummary(), which is
        // a pure exported function so it can be tested. The first version of this branch
        // was inline and referenced an `op` variable that does not exist in this scope -
        // a ReferenceError that only fired when a technician actually tried to save a row,
        // because nothing here was reachable from a test. Hence the extraction.
        notebookWrote = notebookWriteSummary({
          operation: p.operation,
          args: p.args || {},
          params: p,
          ticketRef,
        });
        const g = gate
          ? await gate("secret_write", notebookWrote.summary)
          : { ok: false, reason: "no approval channel available - the IT Notebook can only be written from the ai-decision window." };
        if (!g.ok) {
          return text(
            (g.reason || "Writing to the IT Notebook was not permitted.") +
            " Show the technician the row you would have saved, as a table they can paste, and continue with the rest of the work.",
          );
        }
        notebookAuth = g.authorised_by || null;
      }
      // CREDENTIALS: the technician permits each retrieval at the time. Denied outright on
      // every other surface by SURFACE_CLASSES, so this branch is the only way in.
      if (cap.cls === "secret") {
        const A = p.args || {};
        const who = p.company_name || p.partner_id || A.company_name || A.partner_id || "this company";
        const wantsPriv = !!(p.include_privileged || A.include_privileged);
        // The privileged flag travels as DATA, not as a phrase in the summary: it decides
        // whether Auto-credential may cover this read, and a gate must never have to parse
        // English to work that out.
        const g = gate
          ? await gate("secret", `Read STORED CREDENTIALS (IT Notebook) for ${who}, requested on ${ticketRef}. ` +
              `The AI will be able to see the usernames and passwords it returns.` +
              (wantsPriv
                ? ` IT IS ALSO ASKING FOR THE PRIVILEGED ROWS, which are normally withheld.`
                : ` Privileged rows will be withheld.`),
              { privileged: wantsPriv })
          : { ok: false, reason: "no approval channel available - credentials can only be read in the ai-decision window." };
        if (!g.ok)
          return text(
            (g.reason || "Reading the stored credentials was not permitted.") +
              " Do not retry it and do not ask the customer for their password. If you need it, say " +
              "which system you need it for and let the technician decide.",
          );
      }
      // Closing a ticket asks a human EVERY time - never auto-approvable (ISSUES.md
      // D2/I7). MANDATE 4.8: "the model never decides that a ticket may be closed"; this
      // surface only holds `close` authority because a human approves it at the time.
      let closeAuth = null;
      if (cap.cls === "close") {
        const why = (p.internal_note || p.reason || p.customer_html || p.message || "").slice(0, 800);
        const g = gate
          ? await gate("close", `${p.cancel ? "CANCEL" : "CLOSE"} ${ticketRef} via ${p.operation}${why ? ":\n\n" + why : ""}`)
          : { ok: false, reason: "no approval channel available." };
        if (!g.ok) return text(g.reason || "Closing this ticket was not approved. Leave your recommendation in an internal note instead.");
        // When the close went through on the technician's own instruction rather than a
        // prompt, the ticket must say so, in their words. Without this the audit trail shows
        // a ticket closed by the bot with no visible authority - which is the thing the
        // approval prompt used to provide, and the reason it can safely be skipped.
        closeAuth = g.authorised_by || null;
      }
      // Merge the named params + free-form args, then ALWAYS inject this ticket's ref
      // so a read/write can never fail with 'ticket not found: undefined'.
      const args = { ...(p.args || {}) };
      for (const k of ["message", "internal_note", "customer_html", "reason", "cancel",
        "company_partner_id", "partner_id", "article_id", "title", "content", "name", "domain", "email"])
        if (p[k] !== undefined && args[k] === undefined) args[k] = p[k];
      if (closeAuth) {
        const stamp =
          `\n\n[Closed on the technician's instruction in the AI chat` +
          `${closeAuth.at ? ` at ${closeAuth.at.slice(11, 16)} UTC` : ""}: ` +
          `"${String(closeAuth.text).replace(/\s+/g, " ").trim()}"]`;
        // Attach to whichever field this deployment's operation uses for its note/reason.
        const field = args.internal_note !== undefined ? "internal_note"
                    : args.reason !== undefined ? "reason"
                    : args.message !== undefined ? "message" : "reason";
        args[field] = String(args[field] || "") + stamp;
      }
      if (ticketRef && args.ticket === undefined && args.ticket_ref === undefined) args.ticket = ticketRef;
      try {
        const out = await hd.operations[p.operation](args);
        // Record WHO drove this, as it happens. The helpdesk will log the API user as the
        // actor; this is the only place that knows a person was sitting here directing it.
        if (creditActor && ["customer", "close", "note", "create", "routing"].includes(cap.cls)) {
          trmm.creditAction({
            ticket_ref: ticketRef, actor_username: creditActor,
            action: cap.cls === "customer" ? "reply" : cap.cls,
            surface: "decision_chat",
            session_id: (typeof creditSession === "function" ? creditSession() : creditSession) || "",
            detail: `${p.operation} via the ticket chat`,
          }).catch(() => { /* credit is bookkeeping; never fail the operation for it */ });
        }
        // A credential that changed with nothing recording who decided it is precisely the
        // audit hole this class exists to close. The note goes in the ticket, so it carries
        // the ROW and the AUTHORITY and never a value - column names only.
        // (Not routed through trmm.creditAction: that endpoint takes a fixed set of action
        // names and inventing one here would fail silently against an API this code cannot
        // see. The bridge log and this note are the record.)
        if (notebookWrote && hd.operations.add_note) {
          try {
            const how = notebookAuth
              ? `on the technician's instruction in the AI chat` +
                `${notebookAuth.at ? ` at ${notebookAuth.at.slice(11, 16)} UTC` : ""}: ` +
                `"${String(notebookAuth.text).replace(/\s+/g, " ").trim()}"`
              : `with the technician's approval in the AI chat`;
            await hd.operations.add_note({ ticket: ticketRef, message:
              `[IT Notebook updated ${how}. Target: ${notebookWrote.notebook}` +
              `${notebookWrote.rowRef ? `, row "${notebookWrote.rowRef}"` : ""}` +
              `${notebookWrote.columns.length ? `. Columns written: ${notebookWrote.columns.join(", ")}` : ""}` +
              `. Values are stored in the notebook only - no credential is recorded in this ticket.]` });
          } catch (e) { /* the row is saved; a failed provenance note must not undo that */ }
        }
        if (replyAuth && hd.operations.add_note) {
          // Best-effort: the reply already went out; a failed note must not fail the call.
          try {
            await hd.operations.add_note({ ticket: ticketRef, message:
              `[Customer reply sent on the technician's instruction in the AI chat` +
              `${replyAuth.at ? ` at ${replyAuth.at.slice(11, 16)} UTC` : ""}: ` +
              `"${String(replyAuth.text).replace(/\s+/g, " ").trim()}"]` });
          } catch (e) { /* provenance note is not worth failing the operation over */ }
        }
        return text(typeof out === "string" ? capString(out, 20000) : capJson(out, { maxBytes: 20000, what: "helpdesk" }));
      }
      catch (e) { return text(`${p.operation} failed: ${e?.message || e}`); }
    },
  });

  const run_device_command = defineTool({
    name: "run_device_command",
    label: "Run device command",
    description:
      "Run a command on a device to DIAGNOSE or FIX an issue. Get the agent_id from find_devices. " +
      "READ-ONLY/diagnostic commands run freely. ANY command that MODIFIES the device (installing, " +
      "changing config, restarting/stopping a service, editing files, reboots, deleting data, etc.) " +
      "requires Write mode: it is BLOCKED while the chat is read-only, and needs the technician's " +
      "approval when Write mode is on (unless Auto-approve is enabled). NEVER delete data. Always " +
      "diagnose read-only first.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "Target device agent_id (from find_devices)" }),
      shell: Type.String({ description: "powershell | cmd | bash" }),
      command: Type.String({ description: "The command to run" }),
      timeout: Type.Optional(Type.Number({ description: "Seconds (default 45)" })),
      capture_as: Type.Optional(
        Type.String({
          description:
            "Hold this command's output in the bridge under this name INSTEAD of returning it to " +
            "you. You get a receipt (size, lines, sha256, first/last line), not the content, so a " +
            "large file costs you no context. This is how you send a big file: e.g. " +
            "`cat /tmp/export.csv` with capture_as='export', then attach_capture (to the ticket) " +
            "or send_email (attach_capture_name='export'). For binary, pipe through base64 and " +
            "set decode_base64 when sending.",
        }),
      ),
    }),
    execute: async (_id, p, signal) => {
      // ALWAYS-ON privileged-action gate (identity/access): adding/removing users,
      // permission/group changes, licenses, mailbox delegates, password/MFA resets can
      // ONLY run when the ticket requester is an APPROVED support contact for the company
      // (Primary/Secondary Support Contact in Odoo). This is deterministic and applies
      // even in Write mode / Auto-approve - no exceptions.
      if (privilegedMatch(p.command)) {
        let authz = null;
        try { if (hd?.operations?.check_support_authorization) authz = await hd.operations.check_support_authorization({ ticket: ticketRef }); } catch { /* verify below */ }
        if (!authz || !authz.authorized) {
          return text(
            "BLOCKED - PRIVILEGED identity/access change (add/remove user, permissions, group membership, " +
            "licenses, mailbox delegate, or password/MFA). This can only be performed when an APPROVED " +
            "support contact authorizes it. " +
            (authz
              ? `Requester "${authz.requester}" is NOT an authorized support contact for ${authz.company}. Authorized contacts: ${(authz.authorized_contacts || []).join("; ") || "none set in Odoo"}. `
              : "Authorization could not be verified. ") +
            "Get an authorized support contact to request or approve this FIRST, then proceed.",
          );
        }
      }
      // Gate ANY command that would MODIFY the device (not just "destructive" ones) -
      // same rule as the device chat: in read-only (Write mode off) it's blocked; with
      // Write mode on it needs approval (unless Auto-approve). Pure read-only diagnostics
      // run freely.
      const win = (p.shell || "powershell") !== "bash";
      if (mutatingMatch(p.command, win)) {
        const g = gate
          ? await gate("device", `Run a command that MODIFIES ${p.agent_id} [${p.shell || "powershell"}]:\n\n${p.command}`)
          : { ok: false, reason: "no approval channel available." };
        if (!g.ok) return text("REFUSED: " + (g.reason || "the technician did not approve that change."));
      }
      try {
        const out = await trmm.sendCmd(p.agent_id, {
          shell: p.shell || "powershell", cmd: p.command,
          timeout: p.timeout && p.timeout > 0 ? p.timeout : 45,
        }, { signal });
        const raw = typeof out === "string" ? out : JSON.stringify(out);
        if (p.capture_as && String(p.capture_as).trim()) {
          const nm = String(p.capture_as).trim().slice(0, 80);
          const rec = capStore.put(nm, raw, `${p.agent_id}: ${p.command.slice(0, 120)}`);
          if (rec.error) return text(rec.error);
          return text(captureReceipt(rec, " with attach_capture or send_email"));
        }
        // capString, not slice: a silent truncation makes the model think it saw
        // everything, and it re-runs the same broad command to find the rest.
        return text(capString(raw, 20000, "device command output"));
      } catch (e) { return text("run_device_command failed: " + (e?.message || e)); }
    },
  });

  const find_devices = defineTool({
    name: "find_devices",
    label: "Find device(s)",
    description: "Find the RMM client + a user's device(s) by company (domain/name) + username. READ-ONLY.",
    parameters: Type.Object({
      domain: Type.Optional(Type.String()),
      company_name: Type.Optional(Type.String()),
      username: Type.Optional(Type.String()),
      person_name: Type.Optional(Type.String({ description: "Requester full name (improves matching)" })),
      hostname: Type.Optional(Type.String({ description: "A device/server HOSTNAME named in the ticket (e.g. pve01) - the right way to find servers/infrastructure" })),
    }),
    execute: async (_id, p) => {
      try { return text(capJson(await trmm.resolveDevices({ domain: p.domain, company_name: p.company_name, username: p.username, person_name: p.person_name, hostname: p.hostname }), { what: "device match" })); }
      catch (e) { return text(`find_devices failed: ${e?.message || e}`); }
    },
  });

  const get_device_notes = defineTool({
    name: "get_device_notes",
    label: "Read device notes",
    description:
      "Read the durable Pi.dev memory notes already saved on a device (its role, disk/volume layout, " +
      "service/container names, vendor quirks, and past fixes). Get agent_id from find_devices. Use " +
      "this to recall what's already known about a machine before diagnosing or acting.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "Target device agent_id (from find_devices)" }),
    }),
    execute: async (_id, p, signal) => {
      try {
        const out = await trmm.getDeviceNotes(p.agent_id, { signal });
        const notes = (out && out.notes) || "";
        return text(notes ? notes : "(no device notes saved yet)");
      } catch (e) { return text("Could not read device notes: " + (e?.message || e)); }
    },
  });

  const save_device_note = defineTool({
    name: "save_device_note",
    label: "Save device note",
    description:
      "Save a durable, DEVICE-SPECIFIC fact to a machine's Pi.dev memory (the per-device notes in " +
      "RMM) so future Pi runs on THAT device start with this context. Use this - NOT the KB - for " +
      "anything tied to one machine: its role/purpose, disk/volume/pool layout, service/container " +
      "names, install paths, hardware quirks, and fixes that worked on it. Get agent_id from " +
      "find_devices. Keep each note to ONE short line (~200 chars). Never save secrets, transient " +
      "state, or personal data.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "Target device agent_id (from find_devices)" }),
      note: Type.String({ description: "One concise, durable fact about this device." }),
    }),
    execute: async (_id, p, signal) => {
      try { await trmm.saveDeviceNote(p.agent_id, p.note, { signal }); return text("Saved to device memory."); }
      catch (e) { return text("Could not save device note: " + (e?.message || e)); }
    },
  });

  const schedule_action = defineTool({
    name: "schedule_action",
    label: "Schedule an action",
    description:
      "Schedule work to run AUTOMATICALLY at a specific time (e.g. a maintenance window). " +
      "ONLY use this when the technician explicitly asks to schedule something - never on your " +
      "own. The job runs ONCE at run_at on the given device, updates the ticket, then removes " +
      "itself. Confirm the device, time, and action with the tech first.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "Target device agent_id (from find_devices)" }),
      run_at: Type.String({ description: "ISO 8601 datetime, e.g. 2026-07-22T07:00:00Z (UTC) or with offset" }),
      action: Type.String({ description: "Exactly what to do at that time (clear, specific)" }),
      allow_mutating: Type.Optional(Type.Boolean({ description: "Allow changes on the device (default true)" })),
    }),
    execute: async (_id, p) => {
      try {
        const out = await trmm.scheduleAction({
          agent_id: p.agent_id, ticket_ref: ticketRef || "", action: p.action,
          run_at: p.run_at, allow_mutating: p.allow_mutating !== false,
        });
        return text(JSON.stringify(out));
      } catch (e) { return text("schedule_action failed: " + (e?.message || e)); }
    },
  });

  const list_scheduled_actions = defineTool({
    name: "list_scheduled_actions",
    label: "List scheduled AI actions",
    description:
      "List one-shot AI scheduled jobs (created via schedule_action). ALWAYS check this when " +
      "finishing/closing a ticket or when a follow-up is no longer needed, then cancel any " +
      "jobs that are superseded. Defaults to this ticket + status=scheduled.",
    parameters: Type.Object({
      ticket_ref: Type.Optional(Type.String({ description: "Ticket ref filter (defaults to this ticket)" })),
      agent_id: Type.Optional(Type.String({ description: "Optional device agent_id filter" })),
      status: Type.Optional(Type.String({ description: "scheduled|running|done|error|cancelled (default scheduled)" })),
    }),
    execute: async (_id, p) => {
      try {
        const out = await trmm.listScheduledActions({
          agent_id: p.agent_id || undefined,
          ticket_ref: p.ticket_ref || ticketRef || undefined,
          status: p.status || "scheduled",
        });
        return text(JSON.stringify(out, null, 2));
      } catch (e) { return text("list_scheduled_actions failed: " + (e?.message || e)); }
    },
  });

  const cancel_scheduled_action = defineTool({
    name: "cancel_scheduled_action",
    label: "Cancel a scheduled AI action",
    description:
      "Delete/cancel a one-shot scheduled AI job by numeric id. REQUIRED when work finishes early " +
      "or a later check supersedes an earlier scheduled follow-up — stale jobs must not fire. " +
      "Get ids from list_scheduled_actions or the id returned by schedule_action.",
    parameters: Type.Object({
      id: Type.Number({ description: "Scheduled action id (e.g. 31)" }),
    }),
    execute: async (_id, p) => {
      try {
        const out = await trmm.deleteScheduledAction(p.id);
        return text(JSON.stringify(out || { ok: true, id: p.id, cancelled: true }));
      } catch (e) { return text("cancel_scheduled_action failed: " + (e?.message || e)); }
    },
  });

  const send_email = defineTool({
    name: "send_email",
    label: "Send email",
    description:
      "Send an email through the RMM server's SMTP (the same mail Pi.dev uses everywhere). Use this " +
      "for INTERNAL / STAFF / VENDOR email - e.g. sending a purchase recommendation to procurement, a " +
      "heads-up to a colleague, or a parts order. For CUSTOMER communication ABOUT the ticket use " +
      "reply_to_ticket / resolve_ticket instead (keeps it on the ticket thread). Supports HTML with " +
      "inline styles plus a plain-text fallback. BRAND + COLOR SAFETY (www.blueuc.com): primary #00C4FF, text #212529, light #F6F5F4, dark #1B1319. " +
      "Logo https://www.blueuc.com/web/image/1330-24f164ad/blue_cloud_logo_A.png on light header with cyan bottom border. " +
      "Dark text on light backgrounds only — NEVER white text on navy/gradient headers. Table th: bg #00C4FF color #212529. " +
      "Footer with logo + BlueCloud IAAS, LLC + 855-258-3456 + support@blueuc.com. " +
      "From identity is SERVER-CHOSEN: tech's real name + " +
      "email when allowlisted, otherwise pi-*@ with the company brand display name (e.g. BlueCloud " +
      "Support). Do not invent a sender name.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient email address(es), comma-separated" }),
      subject: Type.String({ description: "Subject line" }),
      body: Type.String({ description: "Plain-text body (also the fallback for HTML clients)" }),
      html: Type.Optional(Type.String({ description: "Optional HTML body (inline styles only)" })),
      attach_capture_name: Type.Optional(
        Type.String({
          description:
            "Name of a capture (from capture_as) to attach to this email. The bridge holds " +
            "the bytes, so file size costs you no context. This is the ONLY way to email a " +
            "large file - never paste file contents into `body`.",
        }),
      ),
      attachment_filename: Type.Optional(
        Type.String({ description: "Filename the recipient sees, e.g. export.csv (required with attach_capture_name)" }),
      ),
      decode_base64: Type.Optional(
        Type.Boolean({ description: "Decode the capture from base64 first (for binary files such as xlsx/pdf)" }),
      ),
    }),
    execute: async (_id, p, signal) => {
      let att = null;
      if (p.attach_capture_name) {
        const cap = capStore.get(p.attach_capture_name);
        if (!cap)
          return text(`No capture named "${p.attach_capture_name}". Available: ${capStore.names().join(", ") || "(none)"}.`);
        if (!p.attachment_filename) return text("attachment_filename is required when attaching a capture.");
        att = {
          attachment_base64: p.decode_base64 ? cap.data.replace(/\s+/g, "") : Buffer.from(cap.data, "utf8").toString("base64"),
          attachment_filename: p.attachment_filename, bytes: cap.bytes, lines: cap.lines,
        };
        if (gate) {
          const g = await gate("device", `Email ${p.to} with ATTACHMENT ${att.attachment_filename} (${att.bytes} bytes, ${att.lines} lines): "${p.subject}"`);
          if (!g.ok) return text("REFUSED: " + (g.reason || "the technician did not approve sending that file."));
        }
      }
      try {
        const out = await trmm.sendEmail(
          // from_name is server policy (tech real name vs brand) — never model-supplied
          { to: p.to, subject: p.subject, body: p.body, html: p.html,
            actor_email: actorEmail || undefined, actor_name: actorName || undefined,
            attachment_base64: att ? att.attachment_base64 : undefined,
            attachment_filename: att ? att.attachment_filename : undefined },
          { signal },
        );
        return text(typeof out === "string" ? capString(out) : capJson(out, { what: "helpdesk" }));
      } catch (e) { return text("send_email failed: " + (e?.message || e)); }
    },
  });

  // CAPTURE A PROCEDURE FROM THE WORK JUST DONE.
  //
  // Until now procedures were only ever written by the miner, from CLOSED tickets, hours or
  // days later - so the knowledge captured was whatever survived into the closing notes. The
  // moment worth capturing is this one: the tech has just explained something, or we have
  // just worked out what a recurring notification means and what fixes it.
  //
  // DRAFT ONLY, and not negotiable: status=draft, auto_enabled=false, origin=ai_resolution.
  // A procedure that carries a `disposition` can make the engine rule on tickets without a
  // model call, so nothing the model writes may be live until a human approves it in the
  // console. The model proposes; a person promotes.
  const attach_capture = defineTool({
    name: "attach_capture",
    label: "Attach a captured file to this ticket",
    description:
      "Attach a file captured with run_device_command(capture_as=...) to a ticket. THIS is how " +
      "you send a large file: the bridge holds the bytes, so size costs you no context, and the " +
      "file cannot be truncated or altered by you. to_customer=true sends it as the branded " +
      "customer reply (an email really goes out); false attaches it as a staff-only internal " +
      "note. Use decode_base64=true when the captured output was base64 (binary files).",
    parameters: Type.Object({
      capture: Type.String({ description: "Name given to capture_as" }),
      ticket: Type.String({ description: "Ticket reference, e.g. TICKET/55726" }),
      filename: Type.String({ description: "Filename the recipient sees, e.g. export.csv" }),
      message: Type.String({ description: "Internal note text, or the customer-facing reply body" }),
      to_customer: Type.Optional(Type.Boolean({ description: "true = email the customer (default false = internal note)" })),
      decode_base64: Type.Optional(Type.Boolean({ description: "Decode the capture from base64 first" })),
    }),
    execute: async (_id, p) => {
      if (!hd) return text("Helpdesk integration is not configured" + (hdError ? ": " + hdError : "") + ".");
      const cap = capStore.get(p.capture);
      if (!cap)
        return text(`No capture named "${p.capture}". Available: ${capStore.names().join(", ") || "(none)"}.`);
      const op = p.to_customer ? "reply_to_ticket" : "attach_file";
      if (!hd.operations[op]) return text(`This helpdesk has no "${op}" operation.`);
      const capRes = gateOp({ surface, op, opClasses: hd.opClasses, mutating: hd.mutating });
      if (!capRes.allowed && capRes.enforced) return text(`Not permitted on this surface: ${capRes.reason}`);
      if (gate) {
        const g = await gate(
          "device",
          `Attach ${p.filename} (${cap.bytes} bytes, ${cap.lines} lines) to ${p.ticket}` +
            (p.to_customer ? " AND EMAIL IT TO THE CUSTOMER" : " as a staff-only internal note"),
        );
        if (!g.ok) return text("REFUSED: " + (g.reason || "the technician did not approve that."));
      }
      const file = { filename: p.filename };
      if (p.decode_base64) file.content_base64 = cap.data.replace(/\s+/g, "");
      else file.content = cap.data;
      try {
        const res = await hd.operations[op]({ ticket: p.ticket, message: p.message, files: [file] });
        if (res && res.error) return text("attach failed: " + res.error);
        return text(
          `Attached ${p.filename} to ${p.ticket} (${cap.bytes} bytes, ${cap.lines} lines, sha256 ` +
            `${cap.sha256.slice(0, 16)}...). ` +
            (p.to_customer ? "Customer reply SENT with the file attached." : "Posted as a staff-only internal note.") +
            ` Result: ${JSON.stringify(res)}`,
        );
      } catch (e) { return text("attach failed: " + (e?.message || e)); }
    },
  });

  const save_procedure = defineTool({
    name: "save_procedure",
    label: "Capture a procedure (draft)",
    description:
      "Write down what you just learned as a reusable PROCEDURE, so the next occurrence is not" +
      " solved from scratch. Use it when a ticket taught you something generalisable: a symptom" +
      " with a real root cause and a fix that worked, or a recurring vendor notification and what" +
      " it actually means. Keep it CLIENT-AGNOSTIC - no customer names, no one-off device history" +
      " (use save_device_note for that). It is saved as a DRAFT for a human to approve; you are" +
      " never creating live automation. If a recurring NOTIFICATION is involved, also fill in the" +
      " recognition fields so a person can promote it into something the system handles" +
      " deterministically: match_subject_regex / match_body_all / match_body_any / match_body_none," +
      " condition_key, and what the right disposition would be.",
    parameters: Type.Object({
      title: Type.String({ description: "Short, specific title of the situation" }),
      category: Type.Optional(Type.String({ description: "e.g. Backup, Microsoft 365, Networking, Printing" })),
      applies_to: Type.Optional(Type.String({
        description: "Comma-separated vendor/app/OS keywords AND phrases that identify when this applies",
      })),
      symptom: Type.String({ description: "What is observed, in the words it usually arrives in" }),
      root_cause: Type.Optional(Type.String({ description: "Why it happens" })),
      fix: Type.String({ description: "The steps that resolve it, specific enough to follow verbatim" }),
      verification: Type.Optional(Type.String({ description: "How to prove it is actually fixed" })),
      condition_key: Type.Optional(Type.String({
        description: "For a RECURRING condition: a stable key, e.g. vendor-thing-that-is-wrong",
      })),
      match_subject_regex: Type.Optional(Type.String({ description: "Regex the ticket SUBJECT must match" })),
      match_body_all: Type.Optional(Type.Array(Type.String(), { description: "Phrases that must ALL appear" })),
      match_body_any: Type.Optional(Type.Array(Type.String(), { description: "Phrases where at least ONE must appear" })),
      match_body_none: Type.Optional(Type.Array(Type.String(), { description: "Phrases that disqualify the match" })),
      identity_host_regex: Type.Optional(Type.String({ description: "Regex with one capture group for the host name" })),
      suggested_disposition: Type.Optional(Type.String({
        description: "benign | customer_action | our_action | needs_human - what a match SHOULD mean",
      })),
      source_ticket_ref: Type.Optional(Type.String({ description: "The ticket this came from" })),
    }),
    execute: async (_id, p) => {
      const match = {};
      if (p.match_subject_regex) match.subject_regex = p.match_subject_regex;
      if (p.match_body_all?.length) match.body_all = p.match_body_all;
      if (p.match_body_any?.length) match.body_any = p.match_body_any;
      if (p.match_body_none?.length) match.body_none = p.match_body_none;
      if (p.identity_host_regex) match.identity = { host_regex: p.identity_host_regex };
      const DISPOS = ["benign", "customer_action", "our_action", "needs_human"];
      const body = {
        title: p.title,
        category: p.category || "",
        applies_to: (p.applies_to || "").slice(0, 400),
        symptom: p.symptom || "",
        root_cause: p.root_cause || "",
        fix: p.fix || "",
        verification: p.verification || "",
        condition_key: (p.condition_key || "").slice(0, 120),
        match,
        // Proposed, not applied: the engine ignores both until a human approves the row and
        // ticks auto-enable, which is exactly the review step this tool must not skip.
        disposition: DISPOS.includes(String(p.suggested_disposition)) ? p.suggested_disposition : "",
        evidence: p.condition_key ? "notification" : "none",
        repeat_policy: p.condition_key
          ? { advise_once: true, suppress_repeats: true, resolve_after_days: 7 }
          : {},
        auto_enabled: false,
        status: "draft",
        origin: "ai_resolution",
        confidence: "medium",
        occurrence_count: 1,
        source_ticket_refs: [p.source_ticket_ref || ticketRef].filter(Boolean),
      };
      try {
        const out = await trmm.saveProcedure(body);
        const id = out && (out.id || out.pk);
        return text(
          `Procedure saved as a DRAFT${id ? ` (id ${id}, code ${String(id).padStart(7, "0")})` : ""}.` +
          ` It is NOT live: a human reviews it in Ticket Console -> Procedures and approves it there.` +
          (p.condition_key
            ? ` Recognition fields were included, so whoever reviews it can promote it into a rule the` +
              ` system applies deterministically - that promotion is theirs to make, not yours.`
            : ""),
        );
      } catch (e) {
        return text(`Could not save the procedure: ${String(e?.message || e).slice(0, 300)}`);
      }
    },
  });

  const operatorTools = operatorPlugin?.buildOperatorTools({
    Type, defineTool, text, operatorPolicy, operatorActor, surface: "ai-decision",
    // gate("device") already enforces read-only and the approval prompt here, so the
    // read-only check is folded into it and isReadonly is left null on purpose.
    approve: (summary) => (gate ? gate("device", summary) : { ok: false, reason: "no approval channel available." }),
    mutatingMatch,
  }) || [];



  // ---- Sales / ERP quotations (optional, decision-chat only when enabled) ----
  let sales = null;
  let salesError = null;
  if (salesEnabled && salesCode) {
    try {
      sales = loadSales(salesCode, salesApi || helpdeskApi || null, {
        ticket_ref: ticketRef || "",
        actor_email: actorEmail || "",
        actor_name: actorName || "",
        actor_username: creditActor || "",
      });
    } catch (e) {
      salesError = String(e?.message || e);
      sales = null;
    }
  }
  let sales_call = null;
  if (sales) {
    const sOpList = sales.names.map((n) => `  - ${n}${sales.meta[n] ? ": " + sales.meta[n] : ""}`).join("\n");
    sales_call = defineTool({
      name: "sales_call",
      label: "Sales / ERP operation",
      description:
        "Sales/ERP operations for quotations (create draft quote in the ERP, read it, link to this ticket). " +
        "ONLY when the technician explicitly asks to create/push a quote INTO the ERP/Odoo — never because " +
        "they asked you to email a quote to the customer. Draft only; never confirm a Sales Order. " +
        "create_quotation MUST match S00064 quality: structured sections/notes + billable lines + " +
        "note_html = EXACT full HTML body from the customer quote send_email (paste it, do not rewrite; usually 12k-25k chars). " +
        "Required: option_label, nte, customer_blurb, project_blurb, workloads>=2, phases>=3, assumptions>=3, " +
        "out_of_scope>=3, next_steps>=2, lines[]. Thin quotes (S00063) or weak Terms (S00065) are REFUSED. " +
        "Available operations:\n" + (sOpList || "  (none)"),
      parameters: Type.Object({
        operation: Type.String({ description: "Operation name from the list above" }),
        args: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Operation arguments" })),
        // Common create_quotation fields also accepted top-level for convenience
        lines: Type.Optional(Type.Array(Type.Object({
          name: Type.String(),
          qty: Type.Optional(Type.Number()),
          price_unit: Type.Optional(Type.Number()),
          product_name: Type.Optional(Type.String()),
        }, { additionalProperties: true }))),
        partner_id: Type.Optional(Type.Number()),
        note_html: Type.Optional(Type.String()),
        order_id: Type.Optional(Type.Number()),
        name: Type.Optional(Type.String()),
        ticket_ref: Type.Optional(Type.String()),
      }),
      execute: async (_id, p) => {
        if (!sales || !sales.operations[p.operation]) return text(`sales operation ${p.operation} not available`);
        const cap = gateOp({ surface: surface || "decision_chat", op: p.operation, opClasses: sales.opClasses, mutating: sales.mutating, ref: ticketRef });
        if (!cap.allowed && cap.enforced)
          return text(`'${p.operation}' is NOT allowed here: ${cap.reason}`);
        // Mutating sales ops ALWAYS require human approval (Auto-approve cannot skip).
        if (sales.mutating.has(p.operation)) {
          const summary = `Sales ERP: ${p.operation} on ${ticketRef || "(no ticket)"}\n` +
            JSON.stringify({ lines: p.lines, partner_id: p.partner_id, order_id: p.order_id, args: p.args }, null, 0).slice(0, 600);
          const g = gate
            ? await gate("sales", summary)
            : { ok: false, reason: "no approval channel — sales writes only in the decision chat." };
          if (!g.ok) return text(g.reason || "Sales operation not approved.");
        }
        const args = { ...(p.args || {}) };
        for (const k of ["lines", "partner_id", "note_html", "order_id", "name", "ticket_ref"])
          if (p[k] !== undefined && args[k] === undefined) args[k] = p[k];
        if (ticketRef && args.ticket_ref === undefined) args.ticket_ref = ticketRef;
        if (!args.salesperson_email && actorEmail) args.salesperson_email = actorEmail;
        try {
          const out = await sales.operations[p.operation](args);
          return text(typeof out === "string" ? capString(out, 20000) : capJson(out, { maxBytes: 20000, what: "helpdesk" }));
        } catch (e) {
          return text(`${p.operation} failed: ${e?.message || e}`);
        }
      },
    });
  }

  const baseTools = [helpdesk_call, find_devices, deviceHardwareTool(), run_device_command, attach_capture, save_device_note, get_device_notes, schedule_action, list_scheduled_actions, cancel_scheduled_action, send_email, save_procedure, ...operatorTools, ...webTools()];
  if (sales_call) baseTools.push(sales_call);
  return { tools: baseTools, hd, hdError, sales, salesError };
}

