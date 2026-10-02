"""One-off: fold the three near-duplicate "is this email dodgy?" subjects into one.

Owner, 2026-09-25: "we already have SPAM / Phishing... why not just merge the 3 automation
rules that are similar into one all encompassing rule?"

  #1 Spam / phishing verification                              (4 matched, 3 worked)
  #5 Unexpected account-verification emails (is this the MSP?) (0/0)
  #6 Phishing or BEC impersonation report                      (0/0)

All three answer the same question - "a customer is asking us to judge an email they were
sent". #1 is the one with history and the careful rules, so it absorbs the other two and is
renamed; #5 and #6 are RETIRED rather than deleted so the audit trail and the
already-exists guard both survive.

Mechanics that matter: keys in a match spec are ANDed, so #5's and #6's triggers must go in
as extra ALTERNATIVES inside #1's body_regex - adding body_any would have required a phrase
from that list on top of a body_regex hit, silently narrowing the subject to almost nothing.

Run: python manage.py shell < core/scripts/merge_email_subjects.py
"""

from core.models import AITicketAutomationSubject

KEEP = 1
RETIRE = [5, 6]

NEW_NAME = "Suspicious email: spam, phishing, BEC or unexpected verification"

NEW_DESCRIPTION = (
    "A customer forwards an email (or describes one) and asks us to judge it: is it spam, a "
    "scam, phishing, a colleague being impersonated, or a verification/security message they "
    "did not expect - and is anyone (us included) actually doing something on their account. "
    "The AI reads what they sent, decides from the evidence IN the ticket, and tells the "
    "customer plainly what it is and what to do. No device is touched; there are no device "
    "tools in this mode. A reply is sent only on a confident verdict with two or more "
    "concrete red flags (or two or more reasons it is genuine). Anything unsure - and "
    "anything where the customer says they already clicked, replied, paid or gave a password "
    "- becomes an internal note and needs-input for a technician."
)

# From #6 (BEC / impersonation) and #5 (unexpected verification / "are you working on this?").
ADD_BODY_REGEX = [
    r"\b(impersonat\w*|spoof\w*|pretend\w* to be|posing as|lookalike|look-alike)\b",
    r"business[- ]?email[- ]?compromise|\bbec\b",
    r"(display name|sender name).{0,40}(is not|isn'?t|does not match|doesn'?t match|wrong|different)",
    r"(someone|somebody|a scammer|an attacker) (is )?(pretending|claiming) to be",
    r"(email|e-mail|message|text) (claiming|pretending|purporting) to be from",
    r"\b(verification|verify|authentication|security|one[- ]time|otp|2fa|mfa) (code|email|e-mail|message|request|notification)s?\b",
    r"(did ?n'?t|did not|never) (request|ask for|sign up for|create|set up) (this|that|an?) (account|code|verification|login)",
    r"(are|is) (you|your team|someone|somebody|anyone|the msp|blue ?cloud) (doing|working on|logging in|signing in|accessing|touching)",
    r"(getting|received|receiving|keep getting) (unexpected|unusual|strange|odd|random|a bunch of) .{0,30}(email|e-mail|message|code|notification)",
    r"unexpected (sign[- ]?in|login|log[- ]?in|account|verification|security) (alert|notice|notification|email|e-mail|message)",
]

# A customer who has ALREADY acted on the mail is an incident, not a question. Straight to a
# human - the AI must not send a reassuring "just delete it" in that case.
ADD_BODY_NONE = [
    "i clicked",
    "i already replied",
    "already responded",
    "entered my password",
    "gave my password",
    "sent money",
    "gift card",
    "wire transfer",
    "wired the",
]

NEW_INSTRUCTIONS = """You are answering a customer who asked us to judge an email they received. It is one of four flavours, and you decide which: (a) is this spam/a scam/phishing? (b) is someone impersonating a colleague or executive - a BEC attempt? (c) I got an account-verification / security-code / sign-in-alert I did not expect, is it real? (d) is one of YOU (the MSP) doing something on my account or device?
DECIDE from the evidence in the ticket only: sender address vs display name, sender domain vs the brand or colleague claimed, misspellings of a brand, urgency/threats (account closure, unable to send after today), requests to click a link, enter a password, buy gift cards, move money, send a phone number or reply off-channel, generic greetings, reply-to mismatches, the customer's own external-mail caution banner, whether the customer says they were expecting it, and whether it is self-addressed/spoofed.
Report kind='phishing' (malicious, includes BEC/impersonation), 'spam' (unwanted but not malicious), or 'legitimate'. Be 'confident' ONLY when you can list two or more concrete, checkable reasons. If the mail could plausibly be genuine (an invoice from a known vendor, a password reset the user may have requested), report 'unsure' and say what a technician should verify.
FOR UNEXPECTED VERIFICATION / SECURITY MESSAGES: check the helpdesk record before you answer the question "is this you?" - if no technician is working that account or device, say so plainly: we are not doing anything on your account, those messages come from the vendor, not from us. Unexpected verification codes the user did not request mean someone else is trying to sign in: tell them not to approve or forward the code, and that a technician should check the account if they keep arriving.
FOR IMPERSONATION / BEC: say clearly that the display name is spoofed and the real sender address is not their colleague. Do not reply, do not send a phone number or any other information, do not act on any request for money, gift cards or bank details - and verify with that colleague by a known phone number, never by replying.
NEVER auto-reply if the customer says they already clicked, replied, entered a password, sent money or bought gift cards. That is an incident: internal note, needs-input, escalate to a human immediately.
CUSTOMER REPLY (only used when confident): plain language, warm, no jargon. Say clearly what it is; give 2-4 short reasons; for phishing/spam tell them: do not click any link or open any attachment, in Outlook select the message -> Report -> Phishing (or Junk), then delete it, and ask them to reply straight away if they already clicked a link or entered a password so we can secure the account. For legitimate mail say why it checks out and that they can proceed, and to reply if anything looks off. Thank them for checking - it is exactly the right thing to do. Sign off as the BlueCloud support team."""


def run():
    keep = AITicketAutomationSubject.objects.get(pk=KEEP)
    match = dict(keep.match or {})

    br = list(match.get("body_regex") or [])
    seen = {x.strip().lower() for x in br}
    for p in ADD_BODY_REGEX:
        if p.strip().lower() not in seen:
            br.append(p)
            seen.add(p.strip().lower())
    match["body_regex"] = br

    bn = list(match.get("body_none") or [])
    seenn = {x.strip().lower() for x in bn}
    for p in ADD_BODY_NONE:
        if p.strip().lower() not in seenn:
            bn.append(p)
            seenn.add(p.strip().lower())
    # #5 had disqualifiers that would gut the merged subject ("add ", "fax", "vpn"...).
    # They were there to keep IT-request tickets out of a narrow rule; the merged rule is
    # recognised by body_regex, so they are dropped deliberately.
    match["body_none"] = bn

    keep.name = NEW_NAME
    keep.description = NEW_DESCRIPTION
    keep.instructions = NEW_INSTRUCTIONS
    keep.match = match
    keep.baseline_minutes = keep.baseline_minutes or 8
    keep.save()
    print(f"#{keep.pk} -> {keep.name}")
    print(f"   body_regex {len(br)} alternatives, body_none {len(bn)} disqualifiers")

    for pk in RETIRE:
        s = AITicketAutomationSubject.objects.filter(pk=pk).first()
        if not s:
            continue
        s.status = "retired"
        s.enabled = False
        s.description = (
            f"[Merged into #{keep.pk} '{keep.name}' on 2026-09-25 - same job, one rule.] "
            + (s.description or "")
        )[:4000]
        s.save()
        print(f"#{s.pk} retired ({s.name})")


run()
