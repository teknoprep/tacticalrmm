// Simple per-agent chat history index so the "AI History" device tab can list
// and resume prior conversations. Each agent gets sessions/<agentId>/index.json
// mapping session_id -> { file, name, started, last_activity, model, user }.
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";

function agentDir(agentId) {
  const d = path.join(CONFIG.sessionsRoot, agentId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function indexPath(agentId) {
  return path.join(agentDir(agentId), "index.json");
}

export function readIndex(agentId) {
  try {
    return JSON.parse(fs.readFileSync(indexPath(agentId), "utf8"));
  } catch {
    return {};
  }
}

function writeIndex(agentId, idx) {
  fs.writeFileSync(indexPath(agentId), JSON.stringify(idx, null, 2));
}

export function recordSession(agentId, sessionId, info) {
  const idx = readIndex(agentId);
  idx[sessionId] = { ...(idx[sessionId] || {}), ...info };
  writeIndex(agentId, idx);
}

export function touchSession(agentId, sessionId, lastMessage) {
  const idx = readIndex(agentId);
  if (idx[sessionId]) {
    idx[sessionId].last_activity = new Date().toISOString();
    if (lastMessage) idx[sessionId].last_message = lastMessage.slice(0, 200);
    writeIndex(agentId, idx);
  }
}

export function listSessions(agentId) {
  const idx = readIndex(agentId);
  return Object.entries(idx)
    .map(([session_id, v]) => ({ session_id, ...v }))
    .sort((a, b) => (b.last_activity || "").localeCompare(a.last_activity || ""));
}

/**
 * The most recent session for this conversation key that may be reopened WITHOUT anyone
 * naming it - i.e. what a browser refresh, a dropped socket or a model switch should land
 * back in, instead of a blank conversation.
 *
 * Deliberately narrow, because guessing wrong here means showing one technician another's
 * work, or dragging a forgotten conversation into a new job:
 *   - the transcript file must still exist (a deleted session is not resumable),
 *   - the window shape must match (a multi-machine chat is not a single-machine chat),
 *   - it must belong to the person opening it - sessions recorded before `user` existed
 *     are allowed through, since there is nothing to contradict,
 *   - and it must be recent, so "chat about this server" on Friday does not silently
 *     continue Tuesday's conversation. 0 disables the age check.
 *
 * @returns {{session_id:string}&Record<string,any>|null}
 */
export function latestResumable(agentId, { username = "", multi = false, maxAgeMs = 0 } = {}) {
  const now = Date.now();
  for (const s of listSessions(agentId)) {   // already newest-first
    if (!s.file) continue;
    try {
      if (!fs.existsSync(s.file)) continue;
    } catch {
      continue;
    }
    if (!!s.multi !== !!multi) continue;
    if (s.user && username && s.user !== username) continue;
    const stamp = Date.parse(s.last_activity || s.started || "");
    if (!Number.isFinite(stamp)) continue;
    if (maxAgeMs > 0 && now - stamp > maxAgeMs) continue;
    return s;
  }
  return null;
}

export function deleteSession(agentId, sessionId) {
  const idx = readIndex(agentId);
  const info = idx[sessionId];
  if (info?.file) {
    try {
      fs.unlinkSync(info.file);
    } catch {}
  }
  delete idx[sessionId];
  writeIndex(agentId, idx);
  // The conversation's prompt queue (queue.js) goes with it.
  try { fs.unlinkSync(path.join(agentDir(agentId), "queue", `${sessionId}.json`)); } catch {}
}
