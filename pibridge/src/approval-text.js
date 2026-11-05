/**
 * WHAT A HUMAN IS SHOWN WHEN SOMETHING WANTS APPROVING.
 *
 * Owner, 2026-11-05, staring at an approval for a long device script:
 *
 *   "we need to approve this but it's so long i need a crazy big monitor to get it approved...
 *    we need to reduce what the command is when it's this long and just give a summary of what
 *    it's asking aproval for"
 *
 * An approval ask has one job: be decided at a glance. It is rendered as a single band at the
 * bottom of the chat (PiChat.vue) and, through remote-room.js, on a phone. A two-hundred-line
 * PowerShell script pasted into that band turns it into a wall of text that pushes the Approve
 * button off the screen - the opposite of what an approval prompt is for. So the SHOWN text is
 * the asking line, then as much of the body as a person can take in at a glance, then an honest
 * size - never a guess about what the command does.
 *
 * Two things this deliberately does NOT do:
 *
 *   * It never paraphrases the command. A regex that decides "this one deletes mailboxes" is a
 *     summary that can be WRONG, and a wrong summary is worse than a long one: the person is
 *     approving the words on the screen, so the words on the screen have to be the command's
 *     own. What is trimmed is trimmed, and it says so.
 *
 *   * It never touches what the JUDGE sees. The safety reviewer still gets the whole text: the
 *     compaction happens at the point where the browser/phone frame is built, after the review
 *     (see requestApproval in server.js). Judging a summary would let the model hide a step
 *     behind it.
 *
 * Nothing is lost either: the full command is in the tool call in the transcript, right above
 * the band, and the note says where to look.
 */

// A band this big is still readable at a glance on a laptop, and covers the short asks (a single
// run of a diagnostic command, a three-line reply draft) without touching them at all.
export const ASK_MAX_CHARS = 600;
export const ASK_MAX_LINES = 6;

const oneLine = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The ask, cut down to something a person can decide on - or unchanged when it already is.
 *
 * Shape of an ask (from tools.js): a headline line, a blank line, then the body - the command,
 * the reply draft, the note. The headline is kept verbatim (it is the part that says what, on
 * which machine, and it is always short); the body is what gets trimmed.
 */
export function compactAsk(text, { maxChars = ASK_MAX_CHARS, maxLines = ASK_MAX_LINES } = {}) {
  const full = String(text ?? "").trim();
  const lines = full.split("\n");
  if (full.length <= maxChars && lines.length <= maxLines) return full;

  // The asking line: everything above the first blank line. A single-line ask that is merely
  // long (a one-liner command with a hundred flags) has no blank line, so the whole thing is
  // body and there is no headline to protect.
  const blank = lines.findIndex((l) => !l.trim());
  const headLines = blank >= 0 ? blank : 0;
  const head = headLines ? lines.slice(0, headLines).join("\n") : "";
  const bodyLines = lines.slice(headLines).filter((l, i, all) => i || l.trim()); // drop the separator only
  const body = bodyLines.join("\n").trim();

  // Spend what is left of the budget on the body, a WHOLE line at a time: one full
  // `if (...) {` reads better than half of one, and half a statement can look like a
  // different statement. The one exception is a first line that alone blows the budget (a
  // one-liner with a hundred flags) - that one is cut inside the line, because showing
  // nothing at all tells the approver less than showing its beginning.
  const budget = Math.max(maxChars - head.length - 2, 120);
  const kept = [];
  let used = 0;
  for (const line of bodyLines) {
    if (kept.length >= maxLines) break;
    const cost = line.length + (kept.length ? 1 : 0);
    if (used + cost <= budget) {
      kept.push(line);
      used += cost;
      continue;
    }
    const room = budget - used - (kept.length ? 1 : 0);
    if (room > 40) kept.push(line.slice(0, room).trimEnd());
    break;
  }
  const preview = kept.join("\n");
  const hiddenLines = Math.max(bodyLines.length - kept.length, 0);
  const hiddenChars = Math.max(body.length - preview.length, 0);

  const left = [];
  if (hiddenLines) left.push(`${oneLine(hiddenLines, "more line")}`);
  if (hiddenChars) left.push(`${hiddenChars} more character${hiddenChars === 1 ? "" : "s"}`);
  const note = left.length
    ? `… [${left.join(", ")} not shown - the whole thing is in the tool call in the transcript above]`
    : "";

  return [head, preview, note].filter((p) => p !== "").join("\n\n");
}

/** Kept for callers that only want to know whether compactAsk would change anything. */
export function isAskTooLong(text, opts = {}) {
  return compactAsk(text, opts) !== String(text ?? "").trim();
}
