"""Tests for the token-stats-ledger plugin backend (Task 4 of the ledger plan).

Runs fully isolated: temporary LEDGER_BASE + fake state.db via ENV overlays,
FastAPI TestClient — no gateway, no production data.

Run with the tools-python (has fastapi/httpx):
  /root/.hermes/tools/python-3.14.*/bin/python3 -I test_plugin_api.py -v
"""

import os
import shutil
import sqlite3
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(REPO, "plugin_pkg", "token-stats", "dashboard")
sys.path.insert(0, PKG)

STATE_COPY = None


def _day_key_for(ts):
    """Same day-attribution as plugin_api._day_key (local timezone)."""
    import datetime
    return datetime.datetime.fromtimestamp(
        ts, datetime.timezone.utc
    ).astimezone().strftime("%Y-%m-%d")


def fake_state_db(path):
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, title TEXT, source TEXT,
            started_at REAL, ended_at REAL, last_activity_at REAL,
            message_count INTEGER, api_call_count INTEGER,
            input_tokens INTEGER, output_tokens INTEGER,
            cache_read_tokens INTEGER, cache_write_tokens INTEGER,
            reasoning_tokens INTEGER, estimated_cost_usd REAL,
            actual_cost_usd REAL, model TEXT, billing_provider TEXT,
            billing_mode TEXT, hidden INTEGER DEFAULT 0,
            model_config TEXT, parent_session_id TEXT
        );
    """)
    db.execute(
        "INSERT INTO sessions (id, title, source, started_at, last_activity_at, "
        "model, cache_write_tokens, reasoning_tokens, estimated_cost_usd) "
        "VALUES ('s1', 'Test Session', 'desktop', 1000.0, 1500.0, 'm', 10, 5, 0.42)")
    # subagent child: source tag (v30) + delegate marker (v16)
    db.execute(
        "INSERT INTO sessions (id, title, source, started_at, last_activity_at, "
        "model, model_config, parent_session_id) "
        "VALUES ('sa1', 'Subagent Task', 'subagent', 1200.0, 1300.0, 'm', "
        "'{\"_delegate_from\": \"s1\"}', 's1')")
    # compression split: parent_session_id set but NOT a subagent
    db.execute(
        "INSERT INTO sessions (id, title, source, started_at, last_activity_at, "
        "model, parent_session_id) "
        "VALUES ('cs1', 'Split', 'desktop', 1100.0, 1200.0, 'm', 's1')")
    db.commit()
    db.close()


class BackendEnv:
    """ENV overlay: temp LEDGER_BASE + fake state.db."""

    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="ledger-api-test-")
        self.base = os.path.join(self.tmp, "ledger")
        self.state = os.path.join(self.tmp, "state.db")
        fake_state_db(self.state)
        os.environ["LEDGER_BASE"] = self.base
        os.environ["LEDGER_STATE_DB"] = self.state

    def seed(self, rows):
        # fresh DB per seed (WAL leftovers of the previous connection
        # would lock; also avoids PK collisions between tests)
        for suffix in ("", "-wal", "-shm"):
            p = os.path.join(self.base, "default", "ledger.db") + suffix
            if os.path.exists(p):
                os.unlink(p)
        os.makedirs(os.path.join(self.base, "default"), exist_ok=True)
        db = sqlite3.connect(os.path.join(self.base, "default", "ledger.db"))
        with open(os.path.join(REPO, "ledger", "schema.sql")) as f:
            db.executescript(f.read())
        for r in rows:
            db.execute(
                "INSERT INTO ledger_rows (session_id, model, task, known_in, "
                "known_cached, known_out, known_calls, last_db_in, live_db_in, "
                "first_seen, last_poll) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (r["sid"], r.get("model", "m"), r.get("task", ""),
                 r.get("known_in", 0), r.get("known_cached", 0),
                 r.get("known_out", 0), r.get("known_calls", 0),
                 r.get("known_in", 0), r.get("known_in", 0),
                 r.get("first_seen", 1000.0), r.get("last_poll", 1000.0)))
        # optional billing_provider per row (grain column, '' default)
        for r in rows:
            if r.get("billing_provider"):
                db.execute(
                    "UPDATE ledger_rows SET billing_provider = ? "
                    "WHERE session_id = ? AND model = ? AND task = ?",
                    (r["billing_provider"], r["sid"], r.get("model", "m"),
                     r.get("task", "")))
        db.commit()
        db.close()

    def cleanup(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        os.environ.pop("LEDGER_BASE", None)
        os.environ.pop("LEDGER_STATE_DB", None)


class TestPluginApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.env = BackendEnv()
        # import AFTER the ENV is set — LEDGER_BASE is read at import time
        import plugin_api
        cls.plugin_api = plugin_api
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        app = FastAPI()
        app.include_router(plugin_api.router, prefix="/api/plugins/token-stats")
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        cls.env.cleanup()

    def test_profiles(self):
        r = self.client.get("/api/plugins/token-stats/profiles")
        assert r.status_code == 200
        assert r.json() == {"profiles": ["default"]}

    def test_health_no_db(self):
        # base exists but no ledger.db for profile 'empty'
        r = self.client.get(
            "/api/plugins/token-stats/health?profile=empty")
        assert r.status_code == 200
        j = r.json()
        assert j["ok"] is False and "available" in j

    def test_health_heartbeat_source(self):
        # v0.5.0: heartbeat in ledger_meta wins over MAX(last_poll) —
        # all-archived freezes last_poll, the daemon still runs.
        import time as _t
        self.env.seed([{"sid": "s1", "known_in": 100, "last_poll": 1000.0}])
        ldb = os.path.join(self.base_ledger())
        db = sqlite3.connect(ldb)
        db.execute("INSERT INTO ledger_meta (key, value) VALUES ('heartbeat', ?)",
                   (_t.time() - 5,))
        db.commit(); db.close()
        r = self.client.get("/api/plugins/token-stats/health")
        j = r.json()
        assert j["ok"] is True, j
        assert j["source"] == "heartbeat", j
        assert j["age_seconds"] < 30, j

    def test_health_last_poll_fallback_when_no_meta(self):
        # Upgrade-Pfad: ledger.db ohne ledger_meta (vor v0.5.0 erzeugt)
        # → Fallback auf MAX(last_poll)
        self.env.seed([{"sid": "s1", "known_in": 100, "last_poll": 1000.0}])
        r = self.client.get("/api/plugins/token-stats/health")
        j = r.json()
        # last_poll=1000.0 ist uralt → not ok, aber der Fallback greift
        assert j["ok"] is False, j
        assert j["source"] == "last_poll_fallback", j

    def base_ledger(self):
        return os.path.join(self.env.base, "default", "ledger.db")

    def test_ledger_sessions_shape(self):
        # s1 has state.db metadata (last_activity_at=1500); s2 is
        # ledger-only → activity falls back to first_seen (1000.0).
        # Sort must follow REAL activity, NOT last_poll (bumped every cycle).
        self.env.seed([
            {"sid": "s1", "known_in": 100, "known_cached": 50,
             "known_out": 20, "known_calls": 2, "last_poll": 2000.0},
            {"sid": "s1", "model": "m2", "known_in": 30, "last_poll": 1500.0},
            {"sid": "s2", "known_in": 500, "first_seen": 1000.0,
             "last_poll": 9999.0},  # huge last_poll must NOT win the sort
        ])
        r = self.client.get("/api/plugins/token-stats/ledger?days=0")
        assert r.status_code == 200
        j = r.json()
        sids = [s["id"] for s in j["sessions"]]
        assert sids == ["s1", "s2"], sids  # activity order, not last_poll
        s1 = next(s for s in j["sessions"] if s["id"] == "s1")
        # session sums over grain rows
        assert s1["input_tokens"] == 130 and s1["cache_read_tokens"] == 50
        assert s1["output_tokens"] == 20 and s1["api_call_count"] == 2
        # state.db metadata joined in
        assert s1["title"] == "Test Session"
        assert s1["cache_write_tokens"] == 10 and s1["reasoning_tokens"] == 5
        assert s1["estimated_cost_usd"] == 0.42
        assert s1["ledger_only"] is False
        # ledger-only session (not in state.db) stays visible
        s2 = next(s for s in j["sessions"] if s["id"] == "s2")
        assert s2["ledger_only"] is True
        assert s2["source"] == "ledger"

    def test_ledger_model_usage_shape(self):
        self.env.seed([
            {"sid": "s1", "model": "m", "task": "", "known_in": 100,
             "known_cached": 10, "known_out": 5, "known_calls": 1},
        ])
        r = self.client.get("/api/plugins/token-stats/ledger?days=0")
        mu = r.json()["model_usage"]
        assert len(mu) == 1
        m = mu[0]
        assert m["session_id"] == "s1" and m["model"] == "m" and m["task"] == ""
        assert m["input_tokens"] == 100 and m["cache_read_tokens"] == 10
        assert m["output_tokens"] == 5 and m["api_calls"] == 1
        assert m["live_in"] == 100  # ledger extras present

    def test_subagent_flagging(self):
        # Subagent sessions carry is_subagent + parent; compression splits
        # (parent_session_id set but no source/marker) must NOT be flagged.
        self.env.seed([
            {"sid": "s1", "known_in": 100},
            {"sid": "sa1", "known_in": 50},
            {"sid": "cs1", "known_in": 30},
            {"sid": "s2", "known_in": 20},  # ledger-only → no meta at all
        ])
        r = self.client.get("/api/plugins/token-stats/ledger?days=0")
        assert r.status_code == 200
        sess = {s["id"]: s for s in r.json()["sessions"]}
        assert sess["sa1"]["is_subagent"] is True
        assert sess["sa1"]["parent_session_id"] == "s1"
        assert sess["cs1"]["is_subagent"] is False
        assert sess["cs1"]["parent_session_id"] == "s1"
        assert sess["s1"]["is_subagent"] is False
        assert sess["s1"]["parent_session_id"] is None
        # ledger-only session: safe defaults
        assert sess["s2"]["is_subagent"] is False
        assert sess["s2"]["parent_session_id"] is None

    def test_ledger_session_id_filter(self):
        self.env.seed([
            {"sid": "s1", "known_in": 100},
            {"sid": "s2", "known_in": 200},
        ])
        r = self.client.get(
            "/api/plugins/token-stats/ledger?session_id=s2&days=0")
        j = r.json()
        assert [s["id"] for s in j["sessions"]] == ["s2"]
        assert all(m["session_id"] == "s2" for m in j["model_usage"])

    def test_ledger_day_window_filters(self):
        import time
        now = time.time()
        # ledger-only sessions: activity = first_seen (no state.db rows)
        self.env.seed([
            {"sid": "recent", "known_in": 10, "first_seen": now - 100,
             "last_poll": now - 100},
            {"sid": "stale", "known_in": 20, "first_seen": now - 40 * 86400,
             "last_poll": now - 40 * 86400},
        ])
        r = self.client.get(
            "/api/plugins/token-stats/ledger?days=30&limit=10")
        j = r.json()
        ids = [s["id"] for s in j["sessions"]]
        assert ids == ["recent"], ids  # stale session outside 30d window
        assert all(m["session_id"] == "recent" for m in j["model_usage"])

    def test_ledger_until_exclusive_upper_bound(self):
        # Calendar-window support: since (inclusive) .. until (EXCLUSIVE).
        # Sessions with activity in [since, until) pass; anything at or
        # after `until` is filtered out (e.g. weekend activity outside
        # the workweek window).
        self.env.seed([
            {"sid": "work_mon", "known_in": 1, "first_seen": 2000.0,
             "last_poll": 2000.0},
            {"sid": "work_fri_late", "known_in": 2, "first_seen": 2999.5,
             "last_poll": 2999.5},
            {"sid": "weekend_sun", "known_in": 4, "first_seen": 3000.0,
             "last_poll": 3000.0},
            {"sid": "before_window", "known_in": 8, "first_seen": 1000.0,
             "last_poll": 1000.0},
        ])
        r = self.client.get(
            "/api/plugins/token-stats/ledger?days=0"
            "&since=1500&until=3000&limit=10")
        j = r.json()
        ids = {s["id"] for s in j["sessions"]}
        assert ids == {"work_mon", "work_fri_late"}, ids
        # `until` boundary is exclusive: activity == 3000.0 is out
        assert all(m["session_id"] in ids for m in j["model_usage"])

    def test_ledger_since_alone_lower_bound(self):
        # since without until: open-ended lower bound (e.g. month start)
        self.env.seed([
            {"sid": "old", "known_in": 1, "first_seen": 100.0,
             "last_poll": 100.0},
            {"sid": "new", "known_in": 2, "first_seen": 5000.0,
             "last_poll": 5000.0},
        ])
        r = self.client.get(
            "/api/plugins/token-stats/ledger?days=0&since=1000")
        j = r.json()
        ids = {s["id"] for s in j["sessions"]}
        assert ids == {"new"}, ids

    def test_ledger_totals_param(self):
        # v0.7.0: totals=1 aggregates the FULL window server-side.
        # s1 has state.db metadata (last_activity_at=1500), s2 is
        # ledger-only (activity=first_seen=1000). Two grain rows for s1
        # (main + aux task) must both count; by_model keys on
        # (model, billing_provider); by_task carries aux rows ONLY.
        self.env.seed([
            {"sid": "s1", "model": "m1", "known_in": 100,
             "known_cached": 50, "known_out": 20, "known_calls": 2,
             "billing_provider": "custom"},
            {"sid": "s1", "model": "m1", "task": "vision",
             "known_in": 30, "known_out": 10},
            {"sid": "s2", "model": "m2", "known_in": 500,
             "known_cached": 40, "known_out": 60, "known_calls": 3,
             "first_seen": 1000.0},
        ])
        r = self.client.get(
            "/api/plugins/token-stats/ledger?days=0&totals=1&limit=10")
        assert r.status_code == 200
        t = r.json()["totals"]
        assert t["sessions"] == 2
        assert t["input_tokens"] == 630
        assert t["cache_read_tokens"] == 90
        assert t["output_tokens"] == 90
        assert t["api_call_count"] == 5
        bm = {(e["model"], e["billing_provider"]): e
              for e in t["by_model"]}
        # m1 splits per billing_provider: main row 'custom', aux (vision)
        # row has none — grain-exact, same key as the client's per-row
        # pricing over model_usage[].
        assert bm[("m1", "custom")]["input_tokens"] == 100
        assert bm[("m1", "custom")]["sessions"] == 1
        assert bm[("m1", None)]["input_tokens"] == 30
        assert bm[("m2", None)]["input_tokens"] == 500
        assert bm[("m2", None)]["sessions"] == 1
        bt = {e["task"]: e for e in t["by_task"]}
        assert list(bt) == ["vision"]  # aux only, main task '' not listed
        assert bt["vision"]["input_tokens"] == 30
        bd = {e["day"]: e for e in t["by_day"]}
        # activity: s1=1500 (state.db), s2=1000 (first_seen fallback) —
        # same calendar day, so by_day merges both sessions into ONE
        # bucket (same attribution the client histogram uses).
        d1 = _day_key_for(1500.0)
        assert list(bd) == [d1]
        assert bd[d1]["input_tokens"] == 630 and bd[d1]["sessions"] == 2

    def test_ledger_totals_unaffected_by_limit(self):
        # The bug this fixes: /ledger sorts by activity and cuts at
        # `limit` — client window totals silently shrank as new sessions
        # pushed expensive old ones past the cut. With totals=1 the
        # aggregation runs BEFORE the limit cut: identical totals for
        # any limit, while sessions[] stays limited.
        seed = [
            {"sid": f"s{i}", "known_in": i, "known_cached": i * 10,
             "known_out": i * 100, "known_calls": 1,
             "first_seen": 1000.0 + i}
            for i in range(1, 11)
        ]
        self.env.seed(seed)
        t5 = self.client.get(
            "/api/plugins/token-stats/ledger?days=0&totals=1&limit=5"
        ).json()["totals"]
        t50 = self.client.get(
            "/api/plugins/token-stats/ledger?days=0&totals=1&limit=50"
        ).json()["totals"]
        assert t5 == t50, (t5, t50)
        assert t5["sessions"] == 10
        n = sum(range(1, 11))
        assert t5["input_tokens"] == n
        assert t5["output_tokens"] == 100 * n
        # but sessions[] respects the limit
        j5 = self.client.get(
            "/api/plugins/token-stats/ledger?days=0&limit=5").json()
        assert len(j5["sessions"]) == 5
        assert "totals" not in j5  # no totals without the param
        # window filter still applies to totals: since cuts old sessions.
        # s1 (state.db session, activity=1500) + s5..s10 (first_seen
        # 1005..1010) pass the since=1005 cut → 7 sessions.
        t_win = self.client.get(
            "/api/plugins/token-stats/ledger?days=0&totals=1"
            "&since=1005&limit=50").json()["totals"]
        assert t_win["sessions"] == 7

    def test_ledger_totals_absent_without_param(self):
        # Back-compat: default response has NO totals key.
        self.env.seed([{"sid": "s1", "known_in": 100}])
        j = self.client.get(
            "/api/plugins/token-stats/ledger?days=0").json()
        assert "totals" not in j

    def test_ledger_totals_session_id_scope(self):
        # Focus-session queries (chip): totals scope to that session.
        self.env.seed([
            {"sid": "s1", "known_in": 100},
            {"sid": "s2", "known_in": 200},
        ])
        j = self.client.get(
            "/api/plugins/token-stats/ledger?session_id=s2"
            "&days=0&totals=1").json()
        assert j["totals"]["sessions"] == 1
        assert j["totals"]["input_tokens"] == 200

    def test_unknown_profile_404(self):
        r = self.client.get(
            "/api/plugins/token-stats/ledger?profile=nope")
        assert r.status_code == 404
        j = r.json()["detail"]
        assert "available" in j and j["available"] == ["default"]

    def test_events(self):
        self.env.seed([{"sid": "s1", "known_in": 100}])
        db = sqlite3.connect(os.path.join(
            self.env.base, "default", "ledger.db"))
        db.execute(
            "INSERT INTO ledger_events (session_id, ts, kind, counter, "
            "last_db, db_now) VALUES ('s1', 1234.0, 'decrease', 'in', 100, 40)")
        db.commit()
        db.close()
        r = self.client.get(
            "/api/plugins/token-stats/events?session_id=s1")
        assert r.status_code == 200
        evs = r.json()["events"]
        assert evs and evs[0]["kind"] == "decrease" and evs[0]["counter"] == "in"
        assert evs[0]["last_db"] == 100 and evs[0]["db_now"] == 40

    def test_health_ok_after_seed(self):
        import time
        self.env.seed([
            {"sid": "s1", "known_in": 1, "last_poll": time.time()}])
        r = self.client.get("/api/plugins/token-stats/health")
        j = r.json()
        assert j["ok"] is True and j["rows"] >= 1 and j["last_poll"] > 0


if __name__ == "__main__":
    unittest.main()
