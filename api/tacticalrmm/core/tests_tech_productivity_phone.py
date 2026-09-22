"""Phone attribution in the Technician Productivity report.

WHY THESE TESTS EXIST. On 2026-09-22 the owner asked why the weekly report said
"0m on the phone". It was not a quiet week: the PBX was migrated in the week of 2026-08-24
and moved BOTH of the keys this report attributes calls by -

  * inbound answered destinations went from `9201214` to `+14843351444;ext=214`, and the SQL
    pattern (`^[0-9]{3,7}$`) rejected every new row;
  * outbound `caller_id_name` went from the technician's name to the literal "BlueCloud",
    which matches nobody.

Four weeks of real talk time (443 minutes inbound, 454 outbound in the last seven days) was
reported as zero rather than as missing. These tests pin the rules that were derived from the
CDRs, in both the old and the new form - a report that silently says "nobody made a call" must
not be able to come back.

DB-free: every rule under test is pure (this venv has no test deps).
"""

from django.test import SimpleTestCase

from core import tech_productivity as tp

# The real extension list on pbx.blueuc.com (trimmed).
EXTS = {
    "007": "Megan", "200": "BlueCloud Conf", "201": "Chris Rawlings", "202": "Dan B",
    "211": "Fred", "212": "Cosmus Melly", "213": "Sean Miller", "214": "Zohaib Farooq",
}


class TestDestinationResolution(SimpleTestCase):
    def test_the_post_migration_form_is_read_explicitly(self):
        # What the PBX writes now. The ext parameter says which handset answered.
        self.assertEqual(tp._resolve_ext("+14843351444;ext=214", EXTS), "214")
        self.assertEqual(tp._resolve_ext("+14843351444;ext=212", EXTS), "212")
        # Case and separator variations seen in SIP URIs.
        self.assertEqual(tp._resolve_ext("+14843351444;EXT=213", EXTS), "213")
        self.assertEqual(tp._resolve_ext("14843351444&ext=211", EXTS), "211")

    def test_the_old_internal_form_still_works(self):
        # Four weeks of history are in this shape; the fix must not drop it.
        self.assertEqual(tp._resolve_ext("9201214", EXTS), "214")
        self.assertEqual(tp._resolve_ext("201", EXTS), "201")

    def test_the_ext_parameter_wins_over_the_trailing_digits(self):
        # Stripping punctuation from "+14843351444;ext=214" gives "14843351444214", whose
        # trailing digits happen to agree here - but that is luck, not a rule. A DID ending in
        # another extension's digits must not be able to credit the wrong person.
        exts = dict(EXTS, **{"444": "Reception"})
        self.assertEqual(tp._resolve_ext("+14843351444;ext=212", exts), "212")

    def test_a_destination_that_is_not_ours_is_credited_to_nobody(self):
        self.assertIsNone(tp._resolve_ext("+14843351444;ext=999", EXTS))  # removed handset
        self.assertIsNone(tp._resolve_ext("16107272052", EXTS))           # a fax DID
        self.assertIsNone(tp._resolve_ext("", EXTS))
        self.assertIsNone(tp._resolve_ext(None, EXTS))

    def test_forms_nobody_has_seen_yet_still_resolve(self):
        # THE POINT OF THE REWRITE. The next PBX change must not need a code change: any shape
        # is mined for candidates and tested against the real extension list.
        self.assertEqual(tp._resolve_ext("sip:213@pbx.blueuc.com", EXTS), "213")
        self.assertEqual(tp._resolve_ext("214@pbx.blueuc.com", EXTS), "214")
        self.assertEqual(tp._resolve_ext("+14843351444;user=212", EXTS), "212")
        self.assertEqual(tp._resolve_ext("tel:+1-484-335-1444;ext=211", EXTS), "211")
        self.assertEqual(tp._resolve_ext("sofia/internal/212", EXTS), "212")

    def test_an_ambiguous_string_is_credited_to_nobody(self):
        # Two different real extensions inside one string is a guess, and a guess in this report
        # ends up in a conversation about somebody's job.
        exts = dict(EXTS, **{"444": "Reception"})
        self.assertIsNone(tp._resolve_ext("transfer 212 to 213", EXTS))
        # "...1444" could be read as ext 444; a trailing suffix is only accepted when unique.
        self.assertIsNone(tp._resolve_ext("+14843351444", exts))

    def test_the_sql_no_longer_encodes_the_format_at_all(self):
        # The old failure was a format filter in SQL: rows were dropped before Python could
        # count them. Nothing in this module may reintroduce one.
        src = open(tp.__file__.replace(".pyc", ".py")).read()
        self.assertNotIn("DEST_IS_OURS", src)
        self.assertNotIn("destination_number ~", src)

    def test_the_detected_form_is_labelled_for_the_report(self):
        self.assertEqual(tp._dest_form("+14843351444;ext=214"), "DID;ext=NNN")
        self.assertEqual(tp._dest_form("9201214"), "bare internal")
        self.assertEqual(tp._dest_form("16107272052"), "bare E.164/DID")
        self.assertEqual(tp._dest_form("sip:213@pbx.blueuc.com"), "SIP URI")
        self.assertEqual(tp._dest_form(""), "(empty)")


class TestOutboundIdentity(SimpleTestCase):
    def test_the_company_name_identifies_nobody(self):
        # Every outbound leg since the migration carries this.
        self.assertTrue(tp.is_company_cid("BlueCloud"))
        self.assertTrue(tp.is_company_cid("bluecloud"))
        self.assertTrue(tp.is_company_cid("TQ-BlueCloud"))
        self.assertTrue(tp.is_company_cid(""))
        # Bare numbers are the DID or a trunk, not a person.
        self.assertTrue(tp.is_company_cid("4052058343"))
        self.assertTrue(tp.is_company_cid("+1 484 335 1444"))

    def test_a_real_technician_name_is_still_attributable(self):
        # Pre-migration rows, and what a PBX fix would restore.
        self.assertFalse(tp.is_company_cid("Cosmus Melly"))
        self.assertFalse(tp.is_company_cid("Sean Miller"))
        self.assertFalse(tp.is_company_cid("Dan B"))

    def test_the_company_name_never_scores_against_a_person(self):
        # Belt and braces: even if is_company_cid were bypassed, "BlueCloud" must not match a
        # technician by name similarity.
        for tech in ("Chris Rawlings", "Cosmus Melly", "Sean Miller", "Zohaib Farooq"):
            self.assertLess(tp.name_match_score(tech, "BlueCloud"), 0.8, tech)


class TestUnansweredCallCounting(SimpleTestCase):
    def test_one_ring_of_the_group_is_one_missed_call(self):
        # The real shape: four handsets ring for the same caller at the same second, a fifth is
        # added six seconds later when the group extends.
        legs = [("16108671500", 1789477289)] * 1
        legs += [("16108671500", 1789477289), ("16108671500", 1789477289),
                 ("16108671500", 1789477295)]
        self.assertEqual(tp.count_ring_bursts(legs), 1)

    def test_two_attempts_by_the_same_caller_are_two_missed_calls(self):
        legs = [("16108671500", 1789477289), ("16108671500", 1789477289),
                ("16108671500", 1789480000), ("16108671500", 1789480001)]
        self.assertEqual(tp.count_ring_bursts(legs), 2)

    def test_different_callers_never_merge(self):
        legs = [("16108671500", 1789477289), ("18553308653", 1789477289)]
        self.assertEqual(tp.count_ring_bursts(legs), 2)

    def test_the_real_week_collapses_from_legs_to_calls(self):
        # 303 legs in the seven days to 2026-09-22, four handsets per ring: counting rows (what
        # `count(distinct sip_call_id)` now does, because every leg has its own call id) more
        # than doubled the desk's "missed calls".
        legs = []
        for n in range(75):
            at = 1789400000 + n * 600
            legs += [("1610000%04d" % n, at)] * 4
        self.assertEqual(len(legs), 300)
        self.assertEqual(tp.count_ring_bursts(legs), 75)

    def test_nothing_unanswered_is_zero_not_an_error(self):
        self.assertEqual(tp.count_ring_bursts([]), 0)


class TestWithheldPhoneScore(SimpleTestCase):
    """A scale that cannot be measured must say so, not print "n/a" under a description of
    what it would have measured. That is what the owner read in the 2026-09-22 email."""

    def _rows(self):
        return [
            {"name": "Zohaib Farooq", "phone": {"talk_minutes": 193.4}, "active_days": 4,
             "tickets_touched": 20, "minutes": 780.0},
            {"name": "Chris Rawlings", "phone": {"talk_minutes": 0.4}, "active_days": 5,
             "tickets_touched": 22, "minutes": 1712.0},
        ]

    def test_partial_attribution_withholds_the_score_but_keeps_the_figure(self):
        rows = self._rows()
        tp._score(rows, phone_partial=True)
        for r in rows:
            self.assertIsNone(r["scores"]["phone"]["absolute"], r["name"])
            self.assertIsNone(r["scores"]["phone"]["relative"], r["name"])
            self.assertTrue(r["phone_score_withheld"])
        # The inbound minutes we DO know are still there to display.
        self.assertEqual(rows[0]["talk_in_per_active_day"], 48.4)
        self.assertEqual(rows[1]["talk_in_per_active_day"], 0.1)

    def test_the_overall_is_the_mean_of_the_other_scales_not_a_zero_for_phone(self):
        rows = self._rows()
        tp._score(rows, phone_partial=True)
        for r in rows:
            scored = [s["absolute"] for s in r["scores"].values() if s["absolute"] is not None]
            self.assertNotIn("phone", [k for k, s in r["scores"].items()
                                       if s["absolute"] is not None])
            # Whatever else is missing in this stub, phone never drags the mean to a 1.
            self.assertTrue(all(v >= 1 for v in scored))

    def test_full_attribution_scores_the_scale_normally(self):
        rows = self._rows()
        tp._score(rows, phone_partial=False)
        # 193.4 minutes over 4 active days is 48.4/day - top band (thresholds 5/20/45/90).
        self.assertEqual(rows[0]["talk_minutes_per_active_day"], 48.4)
        self.assertEqual(rows[0]["scores"]["phone"]["absolute"], 4)
        self.assertFalse(rows[0]["phone_score_withheld"])


class TestOutboundKeyIsChosenFromTheData(SimpleTestCase):
    """The report must pick its own attribution key, strongest evidence first. Hard-coding one is
    what broke it: the `caller_id_name` COLUMN stopped naming people (the dialplan rewrites it to
    "BlueCloud" before the trunk sees it) and the code had no second option - so 454 minutes of
    outbound talk a week became "unattributable" and the Phone engagement scale read n/a.

    The identity was in the CDR JSON the whole time: `variables.sip_from_user` carries the
    PLACING EXTENSION and `variables.caller_id_name` the technician's own name."""

    UUIDS = {"uuid-201": "201", "uuid-212": "212", "uuid-213": "213"}

    def test_the_placing_extension_wins_when_the_json_has_it(self):
        legs = [{"name": "BlueCloud", "json_name": "Zohaib Farooq", "billsec": 300,
                 "ext_uuid": "uuid-201", "from_ext": "214"}]
        self.assertEqual(tp.choose_outbound_key(legs, self.UUIDS), "sip_from_user")

    def test_the_column_name_is_used_when_the_pbx_still_sends_it(self):
        legs = [{"name": "Cosmus Melly", "json_name": "", "billsec": 60,
                 "ext_uuid": "uuid-212", "from_ext": None}]
        self.assertEqual(tp.choose_outbound_key(legs, self.UUIDS), "caller_id_name")

    def test_the_json_name_is_the_next_fallback(self):
        # The column has been rewritten and there is no From extension, but the dialplan's own
        # caller_id_name is still in the channel dump.
        legs = [{"name": "BlueCloud", "json_name": "Sean Miller", "billsec": 90,
                 "ext_uuid": "uuid-201", "from_ext": None}]
        self.assertEqual(tp.choose_outbound_key(legs, self.UUIDS), "json_caller_id_name")

    def test_the_handset_is_used_when_nothing_names_a_person_but_handsets_vary(self):
        legs = [{"name": "BlueCloud", "json_name": "BlueCloud", "billsec": 120,
                 "ext_uuid": "uuid-212", "from_ext": None},
                {"name": "BlueCloud", "json_name": "BlueCloud", "billsec": 60,
                 "ext_uuid": "uuid-213", "from_ext": None}]
        self.assertEqual(tp.choose_outbound_key(legs, self.UUIDS), "extension_uuid")

    def test_a_constant_handset_is_refused_rather_than_credited_to_one_person(self):
        # Every outbound leg carries extension 201's uuid because that is the outbound ROUTE.
        # Believing it would hand one technician the whole desk's outbound talk time.
        legs = [{"name": "BlueCloud", "json_name": "BlueCloud", "billsec": 120,
                 "ext_uuid": "uuid-201", "from_ext": None} for _ in range(50)]
        self.assertEqual(tp.choose_outbound_key(legs, self.UUIDS), "none")

    def test_an_unknown_handset_uuid_is_not_an_identity(self):
        legs = [{"name": "BlueCloud", "json_name": "", "billsec": 120,
                 "ext_uuid": "uuid-gateway-a", "from_ext": None},
                {"name": "BlueCloud", "json_name": "", "billsec": 90,
                 "ext_uuid": "uuid-gateway-b", "from_ext": None}]
        self.assertEqual(tp.choose_outbound_key(legs, self.UUIDS), "none")

    def test_no_outbound_calls_at_all_is_not_an_error(self):
        self.assertEqual(tp.choose_outbound_key([], self.UUIDS), "none")

    def test_unanswered_only_legs_do_not_choose_a_key(self):
        # Ring-out attempts with no talk time say nothing about who can be attributed.
        legs = [{"name": "BlueCloud", "json_name": "", "billsec": 0,
                 "ext_uuid": "uuid-212", "from_ext": "212"}]
        self.assertEqual(tp.choose_outbound_key(legs, self.UUIDS), "none")


class TestTheJsonIdentity(SimpleTestCase):
    """What the channel dump actually contains, and how it is read."""

    def test_the_from_user_resolves_to_the_placing_extension(self):
        # Real values, straight out of v_xml_cdr_json.variables.sip_from_user.
        for raw, ext in (("+14843351444;ext=214", "214"), ("+14843351444;ext=212", "212"),
                         ("+14843351444;ext=201", "201")):
            self.assertEqual(tp._resolve_ext(raw, EXTS), ext)

    def test_an_outside_number_in_from_user_belongs_to_nobody(self):
        # Legs placed by a gateway or a forwarded outside number: 4052058343, +1980217005.
        self.assertIsNone(tp._resolve_ext("4052058343", EXTS))
        self.assertIsNone(tp._resolve_ext("+1980217005", EXTS))

    def test_the_url_encoded_name_decodes_to_a_person(self):
        from urllib.parse import unquote_plus
        self.assertEqual(unquote_plus("Zohaib%20Farooq"), "Zohaib Farooq")
        self.assertFalse(tp.is_company_cid(unquote_plus("Zohaib%20Farooq")))

    def test_attribution_by_extension_does_not_depend_on_display_names_at_all(self):
        # The PBX says "Freddie Ortiz" where the helpdesk says "Fred Ortiz". The similarity
        # matcher happens to survive that pair (0.9), but it is a coin toss on the next one -
        # "Dan B" vs "Daniel Bartlett-Jones" is not. Matching on the extension sidesteps the
        # question, which is why sip_from_user is the preferred key.
        self.assertEqual(tp._resolve_ext("+14843351444;ext=211", EXTS), "211")
        self.assertLess(tp.name_match_score("Dan Bartlett", "D. Bartlett-Jones (mobile)"), 0.8)


class TestDuplicateIdentitiesAreFolded(SimpleTestCase):
    """"why does Chris Rawlings - gmail keep showing up in this report" (owner, 2026-09-22).

    A second Odoo contact for the same human authored one message and became a seventh
    "technician" with 1 ticket and 11.5 minutes - taking that work off Chris's row and dragging
    the desk median every "vs desk" score is measured against."""

    def _actor(self, name, minutes, tickets=(), **kw):
        a = {"name": name, "kind": "tech", "minutes": minutes, "sessions": 1, "closed": 0,
             "tickets": set(tickets), "companies": set(), "classes": {},
             "off_ticket_minutes": 0.0, "measured": 0, "inferred": 1,
             "ledger_only_tickets": [], "first": None, "last": None}
        a.update(kw)
        return a

    def test_the_gmail_duplicate_is_folded_into_the_real_technician(self):
        actors = {
            "Chris Rawlings": self._actor("Chris Rawlings", 1712.0, {"TICKET/1", "TICKET/2"}),
            "Chris Rawlings - gmail": self._actor("Chris Rawlings - gmail", 11.5, {"TICKET/61435"}),
            "Cosmus Melly": self._actor("Cosmus Melly", 958.0, {"TICKET/3"}),
        }
        out = tp.fold_actor_aliases(actors)
        self.assertNotIn("Chris Rawlings - gmail", out)
        self.assertEqual(sorted(out), ["Chris Rawlings", "Cosmus Melly"])
        # The work moves to the real row rather than disappearing.
        self.assertAlmostEqual(out["Chris Rawlings"]["minutes"], 1723.5)
        self.assertIn("TICKET/61435", out["Chris Rawlings"]["tickets"])

    def test_the_busier_identity_keeps_its_name(self):
        # A stray one-word contact must not rename the technician after their own stub.
        actors = {"Chris": self._actor("Chris", 8.0),
                  "Chris Rawlings": self._actor("Chris Rawlings", 1712.0)}
        out = tp.fold_actor_aliases(actors)
        self.assertEqual(list(out), ["Chris Rawlings"])
        self.assertAlmostEqual(out["Chris Rawlings"]["minutes"], 1720.0)

    def test_two_different_people_are_never_merged(self):
        actors = {"Fred Ortiz": self._actor("Fred Ortiz", 752.0),
                  "Freddie Ortiz": self._actor("Freddie Ortiz", 30.0),
                  "Sean Miller": self._actor("Sean Miller", 1950.0)}
        out = tp.fold_actor_aliases(actors)
        # Neither name's tokens are a subset of the other's, so this stays a question for a
        # human - a fuzzy merge would put one person's work on another's review.
        self.assertEqual(sorted(out), ["Fred Ortiz", "Freddie Ortiz", "Sean Miller"])

    def test_an_ambiguous_stub_is_left_alone(self):
        actors = {"Chris": self._actor("Chris", 5.0),
                  "Chris Rawlings": self._actor("Chris Rawlings", 900.0),
                  "Chris Smith": self._actor("Chris Smith", 800.0)}
        out = tp.fold_actor_aliases(actors)
        self.assertIn("Chris", out, "two candidates is a question, not a merge")

    def test_an_operator_override_wins(self):
        actors = {"Chris Rawlings": self._actor("Chris Rawlings", 900.0),
                  "CR (mobile)": self._actor("CR (mobile)", 40.0)}
        out = tp.fold_actor_aliases(actors, {"CR (mobile)": "Chris Rawlings"})
        self.assertEqual(list(out), ["Chris Rawlings"])
        self.assertAlmostEqual(out["Chris Rawlings"]["minutes"], 940.0)

    def test_customers_and_the_ai_are_not_touched(self):
        actors = {"Chris Rawlings": self._actor("Chris Rawlings", 900.0),
                  "Chris Rawlings - gmail": dict(self._actor("Chris Rawlings - gmail", 11.5),
                                                 kind="customer")}
        out = tp.fold_actor_aliases(actors)
        self.assertIn("Chris Rawlings - gmail", out, "only technicians are folded")
