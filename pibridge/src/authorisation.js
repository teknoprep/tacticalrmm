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
  return scanNewestFirst(techTurns, NOTEBOOK_TARGET, NOTEBOOK_NEGATED,
    (line) => ACTION_THEN_TARGET.test(line) || TARGET_THEN_ACTION.test(line));
}

// READING the PRIVILEGED rows - class `secret`, `opts.privileged`.
//
// Reported 2026-08-25: "even with auto-credential on it still asks for approval". It did,
// and the gate was right to: every prompt was a privileged-row request, which no toggle
// covers. What made it feel broken is that the model escalated to privileged rows on its
// OWN initiative, seconds after a normal read, on practically every lookup - so the
// technician saw a prompt every time and concluded the switch did nothing.
//
// The escalation itself is the thing to control, and the deployment already has a rule for
// this shape of decision: `close` and `email` accept the technician's own instruction as
// the authorisation, because a prompt asking them to confirm what they just typed protects
// nobody. Reading a row the technician asked for is not a graver act than closing the
// customer's ticket, so it follows the same rule.
//
// What it does NOT do is let the model decide. Absent an instruction, a privileged read
// still prompts every single time, exactly as before.
const PRIV_ROW = String.raw`(?:privileged|admin(?:istrator)?|domain admin|root|elevated|global admin|superuser|sa)`;
const CRED_WORD = String.raw`(?:credential|cred|password|passwd|pwd|login|logon|account|user(?:name)?|row|entry|secret)`;
// Both orders: "get the admin password" and "the password for the admin account".
const PRIV_THEN_CRED = new RegExp(String.raw`\b${PRIV_ROW}\b[^.!?]{0,40}\b${CRED_WORD}s?\b`, "i");
const CRED_THEN_PRIV = new RegExp(String.raw`\b${CRED_WORD}s?\b[^.!?]{0,40}\b${PRIV_ROW}\b`, "i");
const PRIV_ANY = new RegExp(String.raw`\b${PRIV_ROW}\b`, "i");
// "don't use the admin account", "not the domain admin one" - a refusal ends the search.
const PRIV_NEGATED = new RegExp(
  String.raw`\b(do ?n'?t|dont|do not|never|no need|not the|avoid|without|hold off|not yet|wait)\b[^.!?]{0,60}\b${PRIV_ROW}\b`,
  "i",
);

/**
 * Did the technician ask, in their own words, for the PRIVILEGED credential rows?
 *
 * @param techTurns  the technician's own turns, oldest first: [{ at, text }]
 * @returns { at, text } of the authorising sentence, or null
 */
export function privilegedCredentialAuthorisation(techTurns) {
  return scanNewestFirst(techTurns, PRIV_ANY, PRIV_NEGATED,
    (line) => PRIV_THEN_CRED.test(line) || CRED_THEN_PRIV.test(line));
}

// Newest turn first, so a technician who changes their mind is obeyed rather than
// out-voted by something they said earlier; and a refusal ENDS the search rather than
// skipping the line, so "don't use the admin account" cannot be overridden by an older
// "get the admin password".
function scanNewestFirst(techTurns, mentions, negated, matches) {
  if (!Array.isArray(techTurns)) return null;
  for (let i = techTurns.length - 1; i >= 0; i--) {
    const line = String(techTurns[i]?.text || "");
    if (!mentions.test(line)) continue;
    if (negated.test(line)) return null;
    if (matches(line)) return { at: techTurns[i].at, text: line.slice(0, 300) };
  }
  return null;
}
