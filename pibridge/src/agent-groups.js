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
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerModels } from "./models-catalog.js";

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
  return { current: blob?.agent_group || null, rt: null };
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
    `\n- Call the \`delegate\` tool for recon, search, planning, review, or a first-pass summary.` +
    `\n- Each delegate starts with a CLEAN context. Give it everything it needs in \`task\`.` +
    `\n- Do NOT dump raw logs, whole files, or huge tool results into THIS conversation if a specialist can compress them first.` +
    `\n- You still run the TRMM / ticket tools yourself. Specialists think or read; they do not mutate devices.` +
    `\n- Prefer scout → planner → (you apply the plan) over doing the recon yourself.` +
    (group.workspace ? `\n- File/grep/coder subagents run in workspace: ${group.workspace}` : "") +
    `\n`
  );
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
      "blob of text, coder to write code (only when a workspace is configured), " +
      "operator to draft a device fix. You keep the TRMM tools.",
    parameters: Type.Object({
      role: Type.String({
        description: "Specialist role: scout, files, grep, planner, coder, operator, reviewer, summarizer",
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
      const task = String(params.task || "").trim();
      if (!task) {
        return { content: [{ type: "text", text: "delegate requires a task." }], details: {} };
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
      try {
        const text = await runSpecialist({ group, member, task, signal, rt: groupState.rt });
        return {
          content: [{ type: "text", text: text || "(specialist returned nothing)" }],
          details: { role, model: `${member.provider}/${member.model_id}` },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Specialist ${role} failed: ${String(e?.message || e).slice(0, 400)}` }],
          details: { role, error: true },
        };
      }
    },
  });
}

async function runSpecialist({ group, member, task, signal, rt }) {
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
  if (useFiles) opts.tools = wantTools;
  else opts.noTools = "all";

  const { session } = await createAgentSession(opts);
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
