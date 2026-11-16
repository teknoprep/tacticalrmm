// KB WRITE GUARD - the I/O half (owner, 2026-11-12). Policy lives in kb-write.js; spec in
// docs/KB-WRITE-GUARD.md. This file reads the client's article, runs the checks in order,
// and only then calls the helpdesk operation. It never throws for a POLICY refusal (it
// returns { refused: true, chatLine }); a helpdesk/network error propagates as it always did.
import fs from "node:fs";
import path from "node:path";
import {
  normaliseEntry, slugTopic, entryHash, checkClock, checkScope, classifyBasis, parseBlocks,
  resolveBlocks, dedupe, planChange, budgetVerdict, renderMarker, chatLine, WINDOW_MS, HOUR_MS,
  checkCleanupInstruction, editChatLine, CLEANUPS_PER_HOUR, MAX_TARGETS,
} from "./kb-write.js";

// ---- what the model has actually SEEN ----------------------------------------------------

/**
 * Bounded ring of tool results (last 40, 4k chars each). "Evidence in this turn" is
 * implemented as "a verbatim fragment of a result observed in this chat" - a deliberate
 * loosening of the spec's "this turn": a chat is stateful and a fix verified on one turn is
 * legitimately recorded on the next. Nothing the model WROTE gets in, nor any KB read (see
 * isObservation) - the incident was the model citing its own earlier block as proof.
 */
export function makeResultRing({ max = 40, cap = 4000 } = {}) {
  const items = [];
  return {
    push(s) {
      const t = typeof s === "string" ? s : JSON.stringify(s ?? "");
      if (!t) return;
      items.push(t.slice(0, cap));
      while (items.length > max) items.shift();
    },
    list: () => items.slice(),
  };
}

// Helpdesk operations whose output is NOT an observation of the world: KB content (our own
// earlier claims come back through it) and operations that echo what the model wrote.
const NOT_OBSERVATION = /kb|^add_note$|^reply_|^resolve_ticket$|^close_ticket$|^upsert|^create_|^update_|^set_|^send_/i;
export const isObservation = (op) => !NOT_OBSERVATION.test(String(op || ""));

// ---- budget store ------------------------------------------------------------------------

/** In-memory budget (tests, and the fallback when the file cannot be written). */
export function memoryBudget() {
  const st = { tickets: {}, recent: {} };
  const turns = new Map();
  return makeBudget(() => st, () => {}, turns);
}

/** Hourly stamps and the topic/state window persist in <sessionsRoot>/kb-write-budget.json. */
export function fileBudget(file) {
  const turns = new Map();
  const load = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { tickets: {}, recent: {} }; } };
  const save = (st) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(st));
      fs.renameSync(tmp, file);
    } catch { /* a budget file that cannot be written must not stop a write; the per-turn cap still holds */ }
  };
  return makeBudget(load, save, turns);
}

function makeBudget(load, save, turns) {
  return {
    stamps: (ticket) => (load().tickets?.[ticket] || []),
    turnUsed: (ticket, turn) => turn != null && turns.get(ticket) === turn,
    recentAt: (key) => (load().recent?.[key] || 0),
    record({ ticket, turn, now, recentKey }) {
      const t = new Date(now).getTime();
      const st = load();
      st.tickets ||= {}; st.recent ||= {};
      st.tickets[ticket] = [...(st.tickets[ticket] || []).filter((s) => t - s < HOUR_MS), t];
      if (recentKey) st.recent[recentKey] = t;
      for (const [k, v] of Object.entries(st.recent)) if (t - v > WINDOW_MS) delete st.recent[k];
      save(st);
      if (turn != null) turns.set(ticket, turn);
    },
  };
}

/** One technician message = one turn. Unattended runs have none: they get one "turn". */
export const turnId = (techSaid) => {
  const t = Array.isArray(techSaid) ? techSaid : [];
  return t.length ? `${t.length}:${t[t.length - 1]?.at || ""}` : "run";
};

// ---- reading the article ------------------------------------------------------------------

const arr = (o) => (Array.isArray(o) ? o : Array.isArray(o?.articles) ? o.articles : []);

/** Page get_kb_article to ~maxScan chars. Returns "" when the article cannot be found. */
async function readArticle(ops, { articleId, partnerId, maxScan }) {
  let id = articleId;
  if (!id && partnerId && ops.list_kb_articles) {
    const rows = arr(await ops.list_kb_articles({ partner_id: partnerId }));
    id = rows.find((r) => /Pi\.dev AI/i.test(String(r?.title || r?.name || "")))?.id || 0;
  }
  if (!id || !ops.get_kb_article) return { id: 0, text: "", truncated: false };
  let text = "", offset = 0, truncated = false;
  for (let guard = 0; guard < 12; guard++) {
    const out = await ops.get_kb_article({ id, article_id: id, offset, limit: 20000 });
    const chunk = typeof out === "string" ? out : String(out?.content ?? out?.text ?? "");
    text += (text ? "\n\n" : "") + chunk;
    const total = Number(out?.total_chars) || 0;
    const more = typeof out === "object" && out && (out.more || (total && offset + chunk.length < total));
    if (!more || !chunk.length) break;
    offset += chunk.length;
    if (text.length >= maxScan) { truncated = true; break; }
  }
  return { id, text, truncated };
}

// ---- the guard ----------------------------------------------------------------------------

/**
 * @param hd            loaded helpdesk (operations.*)
 * @param articleId     company AI article id, when known
 * @param partnerId     company partner_id (list_kb_articles finds the article)
 * @param companyName   label for the chat line
 * @param ticketRef     ticket the work belongs to ("" outside a ticket)
 * @param techSaid      the technician's own turns - [{at,text}] (array reference; read live)
 * @param getRecentResults  () => string[] tool results observed in this chat
 * @param now           () => Date - the SERVER clock
 * @param budget        memoryBudget()/fileBudget()
 * @param log           (event, ref, detail) => void
 * @param globalAuth    () => {at,text}|null - product-code check of a global-KB instruction
 */
export function createKbGuard({
  hd, articleId = 0, partnerId = 0, companyName = "", ticketRef = "", surface = "",
  techSaid = [], getRecentResults = () => [], now = () => new Date(), budget = memoryBudget(),
  log = () => {}, globalAuth = () => null, maxLen = 1500, maxScan = 100000,
  // upsert_ai_kb_article prepends its own [server-date] stamp. A helpdesk that does not
  // would need the guard to supply it.
  helpdeskStamps = true,
  // Offline mining has one pseudo-ticket for every company: count its writes per company.
  budgetByPartner = false,
  // () => company partner_id for the ticket this chat is bound to, or 0. Used only when the
  // model did not name a partner_id (spec E: default to the CLIENT article). It is a
  // callback because it costs an RPC and only this product code knows how to ask.
  resolvePartner = null,
} = {}) {
  const ops = hd?.operations || {};
  const say = (e, d) => { try { log(e, ticketRef, d); } catch { /* logging never blocks a write */ } };
  const ticketKey = (ov) => (budgetByPartner && ov.partnerId ? `partner:${ov.partnerId}` : ticketRef) || (ov.partnerId ? `partner:${ov.partnerId}` : "none");

  const result = (ov, { scope = "client", action, basis, ref = "", refused = false, extra = {} }) => {
    const line = chatLine({ scope, article: ov.label, action, basis });
    say(refused ? "kb_write_refused" : "kb_write", `${scope} ${action} ref=${ref || "-"} basis=${basis || "none"}`);
    return { action: refused ? "refused" : action.split(/[:\s(]/)[0], ref, chatLine: line, ...(refused ? { refused: true } : {}), ...extra };
  };

  const overrides = (o) => {
    const pid = Number(o.partner_id) || partnerId || 0;
    const name = o.company_name || companyName || "";
    return { partnerId: pid, articleId: o.article_id || articleId || 0, name, label: name ? `Pi.dev AI - ${name}` : pid ? `partner ${pid}` : "article" };
  };

  // WHICH ARTICLE. The model normally passes partner_id. When it does not, the TICKET's own
  // company is the authority (spec E: default to the client article) - not "the last company
  // used in this chat", which in a chat that touched two companies could write one client's
  // note into another client's article. With no ticket and no resolver the write is refused.
  const identify = async (o = {}) => {
    let pid = Number(o.partner_id) || partnerId || 0;
    let name = o.company_name || companyName || "";
    if (!pid && resolvePartner) {
      try {
        const r = await resolvePartner();
        // A resolver may know the company's NAME too - the chat line must say which article.
        if (r && typeof r === "object") { pid = Number(r.partner_id || r.id) || 0; if (!name && r.name) name = String(r.name); }
        else pid = Number(r) || 0;
      } catch { pid = 0; }
    }
    return { partner_id: pid, article_id: o.article_id || articleId || 0, company_name: name };
  };

  /** Append one block through upsert_ai_kb_article. */
  async function append(ov, { date, state, ref, topic, kind, target, body, extra }) {
    const marker = renderMarker({ date: helpdeskStamps ? "" : date, state, ref, topic, ticket: ticketRef, kind, target });
    return ops.upsert_ai_kb_article({
      ...(extra || {}), partner_id: ov.partnerId, company_name: ov.name, entry: `${marker} ${body}`,
    });
  }

  return {
    /** A normal entry, an amend, or a correction. Policy order: D clock, E scope, A basis,
     *  read article, B dedupe/plan, G budget, write. */
    async write({
      entry, scope = "client", topic = "", state = "verified", evidence = null, date = "",
      target_ref = "", kind = "entry", extra = {}, partner_id, article_id, company_name,
    } = {}) {
      const ov = overrides(await identify({ partner_id, article_id, company_name }));
      const k = ["amend", "correction"].includes(kind) ? kind : "entry";
      const st = state === "unverified" ? "unverified" : "verified";
      const { text: body0, leadingDate } = normaliseEntry(entry);
      const fail = (reason, basis, sc) => result(ov, { scope: sc || scope, action: `refused: ${reason}`, basis, refused: true });
      if (!ov.partnerId) return fail("partner_id is required", "none");
      if (!body0) return fail("the entry is empty", "none");
      if (body0.length > maxLen) return fail(`entry is ${body0.length} characters (limit ${maxLen}): one outcome per entry, as a few sentences`, "none");

      const clock = checkClock({ leadingDate, date }, now());
      if (!clock.ok) return fail(clock.reason, "none");

      const sc = checkScope({ scope, text: body0, techTurns: techSaid });
      if (!sc.ok) return fail(sc.reason, evidence?.kind || "none", sc.scope);

      const basis = classifyBasis({ evidence, state: st, results: getRecentResults() });
      if (!basis.ok) return fail(basis.reason, basis.basis, sc.scope);

      // "applied, UNVERIFIED" - a real change nobody checked is never worded as a conclusion.
      let body = body0;
      if (basis.state === "unverified" && basis.basis !== "offline" && !/^applied,? unverified/i.test(body))
        body = `applied, UNVERIFIED: ${body}`;
      if (sc.tag) body = `${body} (${sc.tag})`;

      const art = await readArticle(ops, { articleId: ov.articleId, partnerId: ov.partnerId, maxScan });
      const blocks = parseBlocks(art.text).blocks;
      const label = { ...ov };
      if (art.truncated) say("kb_write_note", `article scanned to ${maxScan} chars only`);

      let tTopic = slugTopic(topic, body0), tKind = "", tTarget = "", exempt = "";
      if (k !== "entry") {
        const plan = planChange({ kind: k, targetRef: target_ref, text: body, blocks });
        if (!plan.ok && plan.noop) return result(label, { scope: sc.scope, action: `no-op: ${plan.reason}`, basis: basis.basis, ref: plan.ref });
        if (!plan.ok) return fail(plan.reason, basis.basis, sc.scope);
        body = plan.body; tTopic = topic ? tTopic : plan.topic || tTopic; tKind = k; tTarget = plan.target.ref;
        // A correction exists to repair a wrong claim; the per-turn cap must not make the
        // repair impossible in the turn the error is found. The hourly cap still applies.
        exempt = "turn";
      }
      const ref = entryHash({ ticket: ticketRef, topic: tTopic, state: basis.state, text: body });
      const recentKey = `${ov.partnerId}|${tTopic}|${basis.state}`;
      const dup = dedupe({ blocks, hash: ref, topic: tTopic, state: basis.state, kind: k, now: now(), recentAt: budget.recentAt(recentKey) });
      if (dup.dup) return result(label, { scope: sc.scope, action: `no-op: already recorded (${dup.why})`, basis: basis.basis, ref: dup.ref });

      const tk = ticketKey(ov), turn = turnId(techSaid);
      const bv = budgetVerdict({ stamps: budget.stamps(tk), turnUsed: budget.turnUsed(tk, turn), now: now(), exempt });
      if (!bv.ok) return fail(bv.reason, basis.basis, sc.scope);

      const out = await append(ov, { date: clock.server, state: basis.state, ref, topic: tTopic, kind: tKind, target: tTarget, body, extra });
      budget.record({ ticket: tk, turn, now: now(), recentKey: k === "entry" ? recentKey : "" });
      const verb = k === "correction" ? `corrected ${tTarget}` : k === "amend" ? `amended ${tTarget}` : "written";
      return result(label, { scope: sc.scope, action: `${verb} (${basis.state}, ref ${ref})`, basis: basis.basis, ref, extra: { result: out, state: basis.state } });
    },

    /** kb_retract (H): append [retract ref X]. History stays; recall drops X. */
    async retract({ ref, reason = "", who = "", partner_id, article_id, company_name } = {}) {
      const ov = overrides(await identify({ partner_id, article_id, company_name }));
      const fail = (r) => result(ov, { scope: "client", action: `refused: ${r}`, basis: "retraction", refused: true });
      if (!ov.partnerId) return fail("partner_id is required (which company's article?)");
      if (!squashText(reason)) return fail("a reason is required");
      const art = await readArticle(ops, { articleId: ov.articleId, partnerId: ov.partnerId, maxScan });
      const plan = planChange({ kind: "retract", targetRef: ref, reason: squashText(reason).slice(0, 400), who, blocks: parseBlocks(art.text).blocks });
      if (!plan.ok && plan.noop) return result(ov, { scope: "client", action: `no-op: ${plan.reason}`, basis: "retraction", ref: plan.ref });
      if (!plan.ok) return fail(plan.reason);
      const body = normaliseEntry(plan.body).text;
      const newRef = entryHash({ ticket: ticketRef, topic: plan.topic, state: "retracted", text: body });
      const out = await append(ov, { date: now().toISOString().slice(0, 10), state: "retracted", ref: newRef, topic: plan.topic, kind: "retract", target: plan.target.ref, body });
      // Counted in the log, not against the budget: withdrawing a wrong claim is the one
      // write that must never be rationed.
      return result(ov, { scope: "client", action: `retracted ${plan.target.ref}`, basis: "retraction", ref: newRef, extra: { result: out } });
    },

    /** create_global_kb_article: the technician asked for it (product code checked that), so
     *  the guard adds the clock check, the quote of their instruction, the budget and the
     *  chat line. DEFERRED: no verification gate / marker - a new global article is a
     *  write-up the technician requested, not a conclusion the model drew. */    async createGlobal({ args = {} } = {}) {
      const ov = overrides({});
      const fail = (r) => result(ov, { scope: "global", action: `refused: ${r}`, basis: "instruction", refused: true });
      const auth = (() => { try { return globalAuth(); } catch { return null; } })();
      if (!auth) return fail("a global KB article needs the technician's explicit instruction in this chat");
      const field = typeof args.content === "string" ? "content" : typeof args.entry === "string" ? "entry" : "";
      const lead = String(args[field] || "").trim().match(/^\[(\d{4}-\d{2}-\d{2})\]/)?.[1] || "";
      const clock = checkClock({ leadingDate: lead }, now());
      if (!clock.ok) return fail(clock.reason);
      const tk = ticketKey(ov), turn = turnId(techSaid);
      const bv = budgetVerdict({ stamps: budget.stamps(tk), turnUsed: budget.turnUsed(tk, turn), now: now() });
      if (!bv.ok) return fail(bv.reason);
      const quote = squashText(auth.text).slice(0, 200);
      const next = field ? { ...args, [field]: `${args[field]}\n\n[Requested by the technician${ticketRef ? ` on ${ticketRef}` : ""}: "${quote}"]` } : args;
      const out = await ops.create_global_kb_article(next);
      budget.record({ ticket: tk, turn, now: now() });
      return result({ ...ov, label: String(args.title || "global article") }, { scope: "global", action: "written (technician instruction)", basis: "instruction", extra: { result: out } });
    },

    /** Cleanup (spec I): delete or replace text in an EXISTING article. This is the one verb
     *  the KB never had, and the only one that can destroy text - so it needs a person's
     *  instruction, is rate-capped, takes a backup, and is verified by the operation itself.
     *  No verification gate (there is no observation to quote), no dedupe, no clock: none of
     *  them mean anything for removing text that a newer entry supersedes. */
    async edit({ entries = [], remove = [], replace = [], dry_run = false, partner_id, article_id, company_name } = {}) {
      const ov = overrides(await identify({ partner_id, article_id, company_name }));
      const targets = [entries, remove, replace].reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0);
      const fail = (reason) => {
        const line = editChatLine({ article: ov.label, action: `refused: ${String(reason).slice(0, 400)}` });
        say("kb_edit_refused", `refused: ${String(reason).slice(0, 200)}`);
        return { action: "refused", refused: true, chatLine: line };
      };
      if (!ops.edit_ai_kb_article)
        return fail("this helpdesk has no edit_ai_kb_article operation - deploy the integration first");
      if (!targets)
        return fail("nothing to do: entries:[quote] deletes whole entries, remove:[quote] one statement, replace:[{find,with}] rewrites one");
      if (targets > MAX_TARGETS) return fail(`too many targets in one call (${targets}); max ${MAX_TARGETS} - split the cleanup`);
      if (!ov.partnerId && !article_id) return fail("partner_id or article_id is required (which article is being cleaned up?)");

      // THE ONLY EVIDENCE A DELETE ACCEPTS: the technician asked for it.
      const ins = checkCleanupInstruction({ techTurns: techSaid });
      if (!ins.ok) return fail(ins.reason);

      const tk = `edit:${ticketKey(ov)}`, turn = turnId(techSaid);
      if (!dry_run) {
        // Its own counter: a cleanup is not knowledge capture, so it must not eat (or be
        // eaten by) the 1-per-turn / 3-per-hour write budget. It gets a rate cap of its own.
        const t = new Date(now()).getTime();
        if (budget.stamps(tk).filter((s) => t - s < HOUR_MS).length >= CLEANUPS_PER_HOUR)
          return fail(`rate cap: ${CLEANUPS_PER_HOUR} KB cleanups per hour on this article already used`);
      }

      let out;
      try {
        out = await ops.edit_ai_kb_article({
          ...(ov.partnerId ? { partner_id: ov.partnerId } : {}),
          ...(article_id || ov.articleId ? { article_id: Number(article_id || ov.articleId) } : {}),
          entries, remove, replace, ...(dry_run ? { dry_run: true } : {}),
        });
      } catch (e) {
        return fail(`the helpdesk refused it: ${e?.message || e}`);
      }
      if (out && out.error) return fail(out.error);

      const nEnt = (out?.entries_removed || []).length;
      const nStmt = (out?.statements_removed || []).length;
      const nRep = (out?.replacements || []).length;
      const parts = [];
      if (nEnt) parts.push(`${nEnt} entr${nEnt === 1 ? "y" : "ies"}`);
      if (nStmt) parts.push(`${nStmt} statement${nStmt === 1 ? "" : "s"}`);
      if (nRep) parts.push(`${nRep} replacement${nRep === 1 ? "" : "s"}`);
      const what = parts.join(" + ") || "nothing";
      const money = out && out.chars_before ? ` (${out.chars_before} \u2192 ${out.chars_after} chars)` : "";
      const backup = out && out.backup_attachment_id ? `, backup attachment #${out.backup_attachment_id}` : "";
      if (dry_run) {
        say("kb_edit_planned", `${what}${money} · asked: "${ins.quote.slice(0, 120)}"`);
        return {
          action: "planned", chatLine: editChatLine({ article: ov.label, action: `would delete/replace ${what}${money} - NOTHING WRITTEN (dry run)` }),
          result: out,
        };
      }
      budget.record({ ticket: tk, turn, now: now() });
      say("kb_edit", `${what}${money}${backup} · asked: "${ins.quote.slice(0, 120)}"`);
      return {
        action: "edited",
        chatLine: editChatLine({ article: ov.label, action: `removed/replaced ${what}${money}${backup}` }),
        result: out,
      };
    },
  };
}

const squashText = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// ---- the adapter both tool surfaces share ----------------------------------------------------

export const isKbWrite = (op) => op === "upsert_ai_kb_article" || op === "create_global_kb_article" || op === "edit_ai_kb_article";

/**
 * helpdesk_call arguments -> guard call -> the text the model gets back. The policy fields
 * (evidence, topic, scope, state, kind, target_ref) ride in `args`; everything else is
 * handed to the operation untouched. The chat line is FIRST so it survives any truncation
 * and the model can repeat it to the technician.
 */
export async function runKbOp(guard, op, args = {}) {
  let r;
  if (op === "create_global_kb_article") r = await guard.createGlobal({ args });
  else if (op === "edit_ai_kb_article") {
    const { entries, remove, replace, dry_run, partner_id, article_id, company_name } = args;
    r = await guard.edit({ entries, remove, replace, dry_run, partner_id, article_id, company_name });
  } else {
    const { entry, content, scope, topic, state, evidence, evidence_kind, evidence_quote, date, target_ref, kind,
      partner_id, article_id, company_name, ...extra } = args;
    let ev = evidence;
    if (typeof ev === "string") { try { ev = JSON.parse(ev); } catch { ev = { kind: "", quote: ev }; } }
    r = await guard.write({
      entry: entry ?? content, scope, topic, state, date, target_ref, kind, extra, partner_id, article_id, company_name,
      evidence: ev && typeof ev === "object" ? ev : { kind: evidence_kind, quote: evidence_quote },
    });
  }
  const outcome = r.result && typeof r.result === "object" ? ` Operation result: ${JSON.stringify(r.result).slice(0, 600)}` : "";
  // A cleanup is refused as a set of targets; a capture as one entry.
  const noun = op === "edit_ai_kb_article" ? "targets" : "entry";
  return `${r.chatLine}\n` + (r.refused
    ? `NOTHING WAS WRITTEN. Fix the cause named above; do not resend the same ${noun} unchanged. Show the technician the line above.`
    : `Show the technician the line above.${r.ref ? ` Ref: ${r.ref}.` : ""}${outcome}`);
}
