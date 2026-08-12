// Renders the work-ledger report. Cleaned up per review:
//   * no single "credited assignee" - every contributor is listed with their share
//   * completion credit is fractional and always sums to 1.0 per ticket
//   * low-observation figures are tagged, not presented as precise
//   * time figures are labelled ESTIMATED (they are derived, not tracked)
//
//   node render_report.mjs --in /tmp/work_ledger.json --out /tmp/work_ledger_report.html

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const IN = argOf("--in", "/tmp/work_ledger.json");
const OUT = argOf("--out", "/tmp/work_ledger_report.html");

const fs = await import("node:fs");
const D = JSON.parse(fs.readFileSync(IN, "utf8"));

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));
// Outlook (Office 365) is the target client. Outlook desktop renders via the Word
// engine and is the least reliable at honouring a <style> block, so every style here
// is INLINE - verbose in the source, but it renders the same everywhere.
const TH = "padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px";
const TD = "padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px";
const LINK = "color:#0b5cad;text-decoration:underline";
const H2 = "font-weight:700;color:#1a3c6e;font-size:16px;margin:22px 0 6px";
const MUTED = "color:#666;font-size:11px";
const hrs = (m) => (m >= 60 ? (m / 60).toFixed(1) + "h" : m + "m");

// Confidence tag: how much of this person's picture rests on real observations.
function conf(p) {
  if (p.tickets >= 15 && p.units >= 40) return ["solid", "#137333", "#e6f4ea"];
  if (p.tickets >= 8) return ["moderate", "#8a4b00", "#fff4e5"];
  return ["thin — do not rank", "#b00020", "#fdecea"];
}

const humans = D.people.filter((p) => !p.is_ai);
const ai = D.people.find((p) => p.is_ai);
const sharedTickets = D.tickets.filter((t) => t.completed_in_window && t.shared_credit);
const completed = D.tickets.filter((t) => t.completed_in_window);
// Where the old rule and the new ledger disagree about who earned the completion.
const diffs = completed.filter((t) => {
  const top = t.contributors.filter((c) => !c.is_ai)[0];
  return t.old_rule_credit && top && t.old_rule_credit !== top.name;
});

const out = [];
out.push(`<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.55;color:#24292f">
<div style="font-weight:700;color:#1a3c6e;font-size:20px;margin:0 0 2px">Work Ledger &amp; Completion Credit — last ${D.days} days</div>
<div style="color:#666;font-size:11px;margin:0 0 12px">Window since ${esc(D.since)} UTC · generated ${esc(D.generated.slice(0, 16).replace("T", " "))} UTC
· <b>DRAFT FOR REVIEW — nothing deployed</b></div>`);

// ---- How to read this -----------------------------------------------------
out.push(`<div style="background:#eef3fa;border:1px solid #c9d8ea;border-radius:5px;padding:10px 13px;font-size:12.5px;margin:0 0 16px">
<b>How credit works now.</b> There is no single "credited assignee" any more. Every person who worked a ticket is on its ledger.
Contribution is scored in <b>effort units</b> from the work itself — customer reply = 3 (+1 per 400 chars, max +3), internal note = 1
(+1 per 400 chars, max +2), AI message a person directed = 2. Your <b>share</b> of a ticket is your units ÷ all units on that ticket.
When a ticket completes, that <b>one completion is split by share</b> — 3 people at 20/40/40 each earn 0.2 / 0.4 / 0.4.
Shares always total 1.00 per completed ticket, so the ledger balances no matter how many people touch it.
<br/><br/>
<b>A completion</b> = a real stage move from a non-terminal stage <i>into</i> a terminal one. A <b>Done → Closed</b> review move is
terminal→terminal, so it earns nobody a completion — reviewing no longer takes credit from the tech who did the work.
<br/><br/>
<b>Time is ESTIMATED</b>, not tracked: derived from gaps between a person's own messages on a ticket (idle capped at 15 min, 3 min
floor for a single touch). Treat it as an order-of-magnitude figure, not a timesheet.
<br/><br/>
<b>Two credit columns — pick which one you want as the official number.</b> The AI does a large share of the raw message volume, so
including it in the split pushes every person's completion count down. <b>Humans-only</b> renormalises so the people on a ticket split
a whole completion between them, and the AI's contribution is reported separately as "AI carried&nbsp;X%". I'd make <b>humans-only</b>
the headline number for coaching, with AI carry shown beside it — but say the word and I'll set it either way.</div>`);

// ---- Headline -------------------------------------------------------------
out.push(`<table style="border-collapse:collapse;width:100%;margin:0 0 8px">
<tr><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Tickets touched</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">With staff work</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Completed in window</th>
<th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Shared-credit</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">AI-only completions</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Reopened &amp; re-closed</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">People</th></tr>
<tr><td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${D.tickets_touched}</td><td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${D.tickets_with_staff_work}</td><td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px"><b>${D.completions}</b></td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${sharedTickets.length}</td><td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${D.ai_only_completions ?? 0} <span style="color:#666;font-size:11px">no human worked it in-window</span></td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${D.reopen_reclose ?? 0}</td><td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${humans.length}</td></tr>
</table>`);

// ---- Per-person ledger ----------------------------------------------------
out.push(`<div style="font-weight:700;color:#1a3c6e;font-size:16px;margin:22px 0 6px">1. The ledger — per person</div>
<div style="font-size:12.5px;color:#444;margin:0 0 8px">Completions are <b>fractional</b>: 4.60 means this person's shares across all
the tickets they helped complete add up to 4.6 tickets' worth of finished work. Sole = they were the only human on it; Shared = others
worked it too.</div>
<table style="border-collapse:collapse;width:100%;margin:0 0 8px">
<tr><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Person</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Confidence</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Tickets worked</th>
<th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Completion credit<br/><span style="font-weight:400;font-size:10.5px">humans-only split</span></th>
<th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Completion credit<br/><span style="font-weight:400;font-size:10.5px">AI in the split</span></th>
<th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Sole / Shared</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Replies</th>
<th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Notes</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Effort units</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Est. active time</th></tr>`);
for (const p of humans) {
  const [label, fg, bg] = conf(p);
  out.push(`<tr>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px"><b>${esc(p.name)}</b></td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px;background:${bg}"><span style="color:${fg};font-size:11.5px">${label}</span></td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${p.tickets}</td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px;background:#e6f4ea"><b>${(p.completions_human ?? 0).toFixed(2)}</b></td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${p.completions.toFixed(2)}</td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${p.sole} / ${p.shared}</td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${p.replies}</td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${p.notes}</td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${p.units}</td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${hrs(p.active_minutes)} <span style="color:#666;font-size:11px">est</span></td></tr>`);
}
if (ai) {
  out.push(`<tr style="background:#f4f6f9">
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px"><b>${esc(ai.name)}</b> <span style="color:#666;font-size:11px">(tool, not a person)</span></td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px"><span style="color:#666;font-size:11px">n/a</span></td><td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${ai.tickets}</td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px"><span style="color:#666;font-size:11px">excluded by design</span></td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${ai.completions.toFixed(2)} <span style="color:#666;font-size:11px">(${Math.round((ai.completions / (D.completions || 1)) * 100)}% of all completions)</span></td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px"><span style="color:#666;font-size:11px">—</span></td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${ai.replies}</td><td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${ai.notes}</td><td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${ai.units}</td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px"><span style="color:#666;font-size:11px">—</span></td></tr>`);
}
out.push(`</table>
<div style="color:#666;font-size:11px;margin:0 0 4px">The AI row is shown for transparency about how much of the desk's output it carried. It is a
tool, so it is not ranked against people and earns no coaching judgement.</div>`);

// ---- Shared-credit tickets ----------------------------------------------
out.push(`<div style="font-weight:700;color:#1a3c6e;font-size:16px;margin:22px 0 6px">2. Shared-credit tickets (${sharedTickets.length})</div>`);
if (!sharedTickets.length) {
  out.push(`<div style="font-size:13px;color:#444">No completed ticket in this window had more than one human contributor.</div>`);
} else {
  out.push(`<div style="font-size:12.5px;color:#444;margin:0 0 8px">These completed with more than one person on them. The split is
  the ledger, in full — every contributor and the exact percentage each earned.</div>
  <table style="border-collapse:collapse;width:100%;margin:0 0 8px">
  <tr><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Ticket</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Customer</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Credit split</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Stage move</th></tr>`);
  for (const t of sharedTickets) {
    const split = t.contributors.filter((c) => !c.is_ai).map((c) =>
      `${esc(c.name)} <b>${c.pct_human}%</b>
       <span style="color:#666;font-size:11px">(${c.units}u · ${c.replies}r/${c.notes}n · ${hrs(c.minutes)} est)</span>`).join("<br/>");
    out.push(`<tr>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px;white-space:nowrap"><a href="${t.url}" style="color:#0b5cad;text-decoration:underline"><b>${esc(t.ref.replace("TICKET/", "#"))}</b></a>
<br/><span style="color:#666;font-size:11px">${esc((t.subject || "").slice(0, 46))}</span></td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${esc((t.company || "").split(",")[0])}</td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${split}${t.ai_carry_pct ? `<br/><span style="color:#666;font-size:11px">AI carried ${t.ai_carry_pct}% of the raw volume</span>` : ""}</td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px"><span style="color:#666;font-size:11px">${esc(t.completed_from || "?")} → ${esc(t.completed_to || "?")}<br/>${esc((t.completed_at || "").slice(0, 16))}<br/>moved by ${esc(t.completed_by_action || "?")}</span></td></tr>`);
  }
  out.push(`</table>`);
}

// ---- What changed vs the old rule ---------------------------------------
out.push(`<div style="font-weight:700;color:#1a3c6e;font-size:16px;margin:22px 0 6px">3. What the fix changed (${diffs.length} completions re-attributed)</div>`);
if (!diffs.length) {
  out.push(`<div style="font-size:13px;color:#444">In this window the old "last writer" rule and the ledger agree on the main
  contributor for every completion. The fix still matters: it stops future Done → Closed review moves from taking the credit.</div>`);
} else {
  out.push(`<div style="font-size:12.5px;color:#444;margin:0 0 8px">The old rule credited whoever last wrote a ticket sitting in a
  terminal stage. Where that disagrees with who actually did the work, here is the correction.</div>
  <table style="border-collapse:collapse;width:100%;margin:0 0 8px">
  <tr><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Ticket</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Old rule credited</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Ledger says</th></tr>`);
  for (const t of diffs) {
    const split = t.contributors.filter((c) => !c.is_ai)
      .map((c) => `${esc(c.name)} <b>${c.pct}%</b>`).join(" · ");
    out.push(`<tr>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px;white-space:nowrap"><a href="${t.url}" style="color:#0b5cad;text-decoration:underline"><b>${esc(t.ref.replace("TICKET/", "#"))}</b></a></td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px"><span style="color:#b00020">${esc(t.old_rule_credit)}</span>
<br/><span style="color:#666;font-size:11px">last writer</span></td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px"><span style="color:#137333">${split}</span></td></tr>`);
  }
  out.push(`</table>`);
}

// ---- Full completion ledger --------------------------------------------
const humanCompleted = completed.filter((t) => t.human_work);
const aiOnly = completed.filter((t) => !t.human_work);
out.push(`<div style="font-weight:700;color:#1a3c6e;font-size:16px;margin:22px 0 6px">4. Completion ledger — tickets a person worked (${humanCompleted.length})</div>
<div style="font-size:12.5px;color:#444;margin:0 0 8px">Every completion with human work in it, and its full split. Percentages total
100% on every row — the ledger balances.
${aiOnly.length ? `A further <b>${aiOnly.length}</b> tickets completed with <b>no human work in the window at all</b> (AI/alert
auto-closes) — summarised in section 6 rather than listed here, so they don't drown the human ledger.` : ""}</div>
<table style="border-collapse:collapse;width:100%;margin:0 0 8px">
<tr><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Ticket</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Customer</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Final stage</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Credit split</th></tr>`);
out.push(`<tr><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px" colspan="4"><span style="font-weight:400;font-size:11px">Percentages are the humans-only split. "AI" shows how much of the raw volume the machine carried.</span></th></tr>`);
for (const [i, t] of humanCompleted.entries()) {
  const hs = t.contributors.filter((c) => !c.is_ai);
  const split = hs.length
    ? hs.map((c) => `${esc(c.name)} <b>${c.pct_human}%</b>`).join(" · ")
    : `<span style="color:#b00020">no human work in window</span>`;
  out.push(`<tr style="background:${i % 2 ? "#f4f6f9" : "#fff"}">
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px;white-space:nowrap"><a href="${t.url}" style="color:#0b5cad;text-decoration:underline"><b>${esc(t.ref.replace("TICKET/", "#"))}</b></a>
<br/><span style="color:#666;font-size:11px">${esc((t.subject || "").slice(0, 40))}</span></td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${esc((t.company || "").split(",")[0])}</td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px"><span style="color:#666;font-size:11px">${esc(t.stage)}</span></td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${split}${t.ai_carry_pct ? ` <span style="color:#666;font-size:11px">· AI ${t.ai_carry_pct}%</span>` : ""}</td></tr>`);
}
out.push(`</table>`);

// ---- Open work ----------------------------------------------------------
const open = D.tickets.filter((t) => !t.completed_in_window);
out.push(`<div style="font-weight:700;color:#1a3c6e;font-size:16px;margin:22px 0 6px">5. Work in progress, not yet completed (${open.length})</div>
<div style="font-size:12.5px;color:#444;margin:0 0 8px">Effort spent in the window on tickets that did not complete. This work is
real and is on the ledger — it just has no completion to split yet, so it carries forward.</div>
<table style="border-collapse:collapse;width:100%;margin:0 0 8px">
<tr><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Ticket</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Stage</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Who has worked it</th></tr>`);
for (const [i, t] of open.entries()) {
  const split = t.contributors.map((c) =>
    `${esc(c.name)}${c.is_ai ? ' <span style="color:#666;font-size:11px">(AI)</span>' : ""} <b>${c.pct}%</b>`).join(" · ");
  out.push(`<tr style="background:${i % 2 ? "#f4f6f9" : "#fff"}">
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px;white-space:nowrap"><a href="${t.url}" style="color:#0b5cad;text-decoration:underline"><b>${esc(t.ref.replace("TICKET/", "#"))}</b></a>
<br/><span style="color:#666;font-size:11px">${esc((t.subject || "").slice(0, 40))}</span></td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px"><span style="color:#666;font-size:11px">${esc(t.stage)}</span></td>
<td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${split}</td></tr>`);
}
out.push(`</table>`);

// ---- AI-only completions ------------------------------------------------
out.push(`<div style="font-weight:700;color:#1a3c6e;font-size:16px;margin:22px 0 6px">6. Completed with no human work in the window (${aiOnly.length})</div>
<div style="font-size:12.5px;color:#444;margin:0 0 8px">These closed without a person writing on them inside the window — overwhelmingly
alert/monitoring tickets the AI handled end to end. They earn no human credit, and they are <b>excluded from the humans-only column</b>
so they cannot inflate or dilute anyone's number. Worth a look as a group: if any of these should have had a human in the loop, that is
a routing question, not a productivity one.</div>
<table style="border-collapse:collapse;width:100%;margin:0 0 8px">
<tr><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Team</th><th style="padding:7px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px">Count</th></tr>`);
const byTeam = {};
for (const t of aiOnly) byTeam[t.team || "(none)"] = (byTeam[t.team || "(none)"] || 0) + 1;
for (const [team, n] of Object.entries(byTeam).sort((a, b) => b[1] - a[1])) {
  out.push(`<tr><td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${esc(team)}</td><td style="padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px">${n}</td></tr>`);
}
out.push(`</table>
<div style="color:#666;font-size:11px">Sample: ${aiOnly.slice(0, 40).map((t) => esc(t.ref.replace("TICKET/", "#"))).join(", ")}${aiOnly.length > 40 ? " …" : ""}</div>`);

// ---- Caveats ------------------------------------------------------------
out.push(`<div style="font-weight:700;color:#1a3c6e;font-size:16px;margin:22px 0 6px">Known limits of this report</div>
<ul style="font-size:13px;margin:6px 0 10px 22px;padding:0">
<li><b>Effort units are a proxy</b> for work, built from message volume and length. They cannot see phone calls, remote sessions or
thinking time. Someone who fixed a problem in one short, brilliant note will score low here.</li>
<li><b>Time is estimated</b> from message timestamps, not measured. It is labelled "est" everywhere it appears.</li>
<li><b>Thin-sample people are tagged</b> and should not be ranked against people with a solid sample.</li>
<li><b>The AI is listed but not ranked</b>, and its share dilutes the human percentages on tickets it worked — that is deliberate, so
you can see how much of a ticket was machine-carried.</li>
<li>Only work <b>inside the window</b> counts. A ticket completed now after weeks of effort splits credit on this window's work only.</li>
</ul>
<div style="font-size:13.5px;margin:12px 0 0">Reply <b>"update it"</b> and I'll deploy the ledger model into the live report logic
(backup taken first). Tell me if you want the effort weights changed — they are one line to adjust.</div>
</div>`);

fs.writeFileSync(OUT, out.join("\n"));
console.log(`wrote ${OUT} (${out.join("\n").length} chars)`);
