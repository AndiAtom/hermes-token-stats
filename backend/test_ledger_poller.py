"""Tests for the ledger poller with archive cut-off (v0.5.0).

Run: /usr/local/lib/hermes-agent/venv/bin/python3 -m unittest test_ledger_poller -v
(stdlib only — no hermes deps)

Poller under test: ledger/poller.py — reads session_model_usage read-only
with a JOIN on sessions: archived rows whose last usage write is older than
ARCHIVE_GRACE_SECONDS drop out of the poll snapshot (removed-path in the
engine: last_db = NULL, known frozen). Resume/unarchive re-adds them
(reappear-path: baseline without delta).

Fake state.db: sessions(id, archived) + session_model_usage(..., last_seen).
"""

import os
import sqlite3
import sys
import tempfile
import time
import unittest

REPO = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, REPO)

from ledger.engine import LedgerEngine          # noqa: E402
from ledger.poller import ARCHIVE_GRACE_SECONDS, poll_profile, read_rows  # noqa: E402

NOW = 1_000_000.0  # fixed epoch base for deterministic last_seen values


def fake_state_db(path):
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            archived INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE session_model_usage (
            session_id TEXT NOT NULL,
            model TEXT NOT NULL DEFAULT 'm',
            billing_provider TEXT NOT NULL DEFAULT '',
            billing_base_url TEXT NOT NULL DEFAULT '',
            billing_mode TEXT NOT NULL DEFAULT '',
            task TEXT NOT NULL DEFAULT '',
            input_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            api_call_count INTEGER NOT NULL DEFAULT 0,
            last_seen REAL
        );
    """)
    return db


def usage_row(db, sid, in_=100, last_seen=NOW, archived=0, task=""):
    db.execute(
        "INSERT INTO sessions (id, archived) VALUES (?, ?)", (sid, archived))
    db.execute(
        "INSERT INTO session_model_usage (session_id, input_tokens, last_seen, task) "
        "VALUES (?, ?, ?, ?)", (sid, in_, last_seen, task))


class TestPollerCutoff(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ledger-poller-test-")
        self.state = os.path.join(self.tmp, "state.db")
        db = fake_state_db(self.state)
        db.commit()
        db.close()
        self.ledger = sqlite3.connect(":memory:")
        self.ledger.row_factory = sqlite3.Row
        with open(os.path.join(REPO, "ledger", "schema.sql")) as f:
            self.ledger.executescript(f.read())
        self.eng = LedgerEngine(self.ledger)

    def tearDown(self):
        shutil_rmtree(self.tmp)
        self.ledger.close()

    # monkeypatch time so the grace window is deterministic: the poller
    # computes its cutoff from time.time(); we pin it to NOW + 10.
    def poll(self):
        import ledger.poller as P
        orig = P.time.time
        P.time.time = lambda: NOW + 10.0
        try:
            return poll_profile(self.state, self.eng)
        finally:
            P.time.time = orig

    def get(self, sid, task=""):
        return self.eng.get(sid, "m", task)

    def heartbeat(self):
        r = self.ledger.execute(
            "SELECT value FROM ledger_meta WHERE key = 'heartbeat'").fetchone()
        return r["value"] if r else None

    # ── cut-off filtering ─────────────────────────────────────────────

    def test_active_session_is_polled(self):
        db = sqlite3.connect(self.state)
        usage_row(db, "s-active", in_=100, last_seen=NOW - 999_999)  # alt, aber aktiv
        db.commit(); db.close()
        n = self.poll()
        self.assertEqual(n, 1)
        self.assertEqual(self.get("s-active")["known_in"], 100)

    def test_archived_stale_session_is_cut_off(self):
        db = sqlite3.connect(self.state)
        # letzte Usage-Schreibung älter als die Grace → raus aus dem Snapshot
        usage_row(db, "s-arch-old", in_=100,
                  last_seen=NOW - 10.0 - ARCHIVE_GRACE_SECONDS - 1, archived=1)
        db.commit(); db.close()
        n = self.poll()
        self.assertEqual(n, 0)  # nie im Snapshot → auch kein ledger_row

    def test_archived_within_grace_is_still_polled(self):
        db = sqlite3.connect(self.state)
        # letzte Usage-Schreibung INNERHALB der Grace → noch mitpollen
        usage_row(db, "s-arch-new", in_=100,
                  last_seen=NOW - 10.0 - ARCHIVE_GRACE_SECONDS + 60, archived=1)
        db.commit(); db.close()
        n = self.poll()
        self.assertEqual(n, 1)
        self.assertEqual(self.get("s-arch-new")["known_in"], 100)

    def test_usage_row_without_session_entry_is_polled(self):
        # LEFT JOIN: Usage-Row ohne sessions-Eintrag (z.B. Migration-Lücke)
        # wird wie aktiv behandelt — darf nicht stillschweigend fallen.
        db = sqlite3.connect(self.state)
        db.execute(
            "INSERT INTO session_model_usage (session_id, input_tokens, last_seen) "
            "VALUES ('s-orphan', 100, ?)", (NOW - 999_999,))
        db.commit(); db.close()
        n = self.poll()
        self.assertEqual(n, 1)
        self.assertEqual(self.get("s-orphan")["known_in"], 100)

    # ── archive transition: removed → reappear ───────────────────────

    def test_archiving_freezes_row_without_losing_known(self):
        db = sqlite3.connect(self.state)
        usage_row(db, "s1", in_=100, last_seen=NOW - 999_999)  # aktiv
        db.commit(); db.close()
        self.poll()  # Initial: known=100
        # jetzt archivieren, letzte Usage alt → fällt aus dem Snapshot
        db = sqlite3.connect(self.state)
        db.execute("UPDATE sessions SET archived = 1 WHERE id = 's1'")
        db.execute("UPDATE session_model_usage SET last_seen = ? WHERE session_id = 's1'",
                   (NOW - 10.0 - ARCHIVE_GRACE_SECONDS - 1,))
        db.commit(); db.close()
        self.poll()
        r = self.get("s1")
        self.assertIsNone(r["last_db_in"])           # removed: Baseline weg
        self.assertEqual(r["known_in"], 100)         # known eingefroren, nicht verloren
        kinds = {e["kind"] for e in self.eng.events("s1")}
        self.assertIn("removed", kinds)

    def test_resume_after_archive_baselines_without_double_count(self):
        db = sqlite3.connect(self.state)
        usage_row(db, "s1", in_=100, last_seen=NOW - 999_999)
        db.commit(); db.close()
        self.poll()
        db = sqlite3.connect(self.state)
        db.execute("UPDATE sessions SET archived = 1 WHERE id = 's1'")
        db.execute("UPDATE session_model_usage SET last_seen = ? WHERE session_id = 's1'",
                   (NOW - 10.0 - ARCHIVE_GRACE_SECONDS - 1,))
        db.commit(); db.close()
        self.poll()  # removed
        # Resume: Hermes setzt archived = 0 (Lineage-Unarchive), Werte unverändert
        db = sqlite3.connect(self.state)
        db.execute("UPDATE sessions SET archived = 0 WHERE id = 's1'")
        db.commit(); db.close()
        self.poll()  # reappear
        r = self.get("s1")
        self.assertEqual(r["known_in"], 100)          # KEIN +100 obendrauf
        self.assertEqual(r["last_db_in"], 100)        # Baseline neu verankert
        kinds = {e["kind"] for e in self.eng.events("s1")}
        self.assertIn("reappeared", kinds)

    def test_growth_after_resume_counts_delta_from_baseline(self):
        # Der Praxisfall: Resume + neue Tokens — das Delta nach dem
        # Reappear muss normal zählen.
        db = sqlite3.connect(self.state)
        usage_row(db, "s1", in_=100, last_seen=NOW - 999_999)
        db.commit(); db.close()
        self.poll()
        db = sqlite3.connect(self.state)
        db.execute("UPDATE sessions SET archived = 1 WHERE id = 's1'")
        db.execute("UPDATE session_model_usage SET last_seen = ? WHERE session_id = 's1'",
                   (NOW - 10.0 - ARCHIVE_GRACE_SECONDS - 1,))
        db.commit(); db.close()
        self.poll()  # removed
        db = sqlite3.connect(self.state)
        db.execute("UPDATE sessions SET archived = 0 WHERE id = 's1'")
        db.execute("UPDATE session_model_usage SET input_tokens = 130 WHERE session_id = 's1'")
        db.commit(); db.close()
        self.poll()  # reappear + growth in einem Zug
        r = self.get("s1")
        self.assertEqual(r["known_in"], 130, r["known_in"])  # 100 + (130-100)

    # ── heartbeat ────────────────────────────────────────────────────

    def test_poll_writes_heartbeat(self):
        before = self.heartbeat()
        self.assertIsNone(before)
        db = sqlite3.connect(self.state)
        usage_row(db, "s1", in_=1, last_seen=NOW - 999_999)
        db.commit(); db.close()
        self.poll()
        hb = self.heartbeat()
        self.assertIsNotNone(hb)
        self.assertGreater(hb, 0)
        # zweiter Poll updated dieselbe Row (kein Duplikat)
        self.poll()
        rows = self.ledger.execute(
            "SELECT COUNT(*) FROM ledger_meta WHERE key = 'heartbeat'").fetchone()[0]
        self.assertEqual(rows, 1)


def shutil_rmtree(path):
    import shutil
    shutil.rmtree(path, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
