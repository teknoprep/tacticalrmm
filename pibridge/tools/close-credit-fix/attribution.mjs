// Completion-credit attribution: the CURRENT (buggy) rule vs the DRAFTED fix.
//
// Both are pure functions so a test can drive them with synthetic tickets and
// assert exactly who gets the "closed"/completion credit. Nothing here touches
// the live helpdesk code; this mirrors the logic in daily_activity() so we can
// prove the change before deploying it.
//
// A ticket "row" mirrors the fields daily_activity already reads:
//   { id, ref, stage, write_uid:[id,name], user_id:[id,name]|null }
// A "transition" mirrors an Odoo stage change (from mail.tracking.value):
//   { ticketId, at, author:[id,name], from, to }
//
// driver: { name } when a human was driving the AI chat for that ticket.

export const BOT_UID = 35; // the BlueCloud-API bot user

// Same terminal test the live code uses: stage NAME matches this pattern.
export const isTerminal = (stageName) =>
  /clos|cancel|done|billing/i.test(String(stageName || ""));

// ---------------------------------------------------------------------------
// CURRENT behaviour (as shipped in daily_activity, ~line 1071-1081).
// "Closed" credit fires whenever the ticket's CURRENT stage is terminal and it
// was touched in the window; credit goes to write_uid (the LAST writer) unless
// the bot wrote last and a human was driving.
// ---------------------------------------------------------------------------
export function creditOld(row, driver) {
  const closedIn = isTerminal(row.stage);
  if (!closedIn || !row.write_uid) return null;
  const closerIsBot = row.write_uid[0] === BOT_UID;
  if (closerIsBot && driver) return { name: driver.name, why: "bot wrote last, human driving" };
  return { name: row.write_uid[1], why: "last writer of a currently-terminal ticket" };
}

// ---------------------------------------------------------------------------
// DRAFTED FIX.
// A completion is a genuine transition INTO a terminal stage FROM a non-terminal
// stage, inside the window. Terminal->terminal moves (Done -> Closed) and plain
// edits to an already-terminal ticket produce no such transition, so they credit
// nobody. The credit goes to the person who OWNED the work, not whoever flipped
// the final stage:
//   1. bot performed it while a human was driving -> the driver
//   2. otherwise the ticket's assignee, when that is a real tech (not the bot)
//   3. otherwise the person who performed the qualifying transition
// Only the FIRST qualifying transition in the window counts (one completion).
// ---------------------------------------------------------------------------
export function creditNew(row, transitions, driver) {
  const completions = (transitions || [])
    .filter((t) => t.ticketId === row.id && isTerminal(t.to) && !isTerminal(t.from))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (!completions.length) return null; // no real close happened in this window

  const ev = completions[0];
  const performerIsBot = ev.author && ev.author[0] === BOT_UID;
  if (performerIsBot && driver)
    return { name: driver.name, why: "bot completed it, human driving", at: ev.at };

  const assignee = row.user_id;
  if (assignee && assignee[0] !== BOT_UID)
    return { name: assignee[1], why: "ticket owner (assignee) at completion", at: ev.at };

  if (ev.author) return { name: ev.author[1], why: "performed the completing transition", at: ev.at };
  return null;
}

// Roll a set of tickets into a per-person completion tally, for either rule.
export function tally(rows, transitions, drivers, rule) {
  const counts = {};
  for (const row of rows) {
    const driver = drivers[row.ref];
    const c = rule === "old" ? creditOld(row, driver) : creditNew(row, transitions, driver);
    if (c) counts[c.name] = (counts[c.name] || 0) + 1;
  }
  return counts;
}
