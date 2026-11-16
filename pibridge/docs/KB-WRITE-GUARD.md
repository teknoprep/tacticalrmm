# KB write guard — spec (implemented 2026-11-12)

Why: decision session `decision:TICKET/63975` (2026-11-11 18:42 → 2026-11-12 20:32) wrote
5 KB blocks in 13 minutes — restating, reversing, a false claim plus its own correction,
a one-client guess promoted to a "STANDING RULE … FOR ALL CLIENTS", all stamped
`[2026-11-16]` by the model instead of the clock, and the automatic recall then re-injected
its own wrong block. The KB is shared by every client, so one bad standing rule is not
contained by one project.

**This lives in the bridge. Nothing in the FusionPBX app tree changes: no Lua, no PHP, no
`deploy.sh`, no PBX node copies.** `helpdesk.js` (the ERP-held integration) is not modified
either — all policy runs in `pi-trmm-bridge` before the operation is called.

## Storage format (append-only, inside the existing article)
`upsert_ai_kb_article` escapes HTML, so metadata is plain text inside the block:

```
[2026-11-12][verified][ref 7f3a1c02][topic teams-acd][ticket TICKET/63975] the body text
```

- `[<YYYY-MM-DD>]` server clock, never the model's text
- `[verified]` | `[unverified]` | `[retracted]`
- `[ref xxxxxxxx]` stable hash of (ticket, topic, state, normalised text)
- `[topic slug]` the subject this block is about (`teams-acd`, `dhcp-scope`, …)
- `[ticket TICKET/63975]`

Block kinds, carried as a 5th marker where relevant:

| marker | meaning |
|---|---|
| (none) | a normal entry |
| `[amend ref A]` | this block replaces A's text (the newest block for a ref wins) |
| `[retract ref A]` | A is wrong; excluded from recall, history kept |
| `[correction ref A]` | A had a wrong claim; one line saying what was wrong |

Append-only is deliberate: C and H both require the wrong claim to remain in history.

**Updated 2026-11-16 — append-only for CAPTURE, and one exception for CLEANUP (section I).**
A technician can now ask for text to be deleted or corrected in place. Append-only was right
for recording what happened and wrong for housekeeping: a superseded entry stayed visible
forever, so on 2026-11-16 a Teams dial plan standard could only be retired by appending a
notice that named the old entries by hand, and a typo in that notice had to be corrected by
appending a second entry. Section I is the only path that rewrites an existing article, and
it exists only for a cleanup the technician asked for.

## Requirements

**A. Verification gate.** A write needs `evidence: {kind, quote}` with a verbatim fragment
(≥ 20 chars) of a tool result observed in the same turn (or, for live call work, a CDR/log
line from a call placed *after* the change). The guard searches the turn's recorded tool
results for the quote. `kind` ∈ `readback | result_json | log | cdr` ⇒ eligible for
`verified`. `plan | hypothesis | instruction | should_work` ⇒ refused, with a chat line
naming what is unproven. A real change with no verification is written as
**"applied, UNVERIFIED"**, never as a conclusion.

**B. Idempotent.** Same hash, or same (topic,state) inside 24 h ⇒ no write at all:
`no-op: already recorded`. No near-duplicates.

**C. Corrections.** Wrong recorded statement ⇒ `[correction ref X]` block, one line
(`CORRECTION to X: <what was wrong>`), plus `[retract ref X]`. Never two contradicting
entries with no pointer. Never "supersedes everything above".

**D. Clock.** `now()` is injected (server). Reject an entry whose leading `[YYYY-MM-DD]`
differs from the server date by more than 1 day, with a clock error naming both dates.

**E. Scope.** Default is the client article. Global requires the technician's instruction in
this session *and the entry must quote it*. Demonstrated on one client only ⇒ client entry
plus `candidate for a global rule — NOT yet a standard`.

**F. Recall.** `recallFilter(text)`: drop retracted, drop superseded (amend), keep verified,
prefix unverified with `(UNVERIFIED — hypothesis, do not treat as fact)`. Automatic recall
(`kb-recall.js`) uses it by default. Retracted never appears.

**G. Budget + visibility.** 1 write per ticket per turn, 3 per ticket per hour, persisted at
`<sessionsRoot>/kb-write-budget.json`. Every write/refusal prints one chat line:
`KB write: <scope> · <article> · <action> · basis: <kind>`. Exhaustion says so — never silent.

**H. Retraction tool.** `kb_retract({ ticket, ref, reason })` — appends `[retract ref …]`
with reason + who. Excluded from recall, history preserved, available in the ticket chat.

## I. Cleanup — deleting text an article no longer needs (2026-11-16)

Append-only was a statement about CAPTURE, and it was applied to CLEANUP by accident. The
result was an article that could only grow: eleven Teams dial plan entries in KB 106 where
one standard was true, all still visible to the next technician, retired by a hand-written
"RETIREMENT NOTICE" that named them because nothing could remove them.

**The verb.** `helpdesk_call edit_ai_kb_article` (capability class `knowledge_delete`),
with three target kinds:

| args | effect |
|---|---|
| `entries: [quote]` | delete the whole ENTRY that contains the quote (all its blocks) |
| `remove: [quote]` | delete just that statement, inside the entry that holds it |
| `replace: [{find, with}]` | same, then the replacement goes in its place — the typo fix |
| `dry_run: true` | report what would go and write nothing |

**Who may.** A delete needs a PERSON: the technician's own message in this chat must ask
for it (delete / remove / clean up / tidy / retire / …), and their clause is quoted into the
log line. The model's opinion that text looks stale is not authority — that is spec E's rule
for global entries, applied to deletion. The class is on `decision_chat` and `device_chat`
only, and unlike most classes it is enforced even in warn mode: a surface that should not
delete KB text must not delete it "and log it".

**What makes it safe** (all of it in `helpdesk.js`, because only the article can answer it):

- Only our own entries are editable: a `<p>` whose text starts with a `[YYYY-MM-DD]` stamp,
  plus the un-stamped `<p>`s that abut and continue it. The header and the
  "Auto-maintained by Pi.dev AI" banner can never be a target.
- Every quote must match **exactly once**, on entity- and whitespace-normalised text
  (`-&gt;` matches `->`, a `<br/>` is a space). No match and two matches are both refusals;
  nothing is ever guessed. Deletes need 25+ characters, replacements 12+.
- The previous body is saved as an `ir.attachment` ON the article (`kb-cleanup-backup-…html`)
  before the write. Restore = copy that HTML back into the article body.
- The written article is read back and verified (quotes gone, replacements present, length
  as expected). Any mismatch rolls the article back automatically.
- One call may not remove more than half the article's characters, and may not leave it under
  400: a runaway cleanup has to be split into reviewable calls.

**What is NOT applied.** The clock, the verification gate, dedupe and the 1-per-turn write
budget are about recording what happened and mean nothing for deleting superseded text. A
separate cap applies instead: 6 cleanups per hour per article, kept in the same budget file
under an `edit:` key so it never eats the write budget.

**Visibility.** Every attempt prints one line:
`KB edit: <scope> · <article> · removed/replaced 5 entries (12345 → 118000 chars), backup attachment #1234`
and the log records the technician's own clause that authorised it. A refusal prints
`KB edit: … refused: <reason>` and changes nothing.

**Not to be confused with a correction.** `[correction ref X]` (section C) is still the right
way to record that a live entry was wrong, because the history of the mistake matters. Use a
cleanup for text that is simply obsolete (a retired standard, a superseded proposal, a typo),
and expect the technician to say which is which.

## Deviations, stated

- "update in place" (B) is an `[amend ref]` block, because the op only appends. Recall
  resolves to the newest block per ref. History is kept on purpose (C, H).
- `server.js` mining (bulk company note from closed tickets) writes through the same guard
  with `state: "unverified"` — it is offline evidence, not an in-turn observation.

## Acceptance tests (`test/kb-write.test.mjs`)

1. Six commands, no verified conclusion ⇒ zero writes, one chat line naming what is unproven.
2. Same content twice in 5 min ⇒ one entry; second reports `no-op`.
3. `[2026-11-16]` entry on a `2026-11-12` host ⇒ rejected with a clock error.
4. Global standing rule with no quoted technician instruction ⇒ refused, reason in chat.
5. Verified entry later contradicted ⇒ exactly one correction block, wrong claim flagged,
   recall returns only the corrected text.
6. Retracted entry never appears in a later recall injection.
7. Regression: a normal verified fix still writes exactly one recall-eligible entry.
