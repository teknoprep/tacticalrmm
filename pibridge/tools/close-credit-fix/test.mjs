// Test + preview-report generator for the completion-credit fix.
//
//   node test.mjs            -> run assertions, print PASS/FAIL
//   node test.mjs --report   -> also write /tmp/close_credit_report.html
//
// The fixtures are the real desk workflow in miniature: techs push their work to
// "Done" for review, a manager (Chris) then flips Done -> Closed.

import { creditOld, creditNew, tally } from "./attribution.mjs";

const BOT = [35, "BlueCloud-API"];
const SEAN = [12, "Sean Miller"];
const COSMUS = [13, "Cosmus Melly"];
const CHRIS = [1, "Chris Rawlings"]; // the reviewer/manager

// Each case: a ticket row (current state) + the stage transitions seen in the window.
const CASES = [
  {
    name: "Tech -> Done, manager -> Closed (the review workflow)",
    row: { id: 101, ref: "TICKET/101", stage: "Closed", write_uid: CHRIS, user_id: SEAN },
    transitions: [
      { ticketId: 101, at: "2026-07-28 09:00:00", author: SEAN, from: "In Progress", to: "Done" },
      { ticketId: 101, at: "2026-07-28 15:00:00", author: CHRIS, from: "Done", to: "Closed" },
    ],
    driver: null,
    expectOld: "Chris Rawlings", // BUG: reviewer gets the completion
    expectNew: "Sean Miller",    // FIX: the tech who did the work
  },
  {
    name: "Manager adds a note to an already-Closed ticket",
    row: { id: 102, ref: "TICKET/102", stage: "Closed", write_uid: CHRIS, user_id: COSMUS },
    transitions: [], // closed in a previous window; only a note happened now
    driver: null,
    expectOld: "Chris Rawlings", // BUG: note-writer credited with a close
    expectNew: null,             // FIX: no completion happened in this window
  },
  {
    name: "Tech closes their own ticket directly",
    row: { id: 103, ref: "TICKET/103", stage: "Closed", write_uid: COSMUS, user_id: COSMUS },
    transitions: [
      { ticketId: 103, at: "2026-07-28 11:00:00", author: COSMUS, from: "In Progress", to: "Closed" },
    ],
    driver: null,
    expectOld: "Cosmus Melly",
    expectNew: "Cosmus Melly", // both agree - genuine close by the owner
  },
  {
    name: "Bot completes it while a human is driving the AI chat",
    row: { id: 104, ref: "TICKET/104", stage: "Closed", write_uid: BOT, user_id: BOT },
    transitions: [
      { ticketId: 104, at: "2026-07-28 12:00:00", author: BOT, from: "New", to: "AI Closed" },
    ],
    driver: { name: "Sean Miller" },
    expectOld: "Sean Miller",
    expectNew: "Sean Miller", // both agree - credit the driver, not the bot
  },
];

function run() {
  let pass = 0, fail = 0;
  const rows = [];
  for (const c of CASES) {
    const oldC = creditOld(c.row, c.driver);
    const newC = creditNew(c.row, c.transitions, c.driver);
    const oldName = oldC ? oldC.name : null;
    const newName = newC ? newC.name : null;
    const okOld = oldName === c.expectOld;
    const okNew = newName === c.expectNew;
    (okOld && okNew) ? pass++ : fail++;
    rows.push({ ...c, oldName, newName, newWhy: newC ? newC.why : "no completion in window", okOld, okNew });
    const status = okOld && okNew ? "PASS" : "FAIL";
    console.log(`[${status}] ${c.name}`);
    console.log(`        current -> ${oldName ?? "(nobody)"}   (expected ${c.expectOld ?? "(nobody)"})`);
    console.log(`        fixed   -> ${newName ?? "(nobody)"}   (expected ${c.expectNew ?? "(nobody)"})`);
  }

  // Desk-wide tally across all four tickets.
  const allRows = CASES.map((c) => c.row);
  const allTrans = CASES.flatMap((c) => c.transitions);
  const drivers = Object.fromEntries(CASES.filter((c) => c.driver).map((c) => [c.row.ref, c.driver]));
  const oldTally = tally(allRows, allTrans, drivers, "old");
  const newTally = tally(allRows, allTrans, drivers, "new");

  console.log("\nDesk-wide completion tally (4 tickets this window):");
  console.log("  CURRENT:", JSON.stringify(oldTally));
  console.log("  FIXED  :", JSON.stringify(newTally));
  console.log(`\n${pass} passed, ${fail} failed`);

  return { rows, oldTally, newTally, pass, fail };
}

// ---- HTML preview report (emailed to chris@blueuc.com for review) ----
function reportHtml(res) {
  const esc = (s) => String(s ?? "").replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));
  const TH = "padding:6px 9px;border:1px solid #ccc;text-align:left;background:#1a3c6e;color:#fff;font-size:12px";
  const TD = "padding:7px 9px;border:1px solid #d9dee5;vertical-align:top;font-size:12.5px";
  const good = "color:#137333;font-weight:600";
  const bad = "color:#b00020;font-weight:600";

  const caseRows = res.rows.map((r) => `
    <tr>
      <td style="${TD}">${esc(r.name)}</td>
      <td style="${TD}"><span style="${r.oldName === "Chris Rawlings" && r.newName !== "Chris Rawlings" ? bad : ""}">${esc(r.oldName ?? "(nobody)")}</span></td>
      <td style="${TD}"><span style="${good}">${esc(r.newName ?? "(nobody)")}</span><br/><span style="color:#666;font-size:11px">${esc(r.newWhy)}</span></td>
      <td style="${TD}">${r.okOld && r.okNew ? '<span style="' + good + '">PASS</span>' : '<span style="' + bad + '">FAIL</span>'}</td>
    </tr>`).join("");

  const tallyRow = (obj) => Object.keys({ ...res.oldTally, ...res.newTally })
    .map((n) => `${esc(n)}: <b>${obj[n] || 0}</b>`).join(" &nbsp;·&nbsp; ") || "(nobody)";

  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.55;color:#24292f">
  <div style="font-weight:700;color:#1a3c6e;font-size:19px;margin:0 0 4px">Completion-credit fix — preview for review</div>
  <div style="color:#666;font-size:12.5px;margin:0 0 12px">DRAFT. Nothing is deployed yet. This shows how the productivity report's "completed"
  credit changes once the fix is in. Reply to approve and I'll push it to the live report logic.</div>

  <div style="font-weight:700;color:#1a3c6e;font-size:16px;margin:16px 0 6px">The problem</div>
  <div style="font-size:13.5px;margin:0 0 10px">Today the "completed" credit goes to <b>whoever last wrote the ticket while it sits in a
  terminal stage</b> — not to whoever did the work. In your review workflow (techs move a ticket to <b>Done</b>, then you move it to
  <b>Closed</b>), that means <b>every ticket you review lands on your name and the tech loses the completion</b>. Adding a note to an
  already-closed ticket also mis-fires the same way.</div>

  <div style="font-weight:700;color:#1a3c6e;font-size:16px;margin:16px 0 6px">The fix</div>
  <div style="font-size:13.5px;margin:0 0 10px">Credit a completion only on a real transition <b>from a non-terminal stage into a terminal one</b>,
  and attribute it to the <b>ticket owner (assignee)</b> — the tech — not the person who flipped the final stage. A <b>Done → Closed</b>
  review move is terminal→terminal, so it now credits <b>nobody</b>.</div>

  <table style="border-collapse:collapse;width:100%;margin:8px 0 16px">
    <tr><th style="${TH}">Scenario</th><th style="${TH}">Current credit</th><th style="${TH}">Fixed credit</th><th style="${TH}">Test</th></tr>
    ${caseRows}
  </table>

  <div style="font-weight:700;color:#1a3c6e;font-size:16px;margin:16px 0 6px">Desk-wide effect (these 4 tickets)</div>
  <div style="background:#fdecea;border:1px solid #f5c2c0;border-radius:5px;padding:9px 12px;font-size:13px;margin:0 0 6px">
    <b>CURRENT:</b> ${tallyRow(res.oldTally)}</div>
  <div style="background:#e6f4ea;border:1px solid #b7dfc2;border-radius:5px;padding:9px 12px;font-size:13px;margin:0 0 14px">
    <b>FIXED:</b> ${tallyRow(res.newTally)}</div>

  <div style="font-size:13.5px;color:#444">Automated test: <b>${res.pass} passed, ${res.fail} failed</b>.
  If this looks right, reply "update it" and I'll apply the change to the live report logic (with a backup first).</div>
</div>`;
}

const res = run();
if (process.argv.includes("--report")) {
  const fs = await import("node:fs");
  const html = reportHtml(res);
  fs.writeFileSync("/tmp/close_credit_report.html", html);
  console.log("\nwrote /tmp/close_credit_report.html (" + html.length + " chars)");
}
if (res.fail) process.exit(1);
