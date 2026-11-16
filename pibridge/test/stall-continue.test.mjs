// Announce-and-stop recovery (stall-continue.js).
//
// The heuristic exists for the model that ends a turn saying "Now creating the TOTP entry...
// Stand by for the result." with no tool call. It must ONLY fire on a promise with nothing
// asked of the technician: a message that hands the turn back ("say the word", "tell me when
// the call is done") is a handoff, and auto-continuing it burns a turn, re-opens work the
// technician did not ask for, and ends in a bogus "blocked".
//
// Fixtures are verbatim tails from TICKET/60427 (decision token dWdhsOIpstbm7oUw94lyckl7XstRlWSa)
// on 2026-11-16, where two completion summaries were auto-continued 30 s after the technician
// had been asked a question.
import test from "node:test";
import assert from "node:assert/strict";
import { endedOnPromise, AUTO_CONTINUE_TEXT } from "../src/stall-continue.js";

/** Minimal session shape: the last message is the one being judged. */
const at = (text, { role = "assistant", stopReason = "stop", toolCall = false } = {}) => ({
  messages: [
    { role: "user", content: [{ type: "text", text: "the technician's request" }] },
    {
      role,
      stopReason,
      content: [...(toolCall ? [{ type: "toolCall", name: "run_device_command" }] : []), { type: "text", text }],
    },
  ],
});

// ---- real tails that must NOT be auto-continued: each one asks the technician for something ----
const HANDOFFS = [
  // 15:04:06 — the answer to "what would it take to update it?" and an offer to start
  "**My recommendation on order:** do the rtpengine image first — it's hours, it's isolated, it fixes the Opus/transfer problem, and it removes the only EOL component. The host upgrade is a separate, scheduled project with a real maintenance window, targeting 24.04, and it's worth doing before May 2027 rather than now.\n\nSay the word and I'll start the image build; the host upgrade I'd only ever do on your window, on a clone.",
  // 15:11:42 — the change is applied; the technician must place the test call
  "One thing to expect, so it doesn't look like a failure: the app's **Teams ring leg** still carries a hard pin, `absolute_codec_string=PCMU,PCMA` (line 124 of `teams_route.lua`), so ext 211's *Teams* leg will stay on PCMU. The desk leg and the inbound leg from Chris can now be Opus. If you want Opus on the Teams legs too, that pin has to gain `OPUS` — say so and I'll do it, but I'm not touching the app while you're testing.\n\nTell me when the call is done and I'll pull the negotiated codec for each leg (`Set Codec` lines / channel dump) so we can see exactly what was chosen.",
  // 15:38:10 — the change is applied, the technician must place the call (fired again live)
  "Legacy flags gone, config check OK, opensips healthy at 10:38:07. The offers are now just `trust-address replace-origin ICE=…` with no `codec-strip`/`replace-session-connection` for 26.x to choke on.\n\n**Call again.** The thing I'll look for in rtpengine's log: the PBX-side media line should stop saying `using unknown codec` and instead show `PCMU/8000` **with packets in both directions** — that's the proof audio is flowing.",
  // 15:38:16 — the same request the second time
  "No call has come through since the change (rtpengine's log still only holds the previous call `59767749…`, opened 10:37; nothing new since the flags were cleared at 10:38:07).\n\n**Call now** — I need one more call to read the PBX-side media line.",
  // 15:11:58 — declares itself blocked on the technician
  "Blocked on you placing the call — nothing has come through PBX3 since the codec change (no CDRs in the last 12 minutes, 0 channels active, latest `Set Codec` lines are 09:54–09:55, before the change at ~10:11).\n\nMake the chris@blueuc.com → 211 call and I'll immediately pull the negotiated codec per leg from the FreeSWITCH log (which *is* writing on this node) and confirm whether Opus actually won.",
  // 15:04:30 — approval wanted before touching the PBX
  "Blocked on approval: I need your go to write `Dockerfile.rtpengine` and run `docker build` on PBX3 — no container started, nothing in the call path.",
  // plain offers and conditional offers
  "That's the whole change. Want me to also drop the hard pin from `teams_route.lua` and I'll re-test?",
  "I can rebuild the image with the newer base and push it if you'd like — give me the green light and I'll run it.",
  "Everything is staged. Say go and I'll start the build.",
  "Paste the error text here and I'll decode it.",
  "Send me the screenshot and I'll read the dial plan from it.",
  "Give me your go and I'll restart the container.",
  "I'll do that once you've approved the plan.",
  "I'll run the upgrade during your window; just confirm the date.",
];

test("a message that asks the technician for something is a handoff, not a stall", () => {
  for (const text of HANDOFFS) {
    assert.equal(endedOnPromise(at(text)), false, `must not auto-continue: ${JSON.stringify(text.slice(-120))}`);
  }
});

// ---- the case the mechanism was built for: a promise, no tool call, nothing asked ----
const STALLS = [
  "Now creating the TOTP entry... Stand by for the result.",
  "I'll now run the diagnostic on the DC01 server and report back.",
  "Let me check the firewall rules and report back.",
  "Next I will open the UniFi controller and set the reservation.",
];

test("a promise with no tool call and nothing asked is still recovered", () => {
  for (const text of STALLS) {
    assert.equal(endedOnPromise(at(text)), true, `must auto-continue: ${JSON.stringify(text)}`);
  }
});

test("a real tool call, a non-stop end, or a question never triggers it", () => {
  assert.equal(endedOnPromise(at("Stand by for the result.", { toolCall: true })), false);
  assert.equal(endedOnPromise(at("Stand by for the result.", { stopReason: "aborted" })), false);
  assert.equal(endedOnPromise(at("Stand by for the result - which host?")), false);
  assert.equal(endedOnPromise({ messages: [] }), false);
});

test("the injected follow-up is still the one the bridge has always sent", () => {
  assert.match(AUTO_CONTINUE_TEXT, /^\[auto-continue from the bridge, not the technician\]/);
});
