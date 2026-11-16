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

// A REQUEST AIMED AT THE TECHNICIAN - the turn is being handed back even though the same
// sentence also promises "I'll …". TICKET/60427, 2026-11-16: "Say the word and I'll start the
// image build" and "Tell me when the call is done and I'll pull the negotiated codec" were both
// read as announcements. Auto-continue fired 30 s after the technician had been asked a
// question, and the push bought a wasted turn that ended in a bogus "Blocked on approval".
// A completion summary that ends with the next move left to the technician is NOT a stall: the
// run is over on purpose, and the technician is the one who starts the next one.
const ASKS_TECH = new RegExp(
  "\\b(say (?:the word|the go|so|yes|go)\\b|" +
  "(?:your|the) (?:go|ok|okay|nod|approval|sign-?off|green light|window|side)\\b|" +
  "(?:need|needs|waiting (?:for|on)) (?:your|the) (?:go|ok|okay|approval|sign-?off|green light)\\b|" +
  "give (?:me|us) (?:the |a |your )?(?:go|green light|ok|okay|nod|approval)\\b|" +
  "(?:tell|show|send|email) me\\b|paste|" +
  "want me to\\b|shall i\\b|may i\\b|" +
  "(?:make|place) (?:the |that |a |this )?[^.?!\\n]{0,40}?\\bcall\\b|" +
  "if you(?:'d| would)? (?:want|need|prefer|like)\\b|" +
  "when you(?:'re| are|'ve| have| get| finish| see| call)?\\b|while you(?:'re| are)\\b|" +
  "once you(?:'ve| have)?\\b|as soon as you\\b|on your (?:window|side|end|screen|desk|call)\\b|" +
  "test it\\b|try it\\b|\\bthen you\\b|" +
  // "**Call again.** The thing I'll look for..." (TICKET/60427, 15:38 on 2026-11-16) - a bare
  // imperative at the start of a sentence or after markdown emphasis is an instruction to the
  // technician, even with no "make/place the call" around it.
  "(?:^|[.!?:*_\\n\\u2014-]\\s{0,2})\\*{0,2}(?:call|dial|re-?dial|ring|answer|re-?try|retry|try|test|" +
  "paste|send|click|approve|confirm|reboot|restart|power[- ]cycle|sign[ -]?in|log ?in)\\b|" +
  "\\bcall (?:again|now|back)\\b|\\bi need (?:one|another|you|your)\\b|" +
  // "Approve, and I'll do 1-3 now, then you test a call" / "go for the logging and I'll run a
  // capture" - an imperative the technician must carry out, glued to the promise by "and I'll".
  "\\b(?:say|tell|give|approve|confirm|send|paste|show|go|ok|okay|yes|sign(?:[ -]?in| on)?|log ?in)\\b[^.!?\\n]{0,60}\\band i(?:'| wi)ll\\b|" +
  // "You assign BlueUC-DirectRouting in Teams admin" - an instruction that ends the turn.
  "\\byou\\b[\\s*_]{0,4}(?:assign|configure|create|set up|add|need to|will need to|should|must|check|test|verify|confirm|make|place)\\b)",
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
  if (HANDOFF.test(tail) || ASKS_TECH.test(tail)) return false;
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
