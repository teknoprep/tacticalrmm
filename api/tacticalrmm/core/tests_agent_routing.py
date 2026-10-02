"""Per-surface agent routing (owner, 2026-09-29).

Settings > Pi.dev AI picks ONE agent group per headless rule: ticket triage, autowork, the
procedure miner, auto-resolve, scheduled AI actions, the subjects proposer, the productivity
reports, and the daily report. Every rule falls back to the preferred agent group, so an
operator who sets only that one routes everything - which is what these tests pin down.

Lives in its own module for the same reason tests_ai_schedule.py does: core/tests.py imports
channels.testing at module level, which cannot load in the API virtualenv (no daphne) - a
broken neighbour must not make these unrunnable.
"""

from django.test import TestCase


def _group(slug, *, enabled=True, provider="deepseek", model_id="deepseek-flash"):
    from core.models import AIAgentGroup, AIAgentGroupMember

    g = AIAgentGroup.objects.create(name=slug.upper(), slug=slug, enabled=enabled)
    AIAgentGroupMember.objects.create(
        group=g,
        role="orchestrator",
        provider=provider,
        model_id=model_id,
        enabled=True,
        thinking_level="medium",
    )
    return g


class TestAgentSurfaceRouting(TestCase):
    """The resolver. CoreSettings is used UNSAVED on purpose: headless_group_blob reads two
    attributes off it and nothing else, so a settings row would only make the test slower
    and couple it to the ~200 other settings fields."""

    def setUp(self):
        from core.models import CoreSettings

        self.core = CoreSettings()
        self.it = _group("it")
        self.alt = _group("alt", provider="anthropic", model_id="claude-sonnet-5")
        self.core.ai_preferred_agent_group = self.it

    def _slug(self, surface, **kw):
        from core.agent_groups import headless_group_blob

        blob = headless_group_blob(self.core, surface=surface, **kw)
        return ((blob.get("agent_group") or {}).get("slug"))

    def test_every_surface_inherits_the_preferred_group(self):
        from core.agent_groups import AGENT_SURFACES

        for surface in AGENT_SURFACES:
            self.assertEqual(self._slug(surface["key"]), "it", surface["key"])

    def test_a_routing_entry_wins_for_its_own_surface_only(self):
        self.core.ai_agent_routing = {"miner": self.alt.id}
        self.assertEqual(self._slug("miner"), "alt")
        self.assertEqual(self._slug("triage"), "it")

    def test_an_explicit_override_beats_routing(self):
        # A Ticket Automation Subject's own group is more specific than a rule-wide default.
        self.core.ai_agent_routing = {"autowork": self.alt.id}
        self.assertEqual(self._slug("autowork", override=self.it), "it")

    def test_a_group_that_no_longer_exists_falls_back_to_preferred(self):
        self.core.ai_agent_routing = {"miner": 999999}
        self.assertEqual(self._slug("miner"), "it")

    def test_a_disabled_group_falls_back_to_preferred(self):
        off = _group("off", enabled=False)
        self.core.ai_agent_routing = {"miner": off.id}
        self.assertEqual(self._slug("miner"), "it")

    def test_an_unrouted_surface_name_is_harmless(self):
        # Defensive: a stale key left in the JSON must not strand every other surface.
        self.core.ai_agent_routing = {"surfaced_that_no_longer_exists": self.alt.id}
        self.assertEqual(self._slug("triage"), "it")

    def test_orchestrator_fields_carry_the_group_and_its_roster(self):
        from core.agent_groups import headless_orchestrator_fields

        self.core.ai_agent_routing = {"miner": self.alt.id}
        fields = headless_orchestrator_fields(self.core, surface="miner")
        self.assertEqual(fields["provider"], "anthropic")
        self.assertEqual(fields["model_id"], "claude-sonnet-5")
        self.assertEqual(fields["agent_group"]["slug"], "alt")
        self.assertEqual(
            fields["group_orchestrator"]["model_id"], "claude-sonnet-5"
        )
        self.assertIn("agent_group_keys", fields)

    def test_no_group_at_all_returns_empty_so_the_caller_uses_its_own_model(self):
        from core.agent_groups import headless_group_blob, headless_orchestrator_fields

        self.core.ai_preferred_agent_group = None
        self.core.ai_agent_routing = {}
        self.assertEqual(headless_group_blob(self.core, surface="triage"), {})
        self.assertEqual(headless_orchestrator_fields(self.core, surface="triage"), {})

    def test_a_group_with_no_orchestrator_is_not_used(self):
        from core.agent_groups import headless_group_blob
        from core.models import AIAgentGroup

        empty = AIAgentGroup.objects.create(name="Empty", slug="empty", enabled=True)
        self.core.ai_agent_routing = {"miner": empty.id}
        self.assertEqual(headless_group_blob(self.core, surface="miner"), {})

    def test_surface_keys_are_unique_and_labelled(self):
        from core.agent_groups import AGENT_SURFACES, AGENT_SURFACE_KEYS

        self.assertEqual(len(AGENT_SURFACE_KEYS), len(set(AGENT_SURFACE_KEYS)))
        for surface in AGENT_SURFACES:
            self.assertTrue(surface["label"].strip(), surface["key"])
            self.assertTrue(surface["hint"].strip(), surface["key"])


class TestAgentRoutingValidation(TestCase):
    """What the settings API refuses, so a typo cannot sit in the JSON being ignored."""

    def setUp(self):
        from core.models import CoreSettings

        self.core = CoreSettings()
        self.group = _group("it")

    def _valid(self, routing):
        from core.serializers import CoreSettingsSerializer

        serializer = CoreSettingsSerializer(
            instance=self.core, data={"ai_agent_routing": routing}, partial=True
        )
        return serializer.is_valid(), serializer.errors

    def test_accepts_a_known_surface_and_an_existing_group(self):
        ok, errors = self._valid({"miner": self.group.id})
        self.assertTrue(ok, errors)

    def test_rejects_an_unknown_surface(self):
        ok, errors = self._valid({"mineer": self.group.id})
        self.assertFalse(ok)
        self.assertIn("Unknown routing target", str(errors))

    def test_rejects_a_group_that_does_not_exist(self):
        ok, errors = self._valid({"miner": 999999})
        self.assertFalse(ok)
        self.assertIn("No agent group", str(errors))

    def test_rejects_a_non_numeric_group(self):
        ok, _ = self._valid({"miner": "banana"})
        self.assertFalse(ok)

    def test_rejects_a_non_object(self):
        ok, _ = self._valid(["miner"])
        self.assertFalse(ok)

    def test_clearing_a_row_is_accepted_and_dropped(self):
        from core.serializers import CoreSettingsSerializer

        serializer = CoreSettingsSerializer(
            instance=self.core,
            data={"ai_agent_routing": {"miner": None, "daily": "", "triage": self.group.id}},
            partial=True,
        )
        self.assertTrue(serializer.is_valid(), serializer.errors)
        self.assertEqual(serializer.validated_data["ai_agent_routing"], {"triage": self.group.id})

    def test_empty_routing_is_accepted(self):
        ok, errors = self._valid({})
        self.assertTrue(ok, errors)
