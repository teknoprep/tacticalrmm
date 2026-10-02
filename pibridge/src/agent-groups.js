// Agent Groups: a roster of specialist models sitting next to the orchestrator.
//
// The technician talks to ONE model (the orchestrator). That model can `delegate`
// a narrow job to a cheaper specialist with a fresh context window, so a long
// ticket does not keep re-sending every file read / log dump through Grok.
//
// Roles with a workspace (Coding group, optional path) get real file tools in an
// isolated child session. Roles without a workspace run as a think-only one-shot
// (scout a blob of text, draft a plan, review a script, summarise). The parent
// keeps the TRMM tools.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachSpendLedger } from "./spend-ledger.js";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerModels } from "./models-catalog.js";
import { webSearchRaw, webFetchRaw } from "./tools.js";

const ROLE_TOOLS = {
  scout: ["read", "grep", "find", "ls"],
  files: ["read", "ls"],
  grep: ["grep", "find"],
  planner: ["read", "grep", "find", "ls"],
  coder: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  reviewer: ["read", "grep", "find", "ls"],
};

const THINK_ROLES = new Set(["orchestrator", "operator", "summarizer", "planner", "reviewer", "scout"]);

export function makeGroupState(blob) {
  // `spend` is the accounting identity of the CONVERSATION that owns this group, set by
  // the surface right after it builds the state. Specialists run in a temp directory that
  // is deleted the moment they finish, so unless their turns are billed against the parent
  // session here, that money leaves no trace anywhere at all - not in the ledger, not even
  // in a transcript on disk. See spend-ledger.js.
  return {
    current: blob?.agent_group || null, rt: null, spend: null,
    // Every group this user can use (public_groups, with roles). Read live: the blob's list is
    // replaced on refresh. Lets a chat with NO group borrow a configured summarizer.
    get all() { return Array.isArray(blob?.agent_groups) ? blob.agent_groups : []; },
  };
}

/**
 * HEADLESS SURFACES (triage, autowork; owner 2026-09-27). A group chosen in the RMM applies
 * to a headless run exactly as it does to a chat: the group's ORCHESTRATOR runs the work, its
 * roster is appended to the prompt so the orchestrator can `delegate`, code/ web calls route to
 * the coder/researcher roles, and every turn is billed to the parent session (groupState.spend).
 *
 * Authority is deliberately UNCHANGED: this surface's gate still decides what may happen. The
 * group changes which model thinks (and what it can delegate), never what is permitted. That is
 * why no judge is attached here - triage holds no mutating tool at all, and autowork's gate
 * refuses every device change and leaves customer contact to code after the verdict, so a judge
 * would have nothing to review.
 *
 * Returns { groupState, model } - `model` is the group's orchestrator, or null meaning "use the
 * model the caller put in the blob" (no group configured, or a group with no orchestrator).
 */
export async function applyHeadlessGroup(blob, rt, log) {
  const group = blob?.agent_group;
  if (!group) return { groupState: null, model: null, orchestrator: null };
  const groupState = makeGroupState(blob);
  groupState.rt = rt;
  try {
    await ensureGroupModels(rt, blob, log);
  } catch (e) {
    log?.("group_models_error", "headless", "-", String(e?.message || e).slice(0, 200));
  }
  const orch = (group.members || group.roles || []).find((m) => m.role === "orchestrator" && m.enabled !== false) || null;
  const model = orch ? rt.findModel(orch.provider, orch.model_id) : null;
  if (orch && !model) log?.("group_model_missing", "headless", orch.provider, `${orch.provider}/${orch.model_id}`);
  return { groupState, model, orchestrator: model ? orch : null };
}

export function mergeGroupKeys(keys, blob) {
  const extra = blob?.agent_group_keys || {};
  for (const [p, k] of Object.entries(extra)) if (k) keys[p] = k;
  return keys;
}

export async function ensureGroupModels(rt, blob, log) {
  const group = blob?.agent_group;
  const members = group?.members || group?.roles || [];
  if (!members.length) return;
  const wanted = [];
  for (const m of members) {
    if (!m.provider || !m.model_id) continue;
    if (rt.findModel(m.provider, m.model_id)) continue;
    wanted.push({
      provider: m.provider,
      model_id: m.model_id,
      display_name: m.display_name || m.model_id,
    });
  }
  if (!wanted.length) return;
  const providers = Object.entries(blob.agent_group_keys || {}).map(([name, api_key]) => ({
    name,
    api_key,
  }));
  try {
    const out = await registerModels(providers, rt, wanted);
    log?.("agent_group_register", wanted.map((w) => `${w.provider}/${w.model_id}`).join(","), out?.registered || []);
  } catch (e) {
    log?.("agent_group_register_error", String(e?.message || e).slice(0, 200));
  }
}

export function groupPromptAppendix(group) {
  if (!group) return "";
  const members = group.members || group.roles || [];
  if (!members.length) return "";
  const lines = members.map((m) => {
    const name = m.display_name || m.model_id;
    const def = String(m.definition || "").trim().split(/\n/)[0] || "";
    return def
      ? `- ${m.role}: ${name} (${m.provider}/${m.model_id}) — ${def}`
      : `- ${m.role}: ${name} (${m.provider}/${m.model_id})`;
  });
  return (
    `\n\nAGENT GROUP: ${group.name}` +
    (group.description ? `\n${group.description}` : "") +
    `\nYou are the ORCHESTRATOR. The technician talks only to you. You have a team:\n` +
    lines.join("\n") +
    `\n\nHOW TO USE THEM (this is how we keep cost down):` +
    `\n- Call the \`delegate\` tool for recon, search, planning, review, a first-pass summary, AND for writing code.` +
    `\n- Each delegate starts with a CLEAN context. Give it everything it needs in \`task\`: exact UUIDs, paths, table and column` +
    `\n  names, the pattern that already worked, and what must not change. It has NO memory of earlier calls - when you ask it to` +
    `\n  revise its previous answer, say "revise your previous answer" and the bridge attaches that answer for it.` +
    `\n- Do NOT dump raw logs, whole files, or huge tool results into THIS conversation if a specialist can compress them first.` +
    `\n- You still run the TRMM / ticket tools yourself. Specialists think or read; they do not mutate devices.` +
    (group.kind === "it"
      ? (members.some((m) => m.role === "coder" && m.enabled !== false)
        ? `\n- A CODER is on call. Write quick commands and one-liners yourself. For a longer script (a PHP/Python/SQL transaction,` +
          `\n  a multi-step PowerShell or bash script, anything with validation + rollback), delegate role=coder with every fact it needs` +
          `\n  (UUIDs, paths, table/column names, what must not change), then review and run what it returns.`
        : "")
      : `\n- Prefer scout → planner → coder → (you apply the patch) over doing the recon or the coding yourself.` +
        `\n- CODE IS NOT YOURS TO WRITE. To change a file, just run the edit you intend with run_device_command. The bridge stops it,` +
        `\n  reads the CURRENT file from the machine, and hands both to the coder, who returns one bash block that applies the change safely.` +
        `\n  Run that block EXACTLY as written, once - it is allowed through. Do not hand-write a replacement, do not "tidy" it, do not give up.` +
        `\n  Line deletions (sed -i 'Nd') run directly. You may still delegate role=coder for a larger design, but paste the current code into the task.`) +
    (members.some((m) => m.role === "judge" && m.enabled !== false)
      ? `\n- A JUDGE reviews every action before it runs (device changes, ticket actions, emails). It sees what the technician asked and what you have done. If it refuses, do not retry the same thing: fix the approach or ask the technician. Do not try to delegate to it.` +
        `\n- When a tool says BLOCKED/REFUSED, the bridge asks the same authority (as AUTHORIZER) and appends its ruling to that result:` +
        `\n  proceed / use_access (names the stored login) / ask_tech / not_allowed. Follow it. Do not second-guess what the technician` +
        `\n  already told you to do. A stored login is used BY REFERENCE: run_device_command_with_credential (any RMM agent; the command reads` +
        `\n  $PI_USER/$PI_PASS/$PI_URL), operator_desktop_fill_secret, run_script_with_credential. You never see passwords; get a row's exact` +
        `\n  label from helpdesk_call get_partner_credentials (values are masked).`
      : "") +
    (members.some((m) => m.role === "researcher" && m.enabled !== false)
      ? `\n- WEB RESEARCH goes through the RESEARCHER. web_search is answered by it: always pass \`question\` (what you need to know, with product/version).` +
        `\n  It searches, reads the pages, and returns a short sourced answer. web_fetch returns only what \`question\` asks for; set verbatim:true only` +
        `\n  when you must follow the page's exact wording. Do not re-fetch pages the researcher already cited unless you need that exact text.`
      : "") +
    (group.workspace ? `\n- File/grep/coder subagents can also edit files directly in workspace: ${group.workspace}` : "") +
    `\n`
  );
}

/** Pull the script out of python3 -c 'exec(bytes([...]))'. The orchestrator hides
 *  both reads and writes in that wrapper. Judge the script, not the wrapper. */
function decodedBytesScript(command) {
  const m = String(command || "").match(/exec\s*\(\s*bytes\s*\(\[([0-9,\s]+)\]/);
  if (!m) return "";
  const nums = m[1].split(",").map((s) => Number(s.trim())).filter((n) => n >= 0 && n < 256);
  if (!nums.length) return "";
  return Buffer.from(nums).toString("utf8");
}

function heredocBody(command) {
  const m = String(command || "").match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
  return m ? m[2] : "";
}

/** The code being judged: decoded byte-script, else the heredoc body, else the command. */
function scriptUnderTest(command) {
  return decodedBytesScript(command) || heredocBody(command) || String(command || "");
}

function scriptWrites(script) {
  const c = String(script || "");
  if (!c.trim()) return false;
  if (/\btee\b/.test(c)) return true;
  if (/\bsed\b[^\n]*(\s-i\b|--in-place)/.test(c)) return true;
  // Redirects are judged with quoted text blanked out: SQL like `help->>'en_US' <> ''`
  // inside a psql -c "..." string is not a file write (TICKET/60086, 2026-09-26, a
  // read-only audit was sent to the coder). A quoted TARGET still counts: `> "$P/x"`.
  const bare = c.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, "Q");
  if (/\b(cat|printf)\b[^\n|]*>>?\s*\S+/.test(bare)) return true;
  if (/\b(write_text|write_bytes|file_put_contents)\b/.test(c)) return true;
  if (/open\([^\n]*['"]w/.test(c)) return true;
  if (/\bPath\([^\n]*\)\s*\.\s*write_/.test(c)) return true;
  if (/\bmkdir\b/.test(c) && /certs/.test(c)) return true;
  return false;
}

/** Deleting lines is not authoring code. `sed -i '176d'`, `sed -i '12,14d'`,
 *  `sed -i '/pattern/d'` - and nothing else in the script writes. Sending those to the
 *  coder is what broke TICKET/61817 (2026-09-26): the coder was not shown the file,
 *  invented a diff for code that does not exist, and the real one-line fix never ran.
 *  They still go through the judge like any other change. */
export function isPureDeletion(script) {
  const c = String(script || "");
  const seds = c.match(/\bsed\b[^\n;|&]*/g) || [];
  const inPlace = seds.filter((s) => /(\s-i\b|--in-place)/.test(s));
  if (!inPlace.length) return false;
  for (const s of inPlace) {
    const exprs = [...s.matchAll(/(['"])(.*?)\1/g)].map((m) => m[2]);
    if (!exprs.length) return false;
    const addr = String.raw`(?:\d+|\$|\/[^/]*\/)`;
    const del = new RegExp(`^\\s*${addr}(?:\\s*,\\s*${addr})?\\s*d\\s*$`);
    if (!exprs.every((e) => del.test(e))) return false;
  }
  return !scriptWrites(c.replace(/\bsed\b[^\n;|&]*/g, ""));
}

/** A command that authors code, as opposed to reading or diagnosing. */
export function isCodeAuthoring(command) {
  const raw = String(command || "");
  if (!raw.trim()) return false;
  const script = scriptUnderTest(raw);
  // The wrapper can be the writer too (`cat > file << EOF`), not only the script inside.
  const wrapper = script !== raw ? raw.replace(script, "") : "";
  if (isPureDeletion(script) && !scriptWrites(wrapper)) return false;
  if (script !== raw) return scriptWrites(script) || scriptWrites(wrapper);
  if (/<<-?\s*['"]?[A-Za-z_]/.test(raw) && !heredocBody(raw)) return true;
  return scriptWrites(raw);
}

function memberByRole(group, role) {
  return (group?.members || group?.roles || []).find((m) => m.role === role && m.enabled !== false) || null;
}

function coderMember(group) {
  return memberByRole(group, "coder");
}

function resultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  const parts = Array.isArray(result.content) ? result.content : [];
  return parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n");
}

/** Which cheap role should compress a read. Planner and reviewer are judgment, not a dump. */
function readerFor(command, group) {
  const c = String(command || "");
  if (/\b(grep|rg|find|ag)\b/.test(c)) return memberByRole(group, "grep") || memberByRole(group, "scout");
  if (/\b(cat|head|tail|ls|less|wc)\b/.test(c) || /\bsed\b/.test(c)) {
    return memberByRole(group, "files") || memberByRole(group, "scout");
  }
  return memberByRole(group, "scout") || memberByRole(group, "summarizer");
}

const COMPRESS_ABOVE = 1800;

/** A bounded read of one file. The coder needs those lines verbatim.
 *  Summarizing them is what made the files role look broken. */
function isVerbatimRead(command) {
  const raw = String(command || "");
  const c = scriptUnderTest(raw);
  if (/\bgrep\b/.test(c) && /-[rR]/.test(c)) return false;
  if (/\bfind\b/.test(c) && !/-name/.test(c)) return false;
  if (/\b(read_text|read_bytes)\b/.test(c) && !scriptWrites(c)) return true;
  return /\b(sed\s+-n|head\b|tail\b|nl\b|cat\b|od\b|hexdump\b)\b/.test(c);
}

/** The coder was inventing a new file because it never saw the current one. */
function coderOutputUnsafe(text) {
  const t = String(text || "");
  if (/\/var\/www\/[^\s'"]+\.key\b/.test(t)) return "private key under the web root";
  if (/ms_teams_integration\/certs/.test(t) && /\.key\b/.test(t)) return "private key under the app directory";
  if (/new file mode/.test(t) || /--- \/dev\/null/.test(t)) return "replaces an existing file instead of editing it";
  return "";
}

/** Files a command is about to change, so the coder can be SHOWN them. Resolves simple
 *  `VAR=/path` assignments first (the orchestrator writes `ERP=/docker/...; sed -i ... $ERP`). */
export function targetFiles(command) {
  let c = String(command || "");
  const script = scriptUnderTest(c);
  if (script !== c) c = c + "\n" + script;
  const vars = {};
  for (const m of c.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(["']?)((?:\/|[A-Za-z]:\\)[^\s"';]+)\2\s*$/gm)) vars[m[1]] = m[3];
  c = c.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (all, v) => (vars[v] !== undefined ? vars[v] : all));
  const found = [];
  const add = (f) => {
    f = f.replace(/[)"',;]+$/, "");
    if (/\.(bak|orig|tmp)(-[\w.-]*)?$|\.bak-/.test(f) || /^\/(dev|proc)\//.test(f)) return;
    if (!found.includes(f)) found.push(f);
  };
  for (const m of c.matchAll(/(?:^|[\s'"=(<>])(\/(?:[\w.@+-]+\/)*[\w.@+-]+\.[A-Za-z0-9]{1,10})(?=$|[\s'";)|&])/gm)) add(m[1]);
  for (const m of c.matchAll(/([A-Za-z]:\\(?:[^\\\s'"]+\\)*[^\\\s'"]+\.[A-Za-z0-9]{1,10})/g)) add(m[1]);
  return found.slice(0, 3);
}

function readFilesCommand(files, shell) {
  const q = (f) => "'" + String(f).replace(/'/g, "'\\''") + "'";
  if (String(shell || "").toLowerCase() === "bash" || files.every((f) => f.startsWith("/"))) {
    return files.map((f) =>
      `f=${q(f)}; if [ -f "$f" ]; then echo "=== $f ($(wc -l < "$f") lines)"; nl -ba "$f" | head -n 1500; ` +
      `else echo "=== $f does not exist yet"; fi`).join("\n");
  }
  return files.map((f) =>
    `$f='${f.replace(/'/g, "''")}'; if (Test-Path -LiteralPath $f) { "=== $f"; $i=0; ` +
    `Get-Content -LiteralPath $f | Select-Object -First 1500 | ForEach-Object { $i++; '{0,6}  {1}' -f $i,$_ } } ` +
    `else { "=== $f does not exist yet" }`).join("\n");
}

function coderTask(command, current = "") {
  const script = scriptUnderTest(command);
  if (current) {
    return (
      "You are the coder. Edit. Do not replace.\n" +
      "The CURRENT content of the file(s) is below, read from the machine just now. Line numbers " +
      "are added for reference only; they are NOT part of the file.\n" +
      "Return exactly ONE ```bash code block that applies the change and nothing else runs:\n" +
      "- copy the file to <file>.bak-$(date +%s) first;\n" +
      "- use python3 to read the file, and for each change replace one EXACT old string (copied from the " +
      "file below, without the line numbers) with the new string; assert each old string occurs exactly once " +
      "and exit 1 without writing if not;\n" +
      "- write the file back, then print the changed region with line numbers;\n" +
      "- for a .js/.mjs file, run `node --check` on a copy if node exists; for .py, `python3 -m py_compile`.\n" +
      "Change only what the task needs. Never store a private key under /var/www or the app directory. " +
      "After the block, one short line saying what it changes. Do not claim you ran anything.\n\n" +
      "WHAT THE ORCHESTRATOR WAS TRYING TO DO (its command; the intent, not necessarily correct):\n" +
      String(script).slice(0, 8000) +
      "\n\nCURRENT FILE CONTENT:\n" + String(current).slice(0, 60000)
    );
  }
  return (
    "You are the coder. Edit. Do not replace.\n" +
    "Rules:\n" +
    "- You were not given the full current file. Do not emit a new-file diff. Do not start from /dev/null.\n" +
    "- Return only the added or changed function, as a unified diff against the snippet below, or as an append.\n" +
    "- Do not delete a function you were not shown.\n" +
    "- Never store a private key under /var/www or under the app directory. Certificate keys belong in /var/lib, mode 0600.\n" +
    "- Do not claim you ran anything.\n" +
    "- If the script below does not show you the code you must change, reply with exactly one line: " +
    "NEED_FILE: <path> <line range> - and nothing else. Never invent code you were not shown.\n\n" +
    "SCRIPT THE ORCHESTRATOR TRIED TO RUN:\n" + String(script).slice(0, 12000)
  );
}

async function compressRead({ group, member, command, output, signal, groupState }) {
  const model = `${member.provider}/${member.model_id}`;
  const briefing = await runSpecialist({
    group,
    member,
    task:
      `You are the ${member.role}. Compress this device output for the orchestrator.\n` +
      `Keep paths, line numbers, ids, error strings, and the few lines that answer the command. ` +
      `Drop repetition and banners. Do not invent. Do not suggest a fix unless the output already states one.\n\n` +
      `COMMAND:\n${String(command).slice(0, 2000)}\n\nOUTPUT:\n${String(output).slice(0, 40000)}`,
    signal,
    rt: groupState.rt,
    spend: groupState.spend,
  });
  return { model, briefing: briefing || "(no briefing)" };
}

/**
 * The model will not volunteer to use the coder. So when this group has one, a device
 * command that authors code is not run. It is handed to the coder, and the patch comes
 * back for the orchestrator to apply. Reads and diagnostics are untouched.
 */
export function routeCodeToCoder(tools, groupState) {
  if (!Array.isArray(tools) || !groupState) return;
  for (const tool of tools) {
    if (tool?.name !== "run_device_command" && tool?.name !== "run_command_on_device") continue;
    if (typeof tool.execute !== "function" || tool.execute.__coderRouted) continue;
    const original = tool.execute.bind(tool);
    const wrapped = async (id, params, signal) => {
      const command = String(params?.command || "");
      const group = groupState.current;
      // IT groups have an ON-CALL coder (owner, 2026-09-26): the orchestrator delegates the
      // bigger scripts, but device commands are NOT forced through it - forcing every edit
      // through Opus 5.5 is what made TICKET/61820 crawl. Only coding/custom groups route.
      const coder = group?.kind === "it" ? null : coderMember(group);
      if (coder && isCodeAuthoring(command) && groupState.allowNextApply) {
        groupState.allowNextApply = false;
        return original(id, params, signal);
      }
      if (!(coder && isCodeAuthoring(command))) {
        const ran = await original(id, params, signal);
        const output = resultText(ran);
        const reader = readerFor(command, group);
        if (!reader || isVerbatimRead(command) || output.length < COMPRESS_ABOVE || output.startsWith("NOT EXECUTED")) return ran;
        try {
          const { model, briefing } = await compressRead({
            group, member: reader, command, output, signal, groupState,
          });
          return {
            content: [{
              type: "text",
              text:
                `Read by ${reader.role} (${model}). ${output.length} characters were not put in your context.\n\n` +
                briefing,
            }],
            details: { ...(ran.details || {}), routed_to: reader.role, model },
          };
        } catch {
          return ran;
        }
      }
      const model = `${coder.provider}/${coder.model_id}`;

      // SHOW THE CODER THE FILE. Asking a cheap orchestrator to "read it and pass it on"
      // failed (TICKET/61817, 2026-09-26): it gave up after NEED_FILE instead. The bridge
      // reads the target file itself, on the same machine, with a plain read (no approval).
      let current = "";
      const files = targetFiles(command);
      if (files.length) {
        try {
          const readRes = await original(id, {
            ...params,
            command: readFilesCommand(files, params?.shell),
            timeout: 30,
          }, signal);
          current = resultText(readRes);
          if (/NOT EXECUTED|REFUSED|BLOCKED/.test(current.slice(0, 200))) current = "";
        } catch { current = ""; }
      }

      try {
        const written = await runSpecialist({
          group,
          member: coder,
          task: coderTask(command, current),
          signal,
          rt: groupState.rt,
          spend: groupState.spend,
        });
        if (/^\s*NEED_FILE:/m.test(String(written || "")) && String(written || "").trim().length < 400) {
          groupState.allowNextApply = false;
          return {
            content: [{
              type: "text",
              text:
                `NOT EXECUTED. The coder (${model}) was not shown the code it would change: ${String(written).trim()}. ` +
                `Read those exact lines with line numbers (sed -n 'A,Bp' or grep -n -A), then call delegate with ` +
                `role=coder and paste them together with the change you want. Apply the patch it returns once.`,
            }],
            details: { routed_to: "coder", model, need_file: true },
          };
        }
        const unsafe = coderOutputUnsafe(written);
        if (unsafe) {
          groupState.allowNextApply = false;
          return {
            content: [{
              type: "text",
              text:
                `NOT EXECUTED. The coder (${model}) was refused: ${unsafe}. ` +
                `Do not apply it. Read the current file, then call delegate with role=coder and paste the current file plus the exact change. ` +
                `Do not store a private key under /var/www.\n\n` +
                (written || ""),
            }],
            details: { routed_to: "coder", model, refused: unsafe },
          };
        }
        groupState.allowNextApply = true;
        return {
          content: [{
            type: "text",
            text:
              (current
                ? `NOT EXECUTED. The coder (${model}) was shown the current file and wrote the script below to apply the change. ` +
                  `Run that bash block EXACTLY as written, once, with run_device_command on the same machine - it will be allowed. ` +
                  `Do not rewrite or "clean it up". Then check its output.\n\n`
                : `NOT EXECUTED. The coder (${model}) wrote this edit. Your NEXT file-write of this patch will be run. ` +
                  `Do not rewrite it. Apply it once, then verify.\n\n`) +
              (written || "(coder returned nothing)"),
          }],
          details: { routed_to: "coder", model },
        };
      } catch (e) {
        return {
          content: [{
            type: "text",
            text: `Coder (${model}) failed: ${String(e?.message || e).slice(0, 400)}. Do not write the code yourself. Call delegate with role=coder.`,
          }],
          details: { error: true },
        };
      }
    };
    wrapped.__coderRouted = true;
    tool.execute = wrapped;
  }
}


// ---------------------------------------------------------------------------------------
// RESEARCHER (2026-09-26). Web pages were pasted straight into the orchestrator: 463 results
// / ~366k tokens in 14 days, each re-read on every later turn (18.3M tokens re-read). The
// researcher reads them in ITS OWN throwaway context (cheap model) and hands back a short
// sourced answer. The orchestrator keeps web_fetch verbatim:true for a page it must follow.
const RESEARCH_SEARCHES = 5;
const RESEARCH_FETCHES = 6;
const RESEARCH_PAGE_CHARS = 40000;
const RESEARCH_PASS_THROUGH = 2500; // a fetched page this short is returned as-is

function researcherWebTools() {
  let searches = 0, fetches = 0;
  const t = (s) => ({ content: [{ type: "text", text: s }], details: {} });
  return [
    {
      name: "web_search", label: "Web search",
      description: "Search the web. Returns titles, URLs and snippets.",
      parameters: Type.Object({ query: Type.String() }),
      execute: async (_id, p) => {
        if (++searches > RESEARCH_SEARCHES) return t("Search budget used up. Answer now from what you have.");
        try {
          const r = await webSearchRaw(p.query);
          return t(r.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join("\n\n") || "(no results)");
        } catch (e) { return t("web_search failed: " + (e?.message || e)); }
      },
    },
    {
      name: "web_fetch", label: "Fetch web page",
      description: "Fetch a URL and return its readable text.",
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_id, p) => {
        if (++fetches > RESEARCH_FETCHES) return t("Fetch budget used up. Answer now from what you have.");
        try { return t(await webFetchRaw(p.url, RESEARCH_PAGE_CHARS)); }
        catch (e) { return t("web_fetch failed: " + (e?.message || e)); }
      },
    },
  ];
}

const RESEARCH_RULES =
  "RULES: Prefer the vendor's official documentation, then vendor forums, then reputable blogs. " +
  "Read the page before relying on it - a snippet is not a source. Keep product names, versions, menu paths, " +
  "commands, API endpoints, field names and error text EXACTLY as the source writes them; quote steps, do not paraphrase them. " +
  "Say which version the steps apply to and flag conflicts between sources. Never invent a step, flag or endpoint. " +
  "If you could not find a solid answer, reply 'NOT FOUND:' and what you tried.\n" +
  "ANSWER FORMAT (under ~1500 characters): the answer / exact steps, then 'Sources:' with the URL(s) you actually read.";

function researchHeader(model, note) {
  return `Researched by researcher (${model})${note ? ` - ${note}` : ""}. Use web_fetch verbatim:true on a cited URL only if you need its exact text.\n\n`;
}

/** Hand web_search / web_fetch to the group's researcher when it has one. Falls back to the
 *  plain tool on any failure, and when the group changes to one without a researcher. */
export function routeWebToResearcher(tools, groupState) {
  if (!Array.isArray(tools) || !groupState) return;
  for (const tool of tools) {
    if (!["web_search", "web_fetch"].includes(tool?.name)) continue;
    if (typeof tool.execute !== "function" || tool.execute.__researchRouted) continue;
    const original = tool.execute.bind(tool);
    const wrapped = async (id, params, signal, ...rest) => {
      const group = groupState.current;
      const member = memberByRole(group, "researcher");
      if (!member || !groupState.rt) return original(id, params, signal, ...rest);
      const model = `${member.provider}/${member.model_id}`;
      const question = String(params?.question || "").trim();
      try {
        if (tool.name === "web_search") {
          const q = String(params?.query || "").trim();
          const answer = await runSpecialist({
            group, member, signal, rt: groupState.rt, spend: groupState.spend,
            task:
              `Research this for an IT technician's AI assistant.\nQUESTION: ${question || q}\n` +
              (question && q ? `SUGGESTED FIRST SEARCH: ${q}\n` : "") +
              `Use web_search and web_fetch (at most ${RESEARCH_SEARCHES} searches, ${RESEARCH_FETCHES} page reads).\n` + RESEARCH_RULES,
          });
          if (!answer) return original(id, params, signal, ...rest);
          return { content: [{ type: "text", text: researchHeader(model) + answer }], details: { role: "researcher", model } };
        }
        // web_fetch
        if (params?.verbatim === true) return original(id, params, signal, ...rest);
        const page = await webFetchRaw(String(params?.url || ""), RESEARCH_PAGE_CHARS);
        if (page.length <= RESEARCH_PASS_THROUGH) return { content: [{ type: "text", text: page }], details: {} };
        const answer = await runSpecialist({
          group, member, signal, rt: groupState.rt, spend: groupState.spend, webAccess: false,
          task:
            `Extract what an IT technician's AI assistant needs from this web page.\n` +
            `NEED: ${question || "the steps, commands, settings, versions and caveats this page gives for the task it describes"}\n` +
            `URL: ${params?.url}\n` + RESEARCH_RULES.replace("Read the page before relying on it - a snippet is not a source. ", "") +
            `\n\nPAGE TEXT:\n${page}`,
        });
        if (!answer) return original(id, params, signal, ...rest);
        return {
          content: [{ type: "text", text: researchHeader(model, `${page.length} characters of ${params?.url} were not put in your context`) + answer }],
          details: { role: "researcher", model },
        };
      } catch (e) {
        if (signal?.aborted) throw e;
        return original(id, params, signal, ...rest);
      }
    };
    wrapped.__researchRouted = true;
    tool.execute = wrapped;
  }
}

export function attachGroupToLoader(loaderOpts, groupState) {
  const baseOverride = loaderOpts.systemPromptOverride;
  return {
    ...loaderOpts,
    extensionFactories: [
      ...(loaderOpts.extensionFactories || []),
      (pi) => registerDelegateTool(pi, groupState),
    ],
    systemPromptOverride: () => {
      const base = typeof baseOverride === "function" ? baseOverride() : (baseOverride || "");
      return String(base || "") + groupPromptAppendix(groupState.current);
    },
  };
}

function registerDelegateTool(pi, groupState) {
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Hand a narrow job to a specialist in this agent group. The specialist has a " +
      "fresh context window (it does NOT see this conversation). Use scout/grep/files " +
      "for recon, planner for a plan, reviewer for a review, summarizer to compress a " +
      "blob of text, coder to write every patch or script (it returns the patch; you apply it), " +
      "operator to draft a device fix. You keep the TRMM tools. A missing workspace is not a reason to skip the coder.",
    parameters: Type.Object({
      role: Type.String({
        description: "Specialist role: scout, files, grep, planner, coder, operator, reviewer, summarizer, researcher (web research with sources)",
      }),
      task: Type.String({
        description: "Self-contained instructions. The specialist cannot see this chat.",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const group = groupState.current;
      if (!group) {
        return {
          content: [{ type: "text", text: "No agent group is active. Work the task yourself." }],
          details: {},
        };
      }
      const role = String(params.role || "").trim().toLowerCase();
      let task = String(params.task || "").trim();
      // SPECIALISTS HAVE NO MEMORY (TICKET/61820, 2026-09-26): the orchestrator kept sending
      // "Revise your prior script..." to a coder that starts from a blank context every call,
      // so it rebuilt from scratch and invented UUIDs, paths and table usage. When a task asks
      // to revise/fix the previous answer, the bridge attaches that answer and its task.
      const prev = groupState.lastDelegate?.[role];
      if (prev && /\b(your|the|that|this)\s+(prior|previous|last|earlier|above|current)\b|\brevis(e|ion)\b|\bfix (it|this|that|your)\b|\bcorrect (it|this|that|your)\b|\bunusable\b|\bstill (wrong|broken)\b/i.test(task)) {
        task =
          `YOUR PREVIOUS ANSWER (you have no memory of it; this is it, verbatim - revise IT, do not start over):\n` +
          `${String(prev.answer).slice(0, 24000)}\n\n` +
          `THE TASK THAT PRODUCED IT:\n${String(prev.task).slice(0, 6000)}\n\n` +
          `NOW DO THIS:\n${task}`;
      }
      if (!task) {
        return { content: [{ type: "text", text: "delegate requires a task." }], details: {} };
      }
      if (role === "judge") {
        return {
          content: [{ type: "text", text: "The judge is not delegated to. It reviews every action automatically before it runs. If it refuses one, change the approach or ask the technician." }],
          details: {},
        };
      }
      if (role === "orchestrator") {
        return {
          content: [{ type: "text", text: "You ARE the orchestrator. Do not delegate to yourself." }],
          details: {},
        };
      }
      const member = (group.members || group.roles || []).find((m) => m.role === role && m.enabled !== false);
      if (!member) {
        const have = (group.members || group.roles || []).map((m) => m.role).join(", ");
        return {
          content: [{ type: "text", text: `No '${role}' specialist in group ${group.name}. Available: ${have}` }],
          details: {},
        };
      }
      // TIME LIMIT (2026-09-26, TICKET/61820): a coder delegate sat 9+ minutes with no answer
      // and no limit, holding the technician's window "working" and blocking a deferred
      // restart. Stop still cancels it at once (the parent signal); this ends a hung one.
      const limitMs = (role === "coder" ? 10 : 5) * 60 * 1000;
      const ac = new AbortController();
      const onParentAbort = () => ac.abort();
      signal?.addEventListener?.("abort", onParentAbort, { once: true });
      const timer = setTimeout(() => ac.abort(), limitMs);
      try {
        const text = await runSpecialist({
          group, member, task, signal: ac.signal, rt: groupState.rt, spend: groupState.spend,
        })
          // A provider failure now throws (see runSpecialist); for a delegated specialist it
          // is handled exactly like an empty answer - one retry on another model, below.
          .catch((e) => { if (e?.providerFailure) return ""; throw e; })
          .finally(() => { clearTimeout(timer); signal?.removeEventListener?.("abort", onParentAbort); });
        // An aborted specialist session usually RESOLVES (with little or no text) rather than throws.
        if (ac.signal.aborted && !signal?.aborted) {
          return {
            content: [{ type: "text", text: `Specialist ${role} did not answer within ${limitMs / 60000} minutes and was stopped. Do the step yourself in smaller pieces, or tell the technician.` }],
            details: { role, error: true, timeout: true },
          };
        }
        // EMPTY ANSWER -> ONE RETRY ON ANOTHER MODEL (2026-09-26, TICKET/61820). Claude Opus 5.5
        // as coder twice spent its whole budget thinking and returned no text on a FusionPBX
        // config change - the same "declines admin work" behaviour that made it unfit as judge.
        // The orchestrator then burned minutes re-asking. Retry once on the group's reviewer
        // (or planner) model with the SAME role and task, and say which model answered.
        if (!String(text || "").trim() && !signal?.aborted) {
          const alt = ["reviewer", "planner", "operator"].map((r) => memberByRole(group, r))
            .find((m) => m && `${m.provider}/${m.model_id}` !== `${member.provider}/${member.model_id}`);
          if (alt) {
            const stand = { ...member, provider: alt.provider, model_id: alt.model_id,
              display_name: alt.display_name, thinking_level: alt.thinking_level || "medium" };
            const retry = await runSpecialist({ group, member: stand, task, signal, rt: groupState.rt, spend: groupState.spend, roleLabel: `${role} (fallback)` })
              .catch(() => "");
            if (String(retry || "").trim()) {
              if (role === "coder" && !coderOutputUnsafe(retry) && !/^\s*NEED_FILE:/m.test(retry)) groupState.allowNextApply = true;
              return {
                content: [{ type: "text", text: `[${member.display_name || member.model_id} returned nothing; answered by ${alt.display_name || alt.model_id} in the ${role} role]\n\n${retry}` }],
                details: { role, model: `${alt.provider}/${alt.model_id}`, fallback: true },
              };
            }
          }
        }
        if (String(text || "").trim()) {
          groupState.lastDelegate = { ...(groupState.lastDelegate || {}), [role]: { task: String(params.task || ""), answer: String(text) } };
        }
        // A patch the orchestrator asked the coder for may be applied once without being
        // routed back to the coder for a second, redundant rewrite.
        if (role === "coder" && text && !coderOutputUnsafe(text) && !/^\s*NEED_FILE:/m.test(text)) {
          groupState.allowNextApply = true;
        }
        return {
          content: [{ type: "text", text: text || "(specialist returned nothing)" }],
          details: { role, model: `${member.provider}/${member.model_id}` },
        };
      } catch (e) {
        const timedOut = ac.signal.aborted && !signal?.aborted;
        return {
          content: [{ type: "text", text: timedOut
            ? `Specialist ${role} did not answer within ${limitMs / 60000} minutes and was stopped. Do the step yourself in smaller pieces, or tell the technician.`
            : `Specialist ${role} failed: ${String(e?.message || e).slice(0, 400)}` }],
          details: { role, error: true },
        };
      }
    },
  });
}

// Unique per delegate call. A plain counter is not enough: a bridge restart would reset
// it, and a RESUMED chat would then re-issue `<parent>-g001` whose turn 1 already exists -
// idempotency would read the new charge as a retry and drop it. The clock component makes
// that impossible without needing any persisted state.
let _delegateSeq = 0;
const delegateSeq = () => `${(++_delegateSeq).toString(36)}${Date.now().toString(36).slice(-5)}`;

export async function runSpecialist({ group, member, task, signal, rt, spend = null, webAccess = null, customTools = null, roleLabel = "" }) {
  if (!rt) throw new Error("agent-group runtime is not ready");
  let model = rt.findModel(member.provider, member.model_id);
  if (!model) {
    await registerModels(
      [{ name: member.provider, api_key: "" }],
      rt,
      [{ provider: member.provider, model_id: member.model_id, display_name: member.display_name || member.model_id }],
    );
    model = rt.findModel(member.provider, member.model_id);
  }
  if (!model) {
    throw new Error(`model ${member.provider}/${member.model_id} is not available to the runtime`);
  }

  const workspace = String(group.workspace || "").trim();
  const wantTools = ROLE_TOOLS[member.role];
  const useFiles = !!(workspace && wantTools && fs.existsSync(workspace));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pi-group-${member.role}-`));
  const cwd = useFiles ? workspace : tmp;
  const system = specialistPrompt(member, group, useFiles);

  const loader = new DefaultResourceLoader({
    agentDir: tmp,
    cwd,
    noExtensions: true,
    systemPromptOverride: () => system,
  });
  await loader.reload();
  const sessionManager = SessionManager.create(tmp);
  const opts = {
    model,
    thinkingLevel: member.thinking_level || "medium",
    ...rt.sessionOpts,
    resourceLoader: loader,
    sessionManager,
    agentDir: tmp,
    cwd,
  };
  const withWeb = webAccess ?? member.role === "researcher";
  if (Array.isArray(customTools) && customTools.length) {
    opts.customTools = customTools;
    opts.tools = customTools.map((t) => t.name);
  } else if (withWeb) {
    opts.customTools = researcherWebTools();
    opts.tools = ["web_search", "web_fetch"];
  } else if (useFiles) opts.tools = wantTools;
  else opts.noTools = "all";

  const { session } = await createAgentSession(opts);
  // Bill the specialist to the conversation that delegated to it. Same session_id as the
  // parent chat, so "what did this chat cost" stays the true total; `surface: "group"`
  // and the role in the log line say where inside it the money went.
  if (spend) {
    // A DERIVED session id, not the parent's own: ledger rows are idempotent on
    // (session_id, turn_index), and a specialist counts its turns from 1 - which would
    // collide with the parent chat's first turns and silently drop the charge (the
    // duplicate is read as a retry). `<parent>-g<n>` keeps the money attributable to the
    // conversation (everything asking "what did this chat cost" matches on the prefix)
    // without ever colliding with it.
    attachSpendLedger(session, {
      ...spend,
      sessionId: `${spend.sessionId || "nosid"}-g${delegateSeq()}`,
      surface: "group",
      // The role this turn was bought FOR (authorizer runs on the judge's member, a fallback
      // answers in the coder's role on another model) - see cost-meter.js byRole.
      role: roleLabel || member.role,
      key: `${spend.key || ""}${spend.key ? " " : ""}delegate:${roleLabel || member.role}`,
    });
  }
  if (signal?.aborted) throw new Error("aborted");
  const abort = () => { try { session.abort?.(); } catch { /* noop */ } };
  signal?.addEventListener?.("abort", abort, { once: true });
  try {
    await session.prompt(task);
  } finally {
    signal?.removeEventListener?.("abort", abort);
    try { session.dispose?.(); } catch { /* noop */ }
  }
  const text = lastAssistantText(session);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  // A PROVIDER FAILURE IS NOT AN EMPTY ANSWER (2026-09-30). prompt() does not throw when the
  // provider refuses - it leaves an assistant message with stopReason "error" and no text,
  // so this returned "" and the judge told the technician its model "may have declined to
  // review this". TICKET/62044 10:48: 0 tokens, $0.00 - Grok was at capacity and never saw
  // the command. Say what actually happened, so callers can report it or fall back.
  if (!text) {
    const last = [...(session?.messages || [])].reverse().find((m) => m?.role === "assistant");
    if (last && (last.stopReason === "error" || last.stopReason === "aborted")) {
      const e = new Error(`${member.display_name || member.model_id} failed: ${String(last.errorMessage || last.stopReason).slice(0, 240)}`);
      e.providerFailure = true;
      throw e;
    }
  }
  return text;
}

function lastAssistantText(session) {
  const msgs = session?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== "assistant") continue;
    const parts = Array.isArray(m.content) ? m.content : [];
    const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("");
    if (text) return text;
  }
  return "";
}

function specialistPrompt(member, group, useFiles) {
  const role = member.role;
  const common =
    `You are the ${role} specialist in the "${group.name}" agent group.\n` +
    `You do not talk to the technician. Return a compact, useful result to the orchestrator.\n` +
    `Do not greet. Do not offer next steps unless asked. No fluff.\n`;
  const written = String(member.definition || "").trim();
  if (written) {
    return common + written + (useFiles ? "\nA workspace is configured; you may read and (if this role writes) edit files there." : "");
  }
  return common + "Do the assigned task and return the result.";
}

export function findGroupInBlob(blob, groupId) {
  if (groupId == null || groupId === "" || groupId === 0) return null;
  const id = Number(groupId);
  return (blob.agent_groups || []).find((g) => Number(g.id) === id) || null;
}

/**
 * THE BACKUP MODEL FOR A ROLE (owner, 2026-09-27).
 *
 * A provider refusing outright - quota, billing, auth, model retired - is not something the
 * model can work around, and retrying the same provider is pure cost. xAI did exactly that for
 * two days ("used all available credits or reached its monthly spending limit"), and every turn
 * on grok died mid-flight with nothing else to fall back to. A role may therefore name a backup:
 * the bridge switches to it, says so in the window, and carries on with the same conversation.
 *
 * Returns { provider, model_id, thinking_level } or null. Never returns the model the role is
 * already using, so a misconfiguration cannot make it "fall back" to itself.
 */
export function fallbackMember(group, role, current = {}) {
  const member = (group?.members || group?.roles || [])
    .find((m) => m.role === role && m.enabled !== false);
  const provider = String(member?.fallback_provider || "").trim();
  const modelId = String(member?.fallback_model_id || "").trim();
  if (!provider || !modelId) return null;
  if (provider === current.provider && modelId === current.model_id) return null;
  return {
    provider,
    model_id: modelId,
    thinking_level: String(member?.fallback_thinking_level || "").trim() || member?.thinking_level || "",
  };
}

export function summarizerMember(group) {
  if (!group) return null;
  return (group.members || group.roles || []).find((m) => m.role === "summarizer" && m.enabled !== false) || null;
}

export function publicReady(group) {
  if (!group) return null;
  return {
    id: group.id,
    name: group.name,
    slug: group.slug,
    kind: group.kind,
    is_default: !!group.is_default,
  };
}

// silence unused in case a role catalog is referenced later
void THINK_ROLES;
