// Did the TECHNICIAN authorise this, in their own words?
//
// Several capability gates can be satisfied two ways: the technician instructed the action
// (so a human already decided, and a confirmation prompt would protect nothing), or the
// model proposed it and a human clicked Approve. This module holds the first kind of test.
//
// THE RULE THAT MAKES THESE MEANINGFUL: they read the technician's verbatim chat turns and
// nothing else. They never consult the model's account of what it was asked. A model that
// could authorise itself by asserting "you told me to" is not gated at all - it has been
// handed the decision that the gate exists to keep away from it.
//
// A false negative costs one approval click. A false positive silently removes a human
// from a decision about a customer's systems. So these stay narrow on purpose, and every
// one of them treats a refusal as operative rather than merely unmatched.
//
// (`closeAuthorisation`, `replyAuthorisation` and `globalKBAuthorisation` still live in
// server.js, where they close over one session's state. They belong here too; they were
// left alone rather than refactored on the same day as an unrelated feature.)

// RECORDING a credential in the IT Notebook - class `secret_write`.
//
// Owner's ruling 2026-08-18: the AI should be able to save a row, but "only when requested
// to do so - they can ask if they should do it and we will let them know, or if I tell it
// then it can."
const TARGET = String.raw`(?:it[\s-]?notebook|notebook|credential store|password (?:manager|vault|store)|secure notes?)`;
const ACTION = String.raw`(?:save|store|record|add|create|write|put|update|upsert|document|enter|paste|log)`;

// The action has to be aimed AT the notebook. Matching an action word and the word
// "notebook" anywhere in the same sentence is too loose: "add a note about the notebook"
// would then silently authorise a credential write. So only short, closed-class filler is
// allowed between the verb and the target - "note", "about" and friends are not in it.
const NOTEBOOK_TARGET = new RegExp(TARGET, "i");
const ACTION_THEN_TARGET = new RegExp(
  String.raw`\b${ACTION}\b` +
  String.raw`(?:\s+(?:it|this|that|these|those|them|the|a|an|new|another|row|rows|entry|line|record|credentials?|creds|password|passwords|login|logins|details?|info(?:rmation)?))*` +
  String.raw`\s*(?:to|in|into|on|under|inside)?\s*(?:the\s+|our\s+|their\s+|customer'?s?\s+)*${TARGET}\b`,
  "i",
);
// The other natural order: "notebook - add a row for grafana", "IT Notebook: save this".
const TARGET_THEN_ACTION = new RegExp(String.raw`\b${TARGET}\b[^.!?]{0,30}\b${ACTION}\b`, "i");
// Stems, not whole words: "don't SAVE it" and "just SHOW me" have to be caught by the same
// rule, and `sav` must match `save`/`saving`/`saved`.
const NOTEBOOK_NEGATED =
  /\b(do ?n'?t|dont|do not|never|no need|hold off|not yet|don'?t yet|wait|just show|only show|show me)\b[^.!?]{0,100}\b(sav|stor|record|add|creat|writ|updat|upsert|document|enter|put)/i;

/**
 * @param techTurns  the technician's own turns, oldest first: [{ at, text }]
 * @returns { at, text } of the authorising sentence, or null
 */
export function notebookWriteAuthorisation(techTurns) {
  if (!Array.isArray(techTurns)) return null;
  // Newest first: the most recent instruction is the operative one, so a technician who
  // changes their mind is obeyed rather than out-voted by something they said earlier.
  for (let i = techTurns.length - 1; i >= 0; i--) {
    const line = String(techTurns[i]?.text || "");
    if (!NOTEBOOK_TARGET.test(line)) continue;
    // A refusal ENDS the search rather than skipping the line: "don't save it to the
    // notebook, just show me" must not be overridden by an older "save it".
    if (NOTEBOOK_NEGATED.test(line)) return null;
    if (ACTION_THEN_TARGET.test(line) || TARGET_THEN_ACTION.test(line)) {
      return { at: techTurns[i].at, text: line.slice(0, 300) };
    }
  }
  return null;
}
