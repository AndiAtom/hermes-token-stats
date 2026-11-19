"""Tests for the /usage native plugin (backend/plugin_pkg/usage).

Builds a throwaway ledger DB, points LEDGER_BASE at it, and drives the
command handler end to end. No network, no Hermes core imports.
"""
import importlib.util
import json
import os
import sqlite3
import time

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
USAGE_PY = os.path.join(HERE, "plugin_pkg", "usage", "__init__.py")
SCHEMA = os.path.join(HERE, "ledger", "schema.sql")


@pytest.fixture()
def usage(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("usage_plugin_test", USAGE_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "LEDGER_BASE", str(tmp_path))
    monkeypatch.setenv("LEDGER_BASE", str(tmp_path))
    return mod


def _make_ledger(base, rows, heartbeat_age=10.0):
    d = os.path.join(base, "default")
    os.makedirs(d, exist_ok=True)
    conn = sqlite3.connect(os.path.join(d, "ledger.db"))
    with open(SCHEMA) as f:
        conn.executescript(f.read())
    now = time.time()
    for r in rows:
        conn.execute(
            "INSERT INTO ledger_rows (session_id, model, billing_provider, "
            "billing_base_url, billing_mode, task, known_in, known_cached, "
            "known_out, known_calls, last_db_in, last_db_cached, last_db_out, "
            "last_db_calls, live_db_in, live_db_cached, live_db_out, "
            "live_db_calls, first_seen, last_poll) VALUES "
            "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (r["sid"], r["model"], r.get("provider", ""), "", "", "",
             r["in"], r["cached"], r["out"], r["calls"],
             r["in"], r["cached"], r["out"], r["calls"],
             r["in"], r["cached"], r["out"], r["calls"],
             r.get("first_seen", now), r.get("last_poll", now)),
        )
    conn.execute("INSERT INTO ledger_meta (key, value) VALUES ('heartbeat', ?)",
                 (now - heartbeat_age,))
    conn.commit()
    conn.close()


def test_registers_usage_command(usage):
    seen = {}

    class Ctx:
        def register_command(self, name, handler, **kw):
            seen["name"] = name
            seen["handler"] = handler
            seen["kw"] = kw

    usage.register(Ctx())
    assert seen["name"] == "usage"
    assert seen["kw"]["description"]
    assert "args_hint" in seen["kw"]
    assert callable(seen["handler"])


def test_missing_ledger_explains_instead_of_raising(usage, tmp_path):
    out = usage._handle_usage("")
    assert "no ledger" in out.lower()
    assert "install" in out.lower()


def test_totals_and_cache_hit_rate(usage, tmp_path):
    _make_ledger(str(tmp_path), [
        {"sid": "s1", "model": "mistral-large-latest",
         "in": 1_000_000, "cached": 4_000_000, "out": 500_000, "calls": 10},
    ])
    out = usage._handle_usage("")
    assert "sessions" in out
    # 4M cached of 5M prompt = 80.0% hit
    assert "80.0% hit" in out
    assert "api calls" in out


def test_priced_model_contributes_cost(usage, tmp_path):
    _make_ledger(str(tmp_path), [
        {"sid": "s1", "model": "mistral-large-latest",
         "in": 1_000_000, "cached": 0, "out": 0, "calls": 1},
    ])
    out = usage._handle_usage("")
    # mistral-large-latest input is $0.50/M in the canonical table
    assert "$0.50" in out
    assert "≈" not in out


def test_unpriced_model_is_excluded_not_fabricated(usage, tmp_path):
    _make_ledger(str(tmp_path), [
        {"sid": "s1", "model": "totally-unknown-model",
         "in": 1_000_000, "cached": 0, "out": 0, "calls": 1},
    ])
    out = usage._handle_usage("")
    assert "≈" in out
    assert "$0.00" in out          # zero from priced rows, nothing invented
    assert "unpriced" in out.lower()


def test_mixed_pricing_sums_only_priced_rows(usage, tmp_path):
    _make_ledger(str(tmp_path), [
        {"sid": "s1", "model": "mistral-large-latest",
         "in": 1_000_000, "cached": 0, "out": 0, "calls": 1},
        {"sid": "s2", "model": "mystery-model",
         "in": 9_000_000, "cached": 0, "out": 0, "calls": 9},
    ])
    out = usage._handle_usage("")
    assert "$0.50" in out
    assert "≈" in out


def test_zero_tokens_free_model_is_zero(usage, tmp_path):
    _make_ledger(str(tmp_path), [
        {"sid": "s1", "model": "mistral-large-latest",
         "in": 0, "cached": 0, "out": 0, "calls": 0},
    ])
    out = usage._handle_usage("")
    assert "$0.00" in out


def test_window_filters_out_old_rows(usage, tmp_path):
    old = time.time() - 40 * 86400
    _make_ledger(str(tmp_path), [
        {"sid": "old", "model": "mistral-large-latest", "in": 5, "cached": 0,
         "out": 0, "calls": 1, "last_poll": old},
        {"sid": "new", "model": "mistral-large-latest", "in": 7, "cached": 0,
         "out": 0, "calls": 1},
    ])
    recent = usage._handle_usage("7d")
    assert "sessions     1" in recent
    everything = usage._handle_usage("all")
    assert "sessions     2" in everything


def test_models_breakdown_lists_each_model(usage, tmp_path):
    _make_ledger(str(tmp_path), [
        {"sid": "s1", "model": "mistral-large-latest",
         "in": 1_000_000, "cached": 0, "out": 0, "calls": 3},
        {"sid": "s2", "model": "codestral-latest",
         "in": 2_000_000, "cached": 0, "out": 0, "calls": 4},
    ])
    out = usage._handle_usage("models")
    assert "mistral-large-latest" in out
    assert "codestral-latest" in out
    # codestral-latest input is $0.30/M -> 2M = $0.60
    assert "$0.50" in out and "$0.60" in out


def test_profile_argument_selects_other_ledger(usage, tmp_path):
    _make_ledger(str(tmp_path), [])
    other = os.path.join(str(tmp_path), "trading")
    os.makedirs(other, exist_ok=True)
    conn = sqlite3.connect(os.path.join(other, "ledger.db"))
    with open(SCHEMA) as f:
        conn.executescript(f.read())
    conn.close()
    out = usage._handle_usage("profile trading")
    assert "profile: trading" in out
    assert "no ledger" not in out.lower()


def test_unknown_profile_lists_known_ones(usage, tmp_path):
    _make_ledger(str(tmp_path), [])
    out = usage._handle_usage("profile nope")
    assert "no ledger" in out.lower()
    assert "default" in out


def test_unknown_argument_shows_help(usage):
    out = usage._handle_usage("wat")
    assert "unknown argument" in out.lower()
    assert "Usage: /usage" in out


def test_help_flag(usage):
    assert "Usage: /usage" in usage._handle_usage("--help")


def test_handler_never_raises(usage, tmp_path, monkeypatch):
    _make_ledger(str(tmp_path), [])
    monkeypatch.setattr(usage, "_render",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    out = usage._handle_usage("")
    assert "internal error" in out.lower()


def test_corrupt_ledger_does_not_raise(usage, tmp_path):
    d = os.path.join(str(tmp_path), "default")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "ledger.db"), "wb") as f:
        f.write(b"this is not a sqlite database at all" * 10)
    out = usage._handle_usage("")
    assert out.startswith("Token Stats")


def test_stale_heartbeat_warns(usage, tmp_path):
    _make_ledger(str(tmp_path), [
        {"sid": "s1", "model": "mistral-large-latest",
         "in": 1, "cached": 0, "out": 0, "calls": 1},
    ], heartbeat_age=9999)
    out = usage._handle_usage("")
    assert "heartbeat" in out.lower()


def test_price_prefix_match_dates(usage):
    # Prices come from plugin.js, the clients' source of truth.
    base = usage._price_for("mistral-large-latest")
    assert base is not None, "price table did not load from plugin.js"
    assert usage._price_for("mistral-large-latest-2411") == base
    assert usage._price_for("totally-made-up-model") is None


def test_prices_come_from_plugin_js_not_a_copy(usage):
    """Drift guard: the CLI must read the same table the UI uses.

    If /usage ever grows its own hardcoded table again, this fails as soon as
    the two disagree — which is exactly how the first draft shipped a
    mistral-large-latest price 4x the real one.
    """
    prices = usage._load_prices()
    assert prices["model"], "no prices parsed out of plugin.js"
    # Spot-check values that only exist in the canonical table.
    assert usage._price_for("mistral-large-latest") == (0.5, 0.05, 1.5)
    assert usage._price_for("deepseek-v4-1-flash-1017") == (0.3, 0.007, 1.2)
    # The generated OpenRouter catalog is parsed too.
    assert prices["provider"].get("openrouter"), "OpenRouter table missing"


def test_provider_scoped_price_wins_over_model_only(usage):
    prices = usage._load_prices()
    sub = prices["provider"].get("openrouter") or {}
    model = next(iter(sub))
    # Provider match is used when the provider key matches exactly.
    assert usage._price_for(model, "openrouter") == sub[model]
    # An unknown provider falls through to the model-only table.
    assert usage._price_for(model, "some-other-provider") == prices["model"].get(model)


def test_cost_never_raises_without_price_table(usage, monkeypatch):
    monkeypatch.setattr(usage, "_PRICE_CACHE", {"model": {}, "provider": {}})
    assert usage._price_for("anything") is None
    assert usage._cost(1000, 0, 0, "anything") is None


def test_cutoff_today_is_midnight(usage):
    import time as t
    cutoff = usage._cutoff("1d")
    assert t.localtime(cutoff).tm_hour == 0
    assert t.localtime(cutoff).tm_min == 0


def test_cutoff_all_is_zero(usage):
    assert usage._cutoff("all") == 0.0
