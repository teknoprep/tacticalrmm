// WORK LEDGER — every ticket touched in the window, every person who worked it,
// with proportional credit. Replaces the "one credited assignee" model.
//
// Reads Odoo directly (read-only: search_read / read only, no writes).
// Credentials come from the env (exported from CoreSettings by run.sh).
//
//   node ledger.mjs --days 7 [--out /tmp/work_ledger.json]
//
// CREDIT MODEL
//   Each person's contribution to a ticket is scored in "effort units" from the
//   work they actually did on it:
//       customer-visible reply : 3 units  (+1 per 400 chars, capped +3)
//       internal note          : 1 unit   (+1 per 400 chars, capped +2)
//       AI msg they directed   : 2 units  (they composed the intent)
//   A person's SHARE of a ticket = their units / all units on that ticket.
//   When a ticket COMPLETES (a real non-terminal -> terminal transition in the
//   window), that one completion is split across contributors by share, so
//   3 people at 20/40/40 each get 0.2 / 0.4 / 0.4 of a completion. Shares always
//   sum to 1.0 per completed ticket — the ledger balances.

const BASE = (process.env.HD_BASE || "").replace(/\/+$/, "");
const DB = process.env.HD_DB || "blueuc";
const LOGIN = process.env.HD_LOGIN || "";
const KEY = process.env.HD_KEY || "";
const BOT_UID = 35;
const AI_PARTNER = 21605;

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const DAYS = parseInt(argOf("--days", "7"), 10);
const OUT = argOf("--out", "/tmp/work_ledger.json");

let uid = null;
async function rpc(service, method, args) {
  const res = await fetch(BASE + "/jsonrpc", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }),
  });
  const data = await res.json();
  if (data.error) throw new Error((data.error.data && data.error.data.message) || data.error.message || "RPC error");
  return data.result;
}
async function login() {
  if (uid) return uid;
  uid = await rpc("common", "authenticate", [DB, LOGIN, KEY, {}]);
  if (!uid) throw new Error("Odoo authentication failed");
  return uid;
}
async function kw(model, method, args, kwargs) {
  await login();
  return rpc("object", "execute_kw", [DB, uid, KEY, model, method, args, kwargs || {}]);
}

const MODEL = "sh.helpdesk.ticket";
const isTerminal = (s) => /clos|cancel|done|billing/i.test(String(s || ""));
const toText = (s) => String(s == null ? "" : s)
  .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim();
const clean = (n) => String(n || "?").replace(/^BlueCloud IAAS, LLC,\s*/i, "").trim();

// Effort scoring — deliberately simple and explainable in the report.
function units(kind, chars) {
  if (kind === "reply") return 3 + Math.min(3, Math.floor(chars / 400));
  if (kind === "note") return 1 + Math.min(2, Math.floor(chars / 400));
  if (kind === "ai_directed") return 2;
  return 0;
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 19).replace("T", " ");
  process.stderr.write(`window: since ${since} (${DAYS}d)\n`);

  // 1. Every ticket touched in the window, all teams.
  const rows = await kw(MODEL, "search_read", [[["write_date", ">=", since]]], {
    fields: ["id", "name", "email_subject", "partner_id", "email", "user_id", "team_id",
             "stage_id", "create_date", "create_uid", "write_date", "write_uid"],
    limit: 5000, order: "write_date desc",
  });
  process.stderr.write(`tickets touched: ${rows.length}\n`);
  const ids = rows.map((r) => r.id);
  const byId = {}; for (const r of rows) byId[r.id] = r;

  // 2. Who is staff (internal users) — and the stage name map.
  const users = await kw("res.users", "search_read", [[["active", "=", true]]],
    { fields: ["id", "name", "partner_id"], limit: 500 });
  const staffPartner = {}; for (const u of users) if (u.partner_id) staffPartner[u.partner_id[0]] = u.name;
  const stages = await kw("helpdesk.stages", "search_read", [[]], { fields: ["id", "name"], limit: 100 });
  const stageName = {}; for (const s of stages) stageName[s.id] = s.name;

  // 3. Messages in the window -> the work ledger.
  const led = {};   // ticket id -> { people: {name:{units,replies,notes,ai,chars,first,last}}, events:[] }
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    if (!chunk.length) break;
    const msgs = await kw("mail.message", "search_read",
      [[["model", "=", MODEL], ["res_id", "in", chunk], ["date", ">=", since],
        ["message_type", "in", ["comment", "email", "email_outgoing"]]]],
      { fields: ["res_id", "author_id", "subtype_id", "date", "body"], limit: 8000, order: "id asc" });
    for (const m of msgs) {
      const rid = Array.isArray(m.res_id) ? m.res_id[0] : m.res_id;
      const aid = m.author_id ? m.author_id[0] : null;
      const isBot = aid === AI_PARTNER;
      const isStaff = !!staffPartner[aid];
      if (!isStaff && !isBot) continue;                  // customers do not earn credit
      const isNote = !!(m.subtype_id && /note/i.test(m.subtype_id[1] || ""));
      const chars = toText(m.body || "").length;
      const name = isBot ? "AI (Johnny 5)" : clean(m.author_id[1]);
      const kind = isBot ? "ai_directed" : (isNote ? "note" : "reply");
      const L = (led[rid] = led[rid] || { people: {}, events: [] });
      const P = (L.people[name] = L.people[name] || {
        name, units: 0, replies: 0, notes: 0, ai: 0, chars: 0, is_ai: isBot, first: null, last: null });
      P.units += units(kind, chars);
      P.chars += chars;
      if (isBot) P.ai += 1; else if (isNote) P.notes += 1; else P.replies += 1;
      if (!P.first || m.date < P.first) P.first = m.date;
      if (!P.last || m.date > P.last) P.last = m.date;
      L.events.push({ at: m.date, who: name, kind, chars });
    }
  }

  // 4. Stage history -> genuine completions (non-terminal -> terminal).
  // Source: sh.helpdesk.ticket.stage.info, the helpdesk's own per-stage history
  // (stage_name, date_in, date_in_by). The FULL history per ticket is read, not just
  // the window, because knowing whether a move was a real completion requires the
  // stage it came FROM - which may predate the window.
  const closeEvents = {};                                 // ticket id -> {at, author, from, to}
  const histByTicket = {};
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    if (!chunk.length) break;
    const hist = await kw("sh.helpdesk.ticket.stage.info", "search_read",
      [[["stage_task_id", "in", chunk]]],
      { fields: ["stage_task_id", "stage_name", "date_in", "date_in_by"], limit: 20000, order: "date_in asc, id asc" });
    for (const h of hist) {
      const rid = Array.isArray(h.stage_task_id) ? h.stage_task_id[0] : h.stage_task_id;
      (histByTicket[rid] = histByTicket[rid] || []).push(h);
    }
  }
  let reopened = 0;
  for (const [rid, hist] of Object.entries(histByTicket)) {
    hist.sort((a, b) => String(a.date_in || "").localeCompare(String(b.date_in || "")) || a.id - b.id);
    let sawTerminal = false;
    for (let i = 0; i < hist.length; i++) {
      const to = hist[i].stage_name || "";
      const from = i > 0 ? (hist[i - 1].stage_name || "") : "";
      const at = hist[i].date_in || "";
      if (isTerminal(to) && !isTerminal(from) && at >= since) {
        if (sawTerminal) reopened++;                       // closed, reopened, closed again
        if (!closeEvents[rid]) {
          closeEvents[rid] = {
            at, from: from || "(new)", to,
            author: hist[i].date_in_by || null,             // [uid, name] who moved it
          };
        }
      }
      if (isTerminal(to)) sawTerminal = true;
    }
  }
  process.stderr.write(`genuine completions in window: ${Object.keys(closeEvents).length} (reopen-reclose seen: ${reopened})\n`);

  // 5. Build per-ticket shares + the per-person ledger.
  const people = {};
  const tickets = [];
  const personOf = (n) => (people[n] = people[n] || {
    name: n, tickets: 0, units: 0, replies: 0, notes: 0, ai: 0, chars: 0,
    completions: 0, completions_human: 0, sole: 0, shared: 0, active_minutes: 0,
    is_ai: n === "AI (Johnny 5)" });
  let aiOnlyCompletions = 0;

  for (const r of rows) {
    const L = led[r.id];
    if (!L || !Object.keys(L.people).length) continue;     // nobody on staff worked it in-window
    const total = Object.values(L.people).reduce((a, p) => a + p.units, 0) || 1;
    // Estimated hands-on minutes per person: gaps between their own events on this
    // ticket, idle capped at 15min, 3min floor for a lone touch.
    const mins = {};
    const byWho = {};
    for (const e of L.events) (byWho[e.who] = byWho[e.who] || []).push(e);
    for (const [who, evs] of Object.entries(byWho)) {
      evs.sort((a, b) => a.at.localeCompare(b.at));
      let m = 3;
      for (let i = 1; i < evs.length; i++) {
        const gap = (new Date(evs[i].at + "Z") - new Date(evs[i - 1].at + "Z")) / 60000;
        m += Math.min(15, Math.max(1, gap));
      }
      mins[who] = Math.round(m);
    }
    // Two credit views:
    //   share       - the AI is IN the split (shows how much was machine-carried)
    //   share_human - renormalised across humans only, so the people on a ticket
    //                 always split a whole completion between them
    const humanTotal = Object.values(L.people).filter((p) => !p.is_ai)
      .reduce((a, p) => a + p.units, 0);
    const aiUnits = Object.values(L.people).filter((p) => p.is_ai)
      .reduce((a, p) => a + p.units, 0);
    const contribs = Object.values(L.people)
      .map((p) => ({
        ...p,
        share: p.units / total,
        share_human: p.is_ai || !humanTotal ? 0 : p.units / humanTotal,
        minutes: mins[p.name] || 0,
      }))
      .sort((a, b) => b.share - a.share);
    const ce = closeEvents[r.id] || null;
    const humans = contribs.filter((c) => !c.is_ai);
    const sharedCredit = humans.length > 1;
    if (ce && !humanTotal) aiOnlyCompletions++;

    for (const c of contribs) {
      const P = personOf(c.name);
      P.tickets += 1; P.units += c.units; P.replies += c.replies; P.notes += c.notes;
      P.ai += c.ai; P.chars += c.chars; P.active_minutes += c.minutes;
      if (ce) {
        P.completions += c.share;                          // AI in the split
        P.completions_human += c.share_human;              // humans-only split
        if (!c.is_ai) { if (sharedCredit) P.shared += 1; else P.sole += 1; }
      }
    }

    tickets.push({
      ref: r.name, id: r.id,
      url: BASE + "/web#id=" + r.id + "&model=" + MODEL + "&view_type=form",
      subject: r.email_subject || "",
      company: r.partner_id ? r.partner_id[1] : "",
      team: r.team_id ? r.team_id[1] : "",
      stage: r.stage_id ? (stageName[r.stage_id[0]] || r.stage_id[1]) : "",
      assignee: r.user_id ? clean(r.user_id[1]) : "",
      last_writer: r.write_uid ? clean(r.write_uid[1]) : "",
      completed_in_window: !!ce,
      completed_at: ce ? ce.at : null,
      completed_from: ce ? ce.from : null,
      completed_to: ce ? ce.to : null,
      completed_by_action: ce && ce.author ? clean(ce.author[1]) : null,
      total_units: total,
      ai_carry_pct: total ? Math.round((aiUnits / total) * 100) : 0,
      human_work: humanTotal > 0,
      contributors: contribs.map((c) => ({
        name: c.name, units: c.units, share: +(c.share).toFixed(4),
        pct: Math.round(c.share * 100),
        pct_human: c.is_ai ? null : Math.round(c.share_human * 100),
        replies: c.replies, notes: c.notes,
        ai: c.ai, minutes: c.minutes, is_ai: c.is_ai,
      })),
      shared_credit: sharedCredit,
      // What the OLD rule would have credited: last writer of a currently-terminal ticket.
      old_rule_credit: isTerminal(r.stage_id ? (stageName[r.stage_id[0]] || "") : "")
        && r.write_uid ? clean(r.write_uid[1]) : null,
    });
  }

  const out = {
    generated: new Date().toISOString(), days: DAYS, since,
    tickets_touched: rows.length,
    tickets_with_staff_work: tickets.length,
    completions: tickets.filter((t) => t.completed_in_window).length,
    ai_only_completions: aiOnlyCompletions,
    reopen_reclose: reopened,
    people: Object.values(people).sort((a, b) => b.units - a.units),
    tickets: tickets.sort((a, b) => (b.completed_in_window - a.completed_in_window) || b.total_units - a.total_units),
  };
  const fs = await import("node:fs");
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  process.stderr.write(`wrote ${OUT}\n`);
  console.log(`people=${out.people.length} tickets_with_work=${out.tickets_with_staff_work} completions=${out.completions}`);
}

main().catch((e) => { console.error("FATAL: " + e.message); process.exit(1); });
