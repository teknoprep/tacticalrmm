// KB WRITE GUARD - the pure part (owner, 2026-11-12). Spec: docs/KB-WRITE-GUARD.md.
//
// WHY THIS EXISTS: TICKET/63975 wrote five KB blocks in thirteen minutes - restating,
// reversing, a false claim plus its own correction, one client's guess promoted to a
// "STANDING RULE FOR ALL CLIENTS", all dated by the MODEL ([2026-11-16] on a 2026-11-12
// host) - and automatic recall then injected the session's own wrong block back at it.
// The article is shared by every client, so one bad rule is not contained by one project.
//
// This file holds the decisions and nothing else: no network, no file I/O, no clock of its
// own (a Date is always passed in). kb-guard.js owns the I/O and calls these in order.
//
// STORAGE: append-only, in the existing article. upsert_ai_kb_article stamps `[server-date]`
// in front of whatever it is given and escapes HTML, so our metadata is plain bracketed text
// after that stamp:
//   [2026-11-12] [verified][ref 7f3a1c02][topic teams-acd][ticket TICKET/63975][amend ref A] body
// The date is therefore the SERVER's, never the model's. Nothing here edits an earlier block:
// a change of mind is a new block that points at the old one by ref (amend / retract /
// correction), so the wrong claim stays in history (spec C, H) and recall resolves it.
import crypto from "node:crypto";

export const VERIFIED_KINDS = new Set(["readback", "result_json", "log", "cdr"]);
// Things that are intentions or beliefs, not observations - never proof (spec A).
export const UNPROVEN_KINDS = new Set(["plan", "hypothesis", "instruction", "should_work"]);
export const MIN_QUOTE = 20;
export const WINDOW_MS = 24 * 3600 * 1000;
export const HOUR_MS = 3600 * 1000;
export const PER_TURN = 1;
export const PER_HOUR = 3;
export const UNVERIFIED_PREFIX = "(UNVERIFIED \u2014 hypothesis, do not treat as fact)";
export const CANDIDATE_TAG = "candidate for a global rule \u2014 NOT yet a standard";

const REF = "[0-9a-f]{8}";
// One block header. Whitespace between the helpdesk's own date stamp and our markers is
// tolerated, as is a repeated date (a helpdesk that does not stamp gets ours - see render).
const HEAD = new RegExp(
  `\\[(\\d{4}-\\d{2}-\\d{2})\\]\\s*(?:\\[\\d{4}-\\d{2}-\\d{2}\\]\\s*)?` +
  `\\[(verified|unverified|retracted)\\]\\[ref (${REF})\\]` +
  `(?:\\[topic ([a-z0-9][a-z0-9-]{0,39})\\])?` +
  `(?:\\[ticket ([^\\]\\s][^\\]]{0,39})\\])?` +
  `(?:\\[(amend|retract|correction) ref (${REF})\\])?`, "g");

const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const day = (now) => new Date(now).toISOString().slice(0, 10);

// ---- marker: render / parse ----------------------------------------------------------

/** The marker text. `date` is omitted when the helpdesk operation stamps its own. */
export function renderMarker({ date = "", state, ref, topic = "", ticket = "", kind = "", target = "" }) {
  return (date ? `[${date}]` : "") + `[${state}][ref ${ref}]` +
    (topic ? `[topic ${topic}]` : "") + (ticket ? `[ticket ${ticket}]` : "") +
    (kind && target ? `[${kind} ref ${target}]` : "");
}

/** Split article text into { pre, blocks[] }. A block runs to the next header. */
export function parseBlocks(text) {
  const s = String(text ?? "");
  const heads = [...s.matchAll(HEAD)];
  const blocks = heads.map((m, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : s.length;
    return {
      date: m[1], state: m[2], ref: m[3], topic: m[4] || "", ticket: m[5] || "",
      kind: m[6] || "", target: m[7] || "",
      body: s.slice(m.index + m[0].length, end).trim(), raw: s.slice(m.index, end).trimEnd(),
      idx: i,
    };
  });
  return { pre: heads.length ? s.slice(0, heads[0].index) : s, blocks };
}

// ---- entry hygiene -----------------------------------------------------------------

/**
 * One line, no forged markers, and the model's own leading date split off so the clock
 * check can look at it. Collapsing to one line is what lets a block be told from the text
 * around it; the marker-neutralising is what stops an entry from forging a header.
 */
export function normaliseEntry(entry) {
  let s = squash(entry);
  let leadingDate = "";
  const m = s.match(/^\[(\d{4}-\d{2}-\d{2})\]\s*/);
  if (m) { leadingDate = m[1]; s = s.slice(m[0].length); }
  s = s.replace(/\[((?:\d{4}-\d{2}-\d{2}|verified|unverified|retracted|(?:ref|topic|ticket|amend ref|retract ref|correction ref) [^\]]*))\]/gi, "($1)");
  return { text: s, leadingDate };
}

export function slugTopic(topic, text = "") {
  const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return slug(topic) || slug(String(text).split(/\s+/).slice(0, 4).join(" ")) || "general";
}

/** Stable id of a statement: (ticket, topic, state, normalised text). Case/punctuation-blind. */
export function entryHash({ ticket = "", topic = "", state = "", text = "" }) {
  const t = String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return crypto.createHash("sha1").update(`${ticket}\n${topic}\n${state}\n${t}`).digest("hex").slice(0, 8);
}

// ---- D. clock ----------------------------------------------------------------------

/** The server date wins. Anything the model dated more than a day away is refused. */
export function checkClock({ leadingDate = "", date = "" } = {}, now) {
  const server = day(now);
  for (const d of [leadingDate, date]) {
    if (!d) continue;
    const gap = Math.abs(Date.parse(d) - Date.parse(server)) / 864e5;
    if (!(gap <= 1)) return { ok: false, server, reason: `clock error: the entry is dated ${d} but the server date is ${server}. The server stamps the date - do not write one` };
  }
  return { ok: true, server };
}

// ---- E. scope ----------------------------------------------------------------------

// Wording that turns one client's observation into a rule for everyone.
const GLOBAL_CLAIM = /\b(standing rule|hard rule|for all clients?|all (?:clients|customers|companies)|every (?:client|customer|company)|global (?:rule|standard|policy)|company[- ]wide|across (?:all|every) (?:clients?|customers?|companies))\b/i;
const NEGATED = /\b(do ?n'?t|do not|never|not yet|hold off|wait)\b/i;
const lower = (s) => squash(s).toLowerCase();

/**
 * Default is the client article. A rule for everyone needs the technician's instruction in
 * this session AND the entry must quote it, so the claim carries its own authority. Wording
 * a one-client observation as a standing rule is refused either way; `candidate` is the way
 * to say "might generalise".
 */
export function checkScope({ scope = "client", text = "", techTurns = [] } = {}) {
  const want = ["global", "candidate"].includes(scope) ? scope : "client";
  const claims = GLOBAL_CLAIM.test(text);
  if (want === "candidate" && !claims) return { ok: true, scope: "candidate", tag: CANDIDATE_TAG };
  if (want === "client" && !claims) return { ok: true, scope: "client", tag: "" };
  const entry = lower(text);
  for (const t of [...(techTurns || [])].reverse()) {
    const turn = String(t?.text || "");
    if (!(GLOBAL_CLAIM.test(turn) || /\bglobal\b/i.test(turn)) || NEGATED.test(turn)) continue;
    for (const clause of turn.split(/[.!?\n]+/)) {
      const c = lower(clause);
      if (c.length >= 15 && entry.includes(c)) return { ok: true, scope: "global", tag: "", quote: squash(clause) };
    }
  }
  return {
    ok: false, scope: want,
    reason: "a rule for all clients needs the technician's instruction in this chat, quoted verbatim in the entry - none found. " +
      "One client's result is recorded as that client's entry; add scope:'candidate' if it might generalise, and do not word it as a standing rule",
  };
}

// ---- A. verification gate ------------------------------------------------------------

const normKind = (k) => String(k || "").toLowerCase().replace(/[\s-]+/g, "_");

/**
 * Is this entry proven? `results` are the tool results observed in this chat. A quote is
 * accepted only when it appears verbatim in one of them - a model cannot cite what it did
 * not see. `offline` (the procedure miner) is evidence for an UNVERIFIED entry only.
 */
export function classifyBasis({ evidence = null, state = "verified", results = [] } = {}) {
  const kind = normKind(evidence?.kind);
  const quote = squash(evidence?.quote);
  if (UNPROVEN_KINDS.has(kind))
    return { ok: false, basis: kind, reason: `unproven: '${kind}' is an intention or a belief, not an observed result` };
  if (state === "unverified")
    return { ok: true, state: "unverified", basis: kind || "none" };
  if (!VERIFIED_KINDS.has(kind))
    return { ok: false, basis: kind || "none", reason: "unproven: no evidence given. A verified entry needs evidence {kind: readback|result_json|log|cdr, quote}. A change you applied but could not verify is saved with state:'unverified'" };
  if (quote.length < MIN_QUOTE)
    return { ok: false, basis: kind, reason: `unproven: the evidence quote is under ${MIN_QUOTE} characters` };
  if (!results.some((r) => squash(r).includes(quote)))
    return { ok: false, basis: kind, reason: "unproven: the evidence quote was not found verbatim in any tool result observed in this chat" };
  return { ok: true, state: "verified", basis: kind };
}

// ---- resolve: newest block per ref wins, retract removes ---------------------------------

/**
 * Annotate each block with `live`. A block is superseded by a later amend of its ref (or of
 * anything amended from it) and removed by a retract/correction pointing at it; tombstones
 * (state `retracted`) are never live. Returns { blocks, dead } - `dead` is every ref that
 * must not be shown, including targets whose own block is not in this text (recall sees
 * one search section at a time).
 */
export function resolveBlocks(blocks, { dead: extraDead = new Set() } = {}) {
  const order = [...blocks].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.idx - b.idx));
  const keyOf = new Map();
  for (const b of order) keyOf.set(b.ref, b.kind === "amend" ? (keyOf.get(b.target) ?? b.target) : b.ref);
  const deadKeys = new Set();
  const dead = new Set(extraDead);
  const newest = new Map();
  for (const b of order) {
    if (b.kind === "retract" || b.kind === "correction") deadKeys.add(keyOf.get(b.target) ?? b.target);
    if (b.target) dead.add(b.target);                     // retracted, corrected or amended away
    if (b.state === "retracted") dead.add(b.ref);
    if (b.kind !== "retract") newest.set(keyOf.get(b.ref), b.ref);
  }
  for (const [ref, key] of keyOf) if (deadKeys.has(key)) dead.add(ref);
  const out = blocks.map((b) => {
    const key = keyOf.get(b.ref);
    return { ...b, key, live: b.state !== "retracted" && !dead.has(b.ref) && !deadKeys.has(key) && newest.get(key) === b.ref };
  });
  return { blocks: out, dead };
}

/** Refs that must be hidden, found across several texts (the search sections of one recall). */
export function deadRefsOf(texts) {
  const all = []; let n = 0;
  for (const t of texts || []) for (const b of parseBlocks(t).blocks) all.push({ ...b, idx: n++ });
  return resolveBlocks(all).dead;
}

// ---- F. recall -----------------------------------------------------------------------

/**
 * What the model may be shown. Retracted and superseded blocks are dropped; verified ones
 * pass; unverified ones are flagged in the text itself. Text with no markers (every
 * pre-guard entry) passes unchanged - the guard does not get to delete history it did not
 * write. `opts.dead` adds refs found elsewhere (another section of the same search).
 */
export function recallFilter(text, { dead = new Set(), keepUnverified = true } = {}) {
  const { pre, blocks } = parseBlocks(text);
  if (!blocks.length) return String(text ?? "");
  const { blocks: resolved } = resolveBlocks(blocks, { dead });
  const keep = resolved.filter((b) => b.live && (keepUnverified || b.state === "verified"))
    .map((b) => (b.state === "unverified" ? `${UNVERIFIED_PREFIX} ${b.raw}` : b.raw));
  return [pre.trim(), ...keep].filter(Boolean).join("\n\n");
}

// ---- amend / correction / retract planning -----------------------------------------------

/**
 * Turn "replace / correct / withdraw ref X" into the block to append. The target must be a
 * live block in the article - a pointer to nothing is the contradiction-with-no-pointer
 * this whole thing exists to prevent.
 */
export function planChange({ kind, targetRef, text = "", reason = "", who = "", blocks = [] }) {
  const ref = String(targetRef || "").toLowerCase();
  if (!new RegExp(`^${REF}$`).test(ref)) return { ok: false, reason: `${kind} needs target_ref - the [ref xxxxxxxx] of the block it is about` };
  const target = resolveBlocks(blocks).blocks.find((b) => b.ref === ref);
  if (!target) return { ok: false, reason: `unknown ref ${ref}: no such block in this client's article` };
  if (!target.live) return { ok: false, noop: true, ref, reason: `${ref} is already retracted or superseded` };
  if (kind === "amend") return { ok: true, kind, target, topic: target.topic, body: text };
  if (kind === "correction") return { ok: true, kind, target, topic: target.topic, body: `CORRECTION to ${ref}: ${text}` };
  if (kind === "retract") return { ok: true, kind, target, topic: target.topic, body: `RETRACTED ${ref}${who ? ` by ${who}` : ""}: ${reason || "no reason given"}` };
  return { ok: false, reason: `unknown kind '${kind}'` };
}

// ---- B. idempotent -------------------------------------------------------------------

/**
 * Same hash, or the same (topic, state) already recorded in the last 24 h => write nothing.
 * Block dates carry no time, so "today" is the article-side proxy and `recentAt` (the
 * budget store, which has timestamps) covers yesterday evening. Only LIVE blocks count: a
 * retracted statement may be written again, correctly.
 */
export function dedupe({ blocks = [], hash, topic, state, kind = "entry", now, recentAt = 0 }) {
  const live = resolveBlocks(blocks).blocks.filter((b) => b.live);
  const same = live.find((b) => b.ref === hash);
  if (same) return { dup: true, ref: same.ref, why: "same content" };
  if (kind !== "entry") return { dup: false };
  const today = day(now);
  const near = live.find((b) => b.topic === topic && b.state === state && b.date === today);
  if (near) return { dup: true, ref: near.ref, why: `topic '${topic}' already recorded (${state}) today - amend it with kind:'amend', target_ref:'${near.ref}'` };
  if (recentAt && new Date(now).getTime() - recentAt < WINDOW_MS)
    return { dup: true, ref: "", why: `topic '${topic}' already recorded (${state}) in the last 24 h - amend it instead` };
  return { dup: false };
}

// ---- G. budget + visibility ------------------------------------------------------------

/** 1 write per ticket per turn, 3 per ticket per hour. Retractions and corrections pass. */
export function budgetVerdict({ stamps = [], turnUsed = false, now, exempt = "" }) {
  if (exempt === "all") return { ok: true };
  const t = new Date(now).getTime();
  if (exempt !== "turn" && turnUsed && PER_TURN === 1)
    return { ok: false, reason: `budget: ${PER_TURN} KB write per ticket per turn already used - save the outcome once, not each step` };
  const n = stamps.filter((s) => t - s < HOUR_MS).length;
  if (n >= PER_HOUR) return { ok: false, reason: `budget: ${PER_HOUR} KB writes per ticket per hour already used` };
  return { ok: true };
}

/** The one line the technician sees for every write and every refusal. */
export function chatLine({ scope = "client", article = "", action, basis = "" }) {
  return `KB write: ${scope} \u00b7 ${article || "article"} \u00b7 ${action} \u00b7 basis: ${basis || "none"}`;
}

// ---- I. cleanup: removing text an article no longer needs ----------------------------
//
// Append-only was right for CAPTURE and wrong for CLEANUP. On 2026-11-16 the technician had
// to record what a Teams dial plan standard replaced by appending a RETIREMENT NOTICE that
// named the wrong entries by hand - because the tool could not delete them - so eleven
// contradictory entries stayed visible in a shared article, and a typo in that notice had to
// be corrected by appending a second entry. The KB is the runbook a technician reads under
// pressure; stale text in it is not history, it is a wrong instruction.
//
// So the guard gains one more verb, and it is deliberately the narrowest of them:
//   * it needs a PERSON. The only evidence a cleanup accepts is the technician's own
//     instruction in this chat - not a plan, not an entry, not the model's opinion that
//     something is stale (spec E's rule for global entries, applied to deletion).
//   * it does not reuse the capture gates: a delete has no "verification" to offer and no
//     reason to be rationed to one per turn, so the clock, dedupe and per-turn rules do not
//     apply. What DOES apply is a rate cap, so a loop cannot chew through an article.
//   * every irreversible part of the work is in helpdesk.js, where only the article itself
//     can answer it: quotes must match EXACTLY ONCE, the previous body is saved as an
//     attachment before the write, the write is read back and verified, more than half the
//     article may not go in one call, and an article may not be emptied.
const CLEANUP_INTENT = /\b(delete|deleting|remove|removing|drop|dropping|clean(?:ing)?\s?up|cleanup|tidy(?:ing)?|retire[sd]?|retiring|strip\s+(?:it\s+)?out|get\s+rid\s+of|prune|purge|trim|supersed(?:e|ed|es)|out\s+of\s+date|stale|obsolete|wrong\s+now|no\s+longer\s+(?:needed|true|valid|applies))\b/i;
const NO_CLEANUP = /\b(don't|do not|never|hold off|wait|not yet|without\s+deleting|leave\s+it)\b/i;
/** How many cleanup calls per hour per ticket/company. Enough for a real tidy-up, not a loop. */
export const CLEANUPS_PER_HOUR = 6;
export const MAX_TARGETS = 40;

/**
 * Did a PERSON ask for this? Returns {ok, quote} or {ok:false, reason}. The clause is
 * returned so the chat line (and the log) carries their words, not ours.
 */
export function checkCleanupInstruction({ techTurns = [] } = {}) {
  for (const t of [...(techTurns || [])].reverse()) {
    for (const clause of String(t?.text || "").split(/[.!?\n]+/)) {
      const c = squash(clause);
      if (c.length < 8 || !CLEANUP_INTENT.test(c) || NO_CLEANUP.test(c)) continue;
      return { ok: true, quote: c.slice(0, 240) };
    }
  }
  return {
    ok: false,
    reason: "a KB cleanup needs the technician's own instruction in this chat (delete / remove / clean up / retire \u2026) - " +
      "nothing is deleted on the model's judgement that text looks stale. Ask them which entries to remove, and keep working",
  };
}

/** The chat line for a cleanup. Says what went and where the backup is. */
export function editChatLine({ scope = "client", article = "", action }) {
  return `KB edit: ${scope} \u00b7 ${article || "article"} \u00b7 ${action}`;
}
