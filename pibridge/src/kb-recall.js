// KB RECALL (owner, 2026-09-30).
//
// WHY THIS EXISTS: on TICKET/60765 the ticket chat proposed hand-building a Follow-Me leg
// (9201340) for a Teams user. Our own MS Teams Integration app owns that leg, and the app is
// documented in the KB. The chat never read it: nothing in the decision-chat prompt said
// "read the KB first", no KB content was handed to it, get_global_kb matched a whole phrase
// against titles only, and get_kb_article stopped at 12,000 of KB 106's 231,000 characters.
//
// Two parts:
//   KB_FIRST_RULE  - appended AFTER the (admin-overridable) decision policy, so an override
//                    in Global Settings cannot drop it.
//   kbRecall()     - runs the helpdesk's search_kb (see the helpdesk code in Global
//                    Settings) and formats the matching sections. The ticket chat calls it
//                    once at start (ticket summary -> system prompt) and on every
//                    technician turn (their words -> a "KB recall" block on the message).
//                    Sections already shown in this chat are not re-sent.
//
// The per-turn block is wrapped as a [[pi-attachment:...]] so the chat UI shows it as a chip
// ("KB recall") instead of pasting KB text into the technician's own bubble.
import { attachOpen, ATTACH_CLOSE } from "./attachments.js";

export const KB_FIRST_RULE =
  `\n\nOUR KNOWLEDGE BASE COMES FIRST (owner, 2026-09-30 - this rule is not optional):\n` +
  `BlueCloud documents its own systems and apps in the KB - the MS Teams Integration FusionPBX app, the ACD app, ` +
  `the VoIP/PBX fleet, Microsoft 365 admin access, hard rules the technicians set. Those entries are the ground truth ` +
  `for how WE do things.\n` +
  `1. Before you plan, propose or change anything - and whenever a product, app, table, dialplan, error or procedure ` +
  `comes up - run helpdesk_call search_kb with specific words (the app/product name + what you are doing). It searches ` +
  `titles AND content of this customer's KB, BlueCloud's internal KB and the global KB, and returns the matching ` +
  `sections. Every technician message also arrives with a "KB recall" block the bridge searched for you: read it.\n` +
  `2. If one of OUR apps owns something, do it THROUGH THE APP as documented. The MS Teams Integration app owns ` +
  `per-user enablement (v_teams_users), tenant/SBC state, the generated dialplans (ms_teams_ext_<ext>, 9201<ext>, ` +
  `9202<ext>, ms_teams_presence_<ext>) and the Microsoft 365 side. Never hand-build config an app generates, and ` +
  `never offer that to the technician as an option.\n` +
  `3. Say which KB article (id + entry date) you are following. Newer entries win over older ones; a CORRECTION, ` +
  `HARD RULE or STANDING RULE overrides what it corrects.\n` +
  `4. If the KB is silent, or contradicts what the system shows, say so plainly, work from evidence, and record the ` +
  `verified answer with upsert_ai_kb_article so the next run finds it.\n` +
  `5. Long articles are paged. get_kb_article with query="words" returns only the matching sections, and offset= ` +
  `reads on. Never conclude an article lacks something from its first 12,000 characters.\n`;

const stripAttachments = (s) => String(s || "")
  .replace(/\[\[pi-attachment:[^\]]*\]\][\s\S]*?\[\[\/pi-attachment\]\]/g, " ")
  .replace(/The technician attached \d+ file\(s\)[^\n]*\n?/g, " ");

const sig = (t) => String(t || "").slice(0, 240).replace(/\s+/g, " ").toLowerCase();

function withTimeout(p, ms) {
  let timer;
  return Promise.race([p, new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })])
    .finally(() => clearTimeout(timer));
}

/**
 * Search the KB and return { text, count } - text is "" when there is nothing (new) to show.
 * Never throws: a KB outage must not break the technician's turn.
 *
 * @param hd        loaded helpdesk module (needs operations.search_kb)
 * @param opts.query  words to search for
 * @param opts.ticket ticket ref - the helpdesk scopes the search to that ticket's company
 * @param opts.seen   Set of section signatures already shown in this chat (mutated)
 * @param opts.limit  max sections
 * @param opts.budget max characters of quoted KB text
 */
export async function kbRecall(hd, { query, ticket, seen, limit = 5, budget = 7000, timeoutMs = 8000 } = {}) {
  const words = stripAttachments(query).trim();
  if (!hd?.operations?.search_kb || words.length < 12) return { text: "", count: 0 };
  let out;
  try {
    out = await withTimeout(hd.operations.search_kb({ query: words.slice(0, 1500), ticket, limit: limit + 3 }), timeoutMs);
  } catch {
    return { text: "", count: 0 };
  }
  const results = Array.isArray(out?.results) ? out.results : [];
  const fresh = [];
  let used = 0;
  for (const r of results) {
    const s = sig(r.text);
    if (seen && seen.has(s)) continue;
    if (fresh.length >= limit || used + String(r.text || "").length > budget) break;
    fresh.push(r);
    used += String(r.text || "").length;
    if (seen) seen.add(s);
  }
  if (!fresh.length) return { text: "", count: 0 };
  const body = fresh.map((r) =>
    `--- KB ${r.article_id} "${r.title}" (${r.company || "global"})${r.date ? " entry " + r.date : ""}:\n` +
    String(r.text || "").split(ATTACH_CLOSE).join("[[/pi-attachment ]]"),
  ).join("\n\n");
  return { text: body, count: fresh.length };
}

/** The per-turn block, shown as a "KB recall" chip in the chat UI. */
export function kbRecallBlock(text, count) {
  if (!text) return "";
  const inner =
    `AUTOMATIC KB RECALL - not typed by the technician. The bridge searched our knowledge base for the ` +
    `technician's message and found ${count} section(s) not shown earlier in this chat. Read them before you ` +
    `act; run search_kb yourself for anything more specific.\n\n${text}`;
  return `${attachOpen(`KB recall (${count} section${count === 1 ? "" : "s"})`, Buffer.byteLength(inner))}\n${inner}\n${ATTACH_CLOSE}`;
}
