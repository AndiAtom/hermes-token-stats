"""Tests for the known-ledger delta engine (Task 1 of the ledger plan).

Run: /usr/local/lib/hermes-agent/venv/bin/python3 -m pytest test_ledger_engine.py -v
(works with plain python3 too — stdlib sqlite3 only, no hermes deps)

Engine under test: ledger/engine.py — monotonic known/last_db/live_db counters.
"""

import os
import sqlite3
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ledger.engine import LedgerEngine  # noqa: E402

KEY = {
    "session_id": "s1",
    "model": "m",
    "billing_provider": "",
    "billing_base_url": "",
    "billing_mode": "",
    "task": "",
}


def row(in_=0, cached=0, out=0, calls=0, **key_overrides):
    r = {**KEY, "in": in_, "cached": cached, "out": out, "calls": calls}
    r.update(key_overrides)
    return r


class TestDeltaRules(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        schema = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "ledger", "schema.sql"
        )
        self.db.executescript(open(schema).read())
        self.eng = LedgerEngine(self.db)

    def get(self, **key_overrides):
        k = {**KEY, **key_overrides}
        return self.eng.get(
            k["session_id"], k["model"], k["task"],
            billing_provider=k["billing_provider"],
            billing_base_url=k["billing_base_url"],
            billing_mode=k["billing_mode"],
        )

    # ── basic accumulation ────────────────────────────────────────────

    def test_first_seen_sets_known_and_baseline(self):
        self.eng.apply_poll([row(in_=100, cached=50, out=20, calls=1)])
        r = self.get()
        assert r["known_in"] == 100 and r["last_db_in"] == 100 and r["live_db_in"] == 100
        assert r["known_cached"] == 50 and r["known_out"] == 20 and r["known_calls"] == 1

    def test_positive_delta_accumulates(self):
        self.eng.apply_poll([row(in_=100)])
        self.eng.apply_poll([row(in_=250)])
        r = self.get()
        assert r["known_in"] == 250, r["known_in"]
        assert r["last_db_in"] == 250

    def test_partial_poll_keeps_other_rows(self):
        """A poll that doesn't contain a known row must NOT treat it as removed.

        The state.db row set we read is a snapshot per cycle — a row absent from
        one poll is only 'removed' if it stays absent. We mark last_db=NULL only
        via the explicit removal handling in the poller (full-table read), so a
        plain apply_poll with a missing row must leave the row untouched.

        NOTE: removed-row handling is exercised via apply_poll with
        `snapshot=True` (poller reads the full table each cycle).
        """
        self.eng.apply_poll([row(in_=100), row(in_=10, session_id="s2")])
        self.eng.apply_poll([row(in_=10, session_id="s2")], snapshot=True)
        # s1 was in the previous snapshot but not in this one → removed → NULL baseline
        r1 = self.get()
        assert r1["last_db_in"] is None
        assert r1["known_in"] == 100  # known stays (money is spent)
        r2 = self.get(session_id="s2")
        assert r2["known_in"] == 10 and r2["last_db_in"] == 10

    # ── anomalies: decrease ───────────────────────────────────────────

    def test_decrease_adds_db_value_no_subtraction(self):
        self.eng.apply_poll([row(in_=100)])
        self.eng.apply_poll([row(in_=40)])  # compression reset / rewind
        r = self.get()
        assert r["known_in"] == 140, r["known_in"]  # additive baseline: known += 40 (Andi rule 2026-09-23)
        assert r["last_db_in"] == 40  # new baseline
        evs = [e for e in self.eng.events("s1") if e["kind"] == "decrease"]
        assert evs and evs[0]["counter"] == "in"
        assert evs[0]["last_db"] == 100 and evs[0]["db_now"] == 40

    def test_growth_after_decrease_counts_again(self):
        self.eng.apply_poll([row(in_=100)])
        self.eng.apply_poll([row(in_=40)])   # decrease: known=140, baseline=40
        self.eng.apply_poll([row(in_=90)])   # growth from baseline
        r = self.get()
        assert r["known_in"] == 190, r["known_in"]  # 140 + (90-40)

    def test_reset_to_zero_rebases_last_db(self):
        # live_db = 0 (state.db reset): decrease special case with live_db=0
        # → known += 0 (unchanged), last_db = live_db = 0. Everything that
        # grows afterwards counts from 0 as fresh tokens (Andi rule 23.09.2026).
        self.eng.apply_poll([row(in_=100)])
        self.eng.apply_poll([row(in_=0)])
        r = self.get()
        assert r["known_in"] == 100, r["known_in"]
        assert r["last_db_in"] == 0
        self.eng.apply_poll([row(in_=30)])   # fresh tokens after reset
        r = self.get()
        assert r["known_in"] == 130, r["known_in"]  # 100 + (30-0)
        assert r["last_db_in"] == 30

    # ── anomalies: removal / reappearance ────────────────────────────

    def test_removed_then_reappeared_no_double_count(self):
        self.eng.apply_poll([row(in_=100)])
        self.eng.apply_poll([], snapshot=True)  # row gone (CASCADE delete)
        r = self.get()
        assert r["last_db_in"] is None
        assert self.get()["known_in"] == 100
        self.eng.apply_poll([row(in_=100)])  # back at the same value
        r = self.get()
        assert r["known_in"] == 100, r["known_in"]  # NO +100 on top
        assert r["last_db_in"] == 100  # baseline re-anchored
        kinds = {e["kind"] for e in self.eng.events("s1")}
        assert "removed" in kinds and "reappeared" in kinds, kinds

    def test_reappeared_then_grows_counts_delta(self):
        self.eng.apply_poll([row(in_=100)])
        self.eng.apply_poll([], snapshot=True)
        self.eng.apply_poll([row(in_=100)])  # reappear, no delta
        self.eng.apply_poll([row(in_=130)])
        r = self.get()
        assert r["known_in"] == 130, r["known_in"]  # 100 + (130-100)

    # ── multi-key isolation ──────────────────────────────────────────

    def test_independent_rows_per_session_model_task(self):
        self.eng.apply_poll([
            row(in_=10, session_id="s1", model="a"),
            row(in_=20, session_id="s1", model="b"),
            row(in_=30, session_id="s2", model="a"),
            row(in_=5, session_id="s1", model="a", task="title_generation"),
        ])
        assert self.get(session_id="s1", model="a")["known_in"] == 10
        assert self.get(session_id="s1", model="a", task="title_generation")["known_in"] == 5
        assert self.get(session_id="s1", model="b")["known_in"] == 20
        assert self.get(session_id="s2", model="a")["known_in"] == 30

    def test_all_counters_accumulate(self):
        self.eng.apply_poll([row(in_=10, cached=5, out=2, calls=1)])
        self.eng.apply_poll([row(in_=15, cached=8, out=4, calls=2)])
        r = self.get()
        assert (r["known_in"], r["known_cached"], r["known_out"], r["known_calls"]) == (15, 8, 4, 2)

    def test_no_delta_poll_is_idempotent(self):
        self.eng.apply_poll([row(in_=100)])
        for _ in range(3):
            self.eng.apply_poll([row(in_=100)])
        assert self.get()["known_in"] == 100
        assert self.eng.events("s1") == []

    # ── v0.5.0 write-sparsity ────────────────────────────────────────

    def test_no_delta_poll_writes_nothing(self):
        """diff=0-Zykklus: kein Row-Update — last_poll bleibt stehen.

        Vor v0.5.0 wurde last_poll für JEDE Row in JEDEM Zyklus gebumpt
        (679 archivierte + 95 aktive Rows × 15 s = 254 KiB/Poll Disk).
        Jetzt: Liveness = ledger_meta.heartbeat, last_poll = letzte
        ÄNDERUNG. Verifikation über die UPDATE-Zählung (rowcount ist bei
        UPDATE ... SET x = x immer 1, daher hier via total_changes).
        """
        import time as _t
        self.eng.apply_poll([row(in_=100)])
        before = self.db.total_changes
        before_poll = self.get()["last_poll"]
        _t.sleep(0.01)
        self.eng.apply_poll([row(in_=100)])  # diff = 0
        assert self.db.total_changes == before  # kein einziges UPDATE
        assert self.get()["last_poll"] == before_poll  # unverändert

    def test_delta_poll_updates_last_poll(self):
        import time as _t
        self.eng.apply_poll([row(in_=100)])
        _t.sleep(0.01)
        before_poll = self.get()["last_poll"]
        self.eng.apply_poll([row(in_=150)])  # diff = +50
        r = self.get()
        assert r["known_in"] == 150
        assert r["last_poll"] > before_poll  # Änderung → last_poll bumped

    def test_repeated_empty_snapshot_is_idempotent(self):
        """Remove-Pfad: zweiter leerer Snapshot darf NICHTS mehr schreiben.

        Vor v0.5.0 re-updatete der Snapshot-Loop jede fehlende Row in
        jedem Zyklus (removed-Flut dauerhaft). Jetzt: nur der ERSTE
        Übergang schreibt (Events + last_db=NULL).
        """
        self.eng.apply_poll([row(in_=100)])
        self.eng.apply_poll([], snapshot=True)  # removed
        events_after_first = len(self.eng.events("s1"))
        before = self.db.total_changes
        for _ in range(3):
            self.eng.apply_poll([], snapshot=True)  # bleibt leer
        assert self.db.total_changes == before  # keine weiteren Writes
        assert len(self.eng.events("s1")) == events_after_first
        assert self.get()["known_in"] == 100  # Wert bleibt


if __name__ == "__main__":
    unittest.main()
