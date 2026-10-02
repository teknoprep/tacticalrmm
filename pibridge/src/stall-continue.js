// Announce-and-stop recovery.
//
// Cheap orchestrators (grok-4.3) regularly end a turn with "Now creating the TOTP entry...
// Stand by for the result." and NO tool call. The run is over; nothing is running; the
// technician is left waiting for a result that will never come until they type "go".
// TICKET/61824, 2026-09-26, after a successful sign-in + MFA.
//
// When the final message PROMISES an action and does not hand the turn back to the person
// (no question, no "reply when", no approval wait), the bridge sends one short follow-up
// telling the model to do it. Capped per technician message so it can never loop.

const PROMISE = new RegExp(
  "\\b(stand(?:ing)? by|now (?:creating|doing|running|setting|adding|checking|opening|navigating|" +
  "proceeding|starting|going|moving|filling|clicking|generating|saving|storing|registering|" +
  "enrolling|configuring|reading|looking|signing|working|continuing)|" +
  "i(?:'| wi)ll (?:now |then |next |go ahead and )?(?:run|create|set|add|check|proceed|continue|" +
  "do|open|navigate|start|go|move|fill|click|generate|save|store|register|configure|enroll|look|" +
  "read|sign|try|retry|work|finish|complete|verify)|" +
  "proceeding (?:to|with|now)|next[,:]? i(?:'| wi)ll|let me (?:now )?(?:run|create|set|add|check|" +
  "open|navigate|start|do|fill|click|finish))\\b",
  "i",
);

// Anything that legitimately gives the turn back to the person.
const HANDOFF = new RegExp(
  "\\?(?=[\\s*_)]|$)|\\b(please (?:provide|confirm|approve|tell|let me know|answer|reply|choose|" +
  "pick|give|send|check|call)|let me know|\\breply\\b(?!_)|respond|when you(?:'re| are) (?:ready|done)|" +
  "once you(?:'ve| have)|approve (?:it|the|this)|waiting (?:for|on) (?:you|your|the technician)|" +
  "i(?:'m| am) paused|paused here|your call|which (?:one|group|option)|do you want|would you like|" +
  "should i|confirm (?:which|that|the)|blocked|cannot|can't|unable|failed|refused|denied|" +
  "need(?:s)? (?:you|your|a human|the technician)|over to you)\\b",
  "i",
);

export const AUTO_CONTINUE_TEXT =
  "[auto-continue from the bridge, not the technician] Your last message said what you would do " +
  "next, but the turn ended without doing it. Do it now with your tools - do not announce it again. " +
  "If something genuinely blocks you (information only the technician has, a refusal, an approval), " +
  "say exactly what in one line and stop.";

function finalText(message) {
  return (message?.content || [])
    .filter((c) => c?.type === "text")
    .map((c) => c.text || "")
    .join("\n")
    .trim();
}

/** True when the model's last turn ended on a promise instead of an action. */
export function endedOnPromise(session) {
  const msgs = session?.messages || [];
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== "assistant") return false;
  if (last.stopReason !== "stop") return false; // aborted, errored, length, toolUse
  if ((last.content || []).some((c) => c?.type === "toolCall")) return false;
  const text = finalText(last);
  if (!text || text.length > 2500) return false;
  // Judge the tail: the promise is what the turn ends on.
  const tail = text.slice(-600);
  if (HANDOFF.test(tail)) return false;
  return PROMISE.test(tail);
}

/**
 * Run after a technician's prompt has settled. `prompt` sends a follow-up into the same
 * session and resolves when that turn settles.
 */
export async function continueIfStalled({ session, prompt, log, key, sessionId, notify, max = 2, stopped = () => false }) {
  let n = 0;
  // Never after Stop: the technician ended this turn on purpose.
  while (n < max && !stopped() && endedOnPromise(session)) {
    n++;
    log?.("auto_continue", key, sessionId?.() || "", `announce-and-stop #${n}`);
    try { notify?.("The AI said what it would do next but stopped - telling it to carry on."); } catch { /* socket gone */ }
    await prompt(AUTO_CONTINUE_TEXT);
  }
  return n;
}
