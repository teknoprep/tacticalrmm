"""Timezone semantics for AI task schedules.

Lives in its own module because core/tests.py imports channels.testing at module level,
which cannot load in the API virtualenv (no daphne) - a broken neighbour must not make
these unrunnable.
"""

from django.test import SimpleTestCase


class TestAITaskScheduleTimezone(SimpleTestCase):
    """"Daily at 03:00" has to mean 03:00 on a named clock, and the UI must be shown
    the same clock the scheduler used.

    Before this, `_compute_schedule` localised with Django's TIME_ZONE (UTC here), so an
    overnight window authored for a customer fired at 03:00 UTC - 04:00 in London in
    summer, 23:00 the previous evening in New York - while the tasks table displayed a
    bare "03:00" and named no zone at all.
    """

    def setUp(self):
        import datetime as dt

        from core.tasks import _compute_schedule

        self.compute = _compute_schedule
        # 20:00 UTC = 21:00 London (BST), 16:00 New York (EDT)
        self.now = dt.datetime(2026, 9, 14, 20, 0, tzinfo=dt.timezone.utc)
        self.at_3am = dt.time(3, 0)

    def _daily(self, tz):
        return self.compute("daily", 3600, self.at_3am, None, None, self.now, tz=tz)

    def test_wall_clock_is_read_in_the_named_zone(self):
        from zoneinfo import ZoneInfo

        for zone in ("UTC", "Europe/London", "America/New_York", "Australia/Sydney"):
            nxt = self._daily(zone)
            self.assertEqual(
                nxt.astimezone(ZoneInfo(zone)).strftime("%H:%M"),
                "03:00",
                f"{zone} should fire at 03:00 local",
            )

    def test_the_same_wall_clock_is_a_different_instant_per_zone(self):
        # This is the whole point: 03:00 is not one moment.
        moments = {self._daily(z) for z in ("Europe/London", "America/New_York")}
        self.assertEqual(len(moments), 2)

    def test_dst_keeps_the_local_hour_not_the_utc_hour(self):
        import datetime as dt
        from zoneinfo import ZoneInfo

        # London clocks go back on 2026-10-25: BST (+1) -> GMT (+0).
        before = self.compute(
            "daily", 3600, self.at_3am, None, None,
            dt.datetime(2026, 10, 23, 12, 0, tzinfo=dt.timezone.utc), tz="Europe/London",
        )
        after = self.compute(
            "daily", 3600, self.at_3am, None, None,
            dt.datetime(2026, 10, 26, 12, 0, tzinfo=dt.timezone.utc), tz="Europe/London",
        )
        for nxt in (before, after):
            self.assertEqual(
                nxt.astimezone(ZoneInfo("Europe/London")).strftime("%H:%M"), "03:00"
            )
        # ...and the UTC hour therefore MOVED across the boundary, which is correct.
        self.assertNotEqual(before.astimezone(dt.timezone.utc).hour,
                            after.astimezone(dt.timezone.utc).hour)

    def test_interval_schedules_ignore_the_zone(self):
        # "Every 15 minutes" has no wall clock in it, so a timezone cannot change it.
        a = self.compute("interval", 900, None, None, None, self.now, tz="Asia/Tokyo")
        b = self.compute("interval", 900, None, None, None, self.now, tz="UTC")
        self.assertEqual(a, b)

    def test_an_unknown_zone_still_schedules(self):
        # A typo in a zone name must not silently stop a task from ever running again.
        self.assertIsNotNone(self._daily("Not/AZone"))

    # NOTE: `AITask.effective_timezone` (task zone -> device zone -> global default) and
    # the serializer fields that expose it need the database, and this install's venv has
    # no test dependencies (model_bakery/daphne are absent), so they are covered by the
    # live check recorded in pibridge/docs/DECISIONS.md rather than faked here.
