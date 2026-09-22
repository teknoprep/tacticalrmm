"""Work claims: the dedup lock behind "never work the same thing twice".

DB-free where possible (this venv has no test deps); the fingerprint rules are pure.
"""

from django.test import SimpleTestCase

from core import ai_workclaims as wc


class TestFingerprints(SimpleTestCase):
    def test_reply_prefixes_and_reference_ids_do_not_make_a_new_thing(self):
        a = wc.subject_fingerprint("FW: Document Status Ref-63b863ce7194d2985ea3d8884798b417496617cb", "joe@sunnydell.com")
        b = wc.subject_fingerprint("Fwd: document status ref-9a1c22ff00ee11dd", "sue@sunnydell.com")
        self.assertEqual(a, b, "same lure, same customer domain -> same thing")

    def test_different_customers_are_different_things(self):
        a = wc.subject_fingerprint("SendPlot", "tom@omegadesign.com")
        b = wc.subject_fingerprint("SendPlot", "tom@farmerboyag.com")
        self.assertNotEqual(a, b)

    def test_condition_fingerprint_is_per_customer_and_host(self):
        a = wc.condition_fingerprint("sendplot-down", "Omega Design")
        b = wc.condition_fingerprint("sendplot-down", "Omega Design", host="ENG1-DEV")
        c = wc.condition_fingerprint("sendplot-down", "Farmerboy AG")
        self.assertNotEqual(a, b)
        self.assertNotEqual(a, c)

    def test_normalise_strips_noise_but_keeps_the_subject(self):
        self.assertEqual(wc.normalise_subject("RE: Re: FW: SendPlot   won't  open!!"), "sendplot won t open")
        self.assertEqual(wc.normalise_subject("Action Required: Mailbox Full Ref- 89c816499a9482123be3d6a6371983b48aa27adf"),
                         "action required mailbox full")
