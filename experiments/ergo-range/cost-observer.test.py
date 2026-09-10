"""Worker-free cost-accounting regressions; never instantiate or run WASM."""
import pathlib
import runpy
import unittest
from unittest.mock import patch

BASE = pathlib.Path(__file__).resolve().parent
COST = runpy.run_path(str(BASE / "cost-check.py"))
PROBE = runpy.run_path(str(BASE / "metering-check.py"))


class FakeStore:
    closed = False

    def get_fuel(self):
        return 10_000_000

    def close(self):
        self.closed = True


class Observer(unittest.TestCase):
    def test_trap_and_close_pair_without_losing_fuel(self):
        phases = COST["Phases"]()
        def event(phase, state, fuel):
            return {"phase": phase, "event": state, "fuelRemaining": fuel, "linearMemoryBytes": 65536}
        phases(event("parse", "before", 10_000_000))
        phases(event("parse", "trap", 0))
        phases(event("store-close", "before", 0))
        phases(event("store-close", "after", None))
        self.assertIsNone(phases.pending)
        self.assertEqual(sum(row["fuel"] or 0 for row in phases.rows), 10_000_000)
        self.assertEqual(phases.rows[0]["outcome"], "trap")
        self.assertIn("privateBytes", phases.rows[0]["before"])

    def test_missing_begin_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "unpaired"):
            COST["Phases"]()({"phase": "parse", "event": "after"})

    def test_overlapping_phases_are_refused(self):
        phases = COST["Phases"]()
        phases({"phase": "parse", "event": "before"})
        with self.assertRaisesRegex(RuntimeError, "overlapping"):
            phases({"phase": "copy", "event": "before"})

    def test_observer_error_still_closes_store(self):
        store = FakeStore()
        def observe(event):
            if event["phase"] == "store" and event["event"] == "after":
                raise ValueError("observer failed")
        with patch.dict(PROBE["decode"].__globals__, {"store_for": lambda *a, **k: store}):
            with self.assertRaisesRegex(ValueError, "observer failed"):
                PROBE["decode"](None, None, b"x", observe=observe)
        self.assertTrue(store.closed)

    def test_close_observer_error_still_closes_store(self):
        store = FakeStore()
        def observe(event):
            if event["phase"] == "store" and event["event"] == "after":
                raise ValueError("attempt failed")
            if event["phase"] == "store-close":
                raise RuntimeError("close observer failed")
        with patch.dict(PROBE["decode"].__globals__, {"store_for": lambda *a, **k: store}):
            with self.assertRaisesRegex(RuntimeError, "close observer failed"):
                PROBE["decode"](None, None, b"x", observe=observe)
        self.assertTrue(store.closed)


if __name__ == "__main__":
    unittest.main()
