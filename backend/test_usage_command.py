"""Tests for the /tokenstats native plugin (backend/plugin_pkg/usage).

Builds a throwaway ledger DB, points LEDGER_BASE at it, and drives the
command handler end to end. No network, no Hermes core imports.
"""
import importlib.util
import json
import os
import re
import sqlite3
import tempfile
import time
import uuid

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
USAGE_PY = os.path.join(HERE, "plugin_pkg", "usage", "__init__.py")
SCHEMA = os.path.join(HERE, "ledger", "schema.sql")


@pytest.fixture()
def usage(tmp_path, monkeypatch):
    # Unique module name per test: _PRICE_CACHE is module-global, and reusing
    # one fixed name lets a stale sys.modules entry mask a pricing regression.
    name = "usage_plugin_test_" + uuid.uuid4().hex
    spec = importlib.util.spec_from_file_location(name, USAGE_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod._PRICE_CACHE = None
    monkeypatch.setattr(mod, "LEDGER_BASE", str(tmp_path))
    monkeypatch.setenv("LEDGER_BASE", str(tmp_path))
    # Isolate from the host state.db so window tests are deterministic.
    monkeypatch.setattr(mod, "_session_activity", lambda: {})
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
    assert seen["name"] == "tokenstats"
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


def test_window_filters_on_first_seen_not_last_poll(usage, tmp_path):
    """A session that STARTED outside the window must be excluded, even if
    last_poll (bumped by the daemon on delta) sits inside it.

    This is the B1 regression: windowing on last_poll kept weeks-old sessions
    in a 7-day view, carrying their whole lifetime counters.
    """
    old_start = time.time() - 40 * 86400
    _make_ledger(str(tmp_path), [
        # started 40d ago, last_poll 1h ago (a delta was seen recently)
        {"sid": "old", "model": "mistral-large-latest", "in": 5, "cached": 0,
         "out": 0, "calls": 1, "first_seen": old_start,
         "last_poll": time.time() - 3600},
        {"sid": "new", "model": "mistral-large-latest", "in": 7, "cached": 0,
         "out": 0, "calls": 1},
    ])
    recent = usage._handle_usage("7d")
    assert "sessions     1" in recent
    everything = usage._handle_usage("all")
    assert "sessions     2" in everything


def test_window_uses_state_db_activity_when_available(usage, tmp_path, monkeypatch):
    """state.db last_activity_at is the authoritative signal, as in the pane."""
    old = time.time() - 40 * 86400
    _make_ledger(str(tmp_path), [
        {"sid": "s", "model": "mistral-large-latest", "in": 5, "cached": 0,
         "out": 0, "calls": 1, "first_seen": old},
    ])
    # first_seen says 40d ago, but state.db says it was active a minute ago.
    monkeypatch.setattr(usage, "_session_activity",
                        lambda: {"s": time.time() - 60})
    assert "sessions     1" in usage._handle_usage("7d")


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
    assert "Usage: /tokenstats" in out


def test_help_flag(usage):
    assert "Usage: /tokenstats" in usage._handle_usage("--help")


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


def test_stale_heartbeat_reports_long_age(usage, tmp_path):
    _make_ledger(str(tmp_path), [
        {"sid": "s1", "model": "mistral-large-latest",
         "in": 1, "cached": 0, "out": 0, "calls": 1},
    ], heartbeat_age=9999)
    out = usage._handle_usage("")
    assert "heartbeat" in out.lower()
    # Format the age too: "heartbeat" alone is true on every render, so the
    # old assertion could not fail on a fresh heartbeat.
    assert "2.8h" in out, out


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
    """A model priced differently per provider must resolve per provider."""
    prices = usage._load_prices()
    sub = prices["provider"].get("openrouter") or {}
    assert sub, "no openrouter price table"
    # Pick a model that ALSO exists in the model-only table, so the two
    # branches are distinguishable (the old test picked the first key, which
    # had no model-only twin, making the second assertion None == None).
    overlapping = [m for m in sub if m in prices["model"]]
    model = overlapping[0]
    assert usage._price_for(model, "openrouter") == sub[model]
    assert usage._price_for(model, "some-other-provider") == prices["model"][model]
    # Nous is aliased to the OpenRouter catalog, as the client does.
    assert usage._price_for(model, "nous") == sub[model]


def test_cost_never_raises_without_price_table(usage, monkeypatch):
    monkeypatch.setattr(usage, "_PRICE_CACHE", {"model": {}, "provider": {}})
    assert usage._price_for("anything") is None
    assert usage._cost(1000, 0, 0, "anything") is None


def test_cutoff_today_is_midnight_today(usage):
    import time as t
    cutoff = t.localtime(usage._cutoff("1d"))
    now = t.localtime()
    assert (cutoff.tm_hour, cutoff.tm_min, cutoff.tm_sec) == (0, 0, 0)
    # And it is TODAY's midnight, not some other day's.
    assert (cutoff.tm_year, cutoff.tm_yday) == (now.tm_year, now.tm_yday)


def test_cutoff_workweek_is_monday(usage):
    import datetime as dt
    start = dt.datetime.fromtimestamp(usage._cutoff("5d"))
    assert start.weekday() == 0, "workweek must start on Monday"
    assert (start.hour, start.minute, start.second) == (0, 0, 0)


def test_cutoff_month_is_the_first(usage):
    import datetime as dt
    start = dt.datetime.fromtimestamp(usage._cutoff("30d"))
    assert start.day == 1
    assert (start.hour, start.minute) == (0, 0)


def test_5d_is_not_the_same_as_7d(usage):
    """5d is a calendar workweek, 7d is rolling — they must differ."""
    assert usage._cutoff("5d") != usage._cutoff("7d")


def test_cutoff_all_is_zero(usage):
    assert usage._cutoff("all") == 0.0


def test_prices_work_from_shipped_json_without_plugin_js(tmp_path, monkeypatch):
    """B2 regression: a pure CLI install has no plugin.js and no desktop
    plugin. The shipped prices.json must carry the table by itself.

    Copies the plugin to a bare directory (no repo, no desktop plugin) and
    asserts a real price still resolves.
    """
    import shutil
    dest = tmp_path / "installed"
    dest.mkdir()
    plugin_dir = os.path.join(HERE, "plugin_pkg", "usage")
    for name in ("__init__.py", "prices.json", "plugin.yaml"):
        shutil.copy(os.path.join(plugin_dir, name), dest / name)

    spec = importlib.util.spec_from_file_location(
        "usage_installed_" + uuid.uuid4().hex, str(dest / "__init__.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    # No repo plugin.js, no desktop plugin: this is the pure-CLI case.
    mod._PLUGIN_JS_CANDIDATES = ("/nonexistent/plugin.js",)
    mod._PRICE_CACHE = None

    prices = mod._load_prices()
    assert prices["model"], "shipped prices.json did not load"
    assert mod._price_for("mistral-large-latest") == (0.5, 0.05, 1.5)
    assert mod._price_for("mistral-large-latest", "nous") == (0.5, 0.05, 1.5)


def test_shipped_prices_json_matches_plugin_js(usage):
    """Drift guard: prices.json must equal what plugin.js says.

    Regenerate with scripts/gen_prices_usage.py when this fails.
    """
    import json
    here = os.path.dirname(os.path.abspath(__file__))
    js_path = os.path.join(here, "..", "plugin.js")
    if not os.path.exists(js_path):
        pytest.skip("plugin.js not present (installed layout)")
    with open(os.path.join(here, "plugin_pkg", "usage", "prices.json")) as fh:
        shipped = json.load(fh)
    with open(js_path, encoding="utf-8") as fh:
        src = fh.read()
    live = usage._js_prices(src, "PRICES")
    assert {k: list(v) for k, v in live.items()} == shipped["model"], (
        "prices.json is stale vs plugin.js — run scripts/gen_prices_usage.py")


# ── /tokenstats session ──────────────────────────────────────────────

def test_session_view_shows_this_sessions_rows(usage, tmp_path):
    """The session keyword filters the ledger to the calling session."""
    _make_ledger(str(tmp_path), [
        {"sid": "mine", "model": "mistral-large-latest",
         "in": 1_000_000, "cached": 0, "out": 0, "calls": 1},
        {"sid": "other", "model": "mistral-large-latest",
         "in": 9_000_000, "cached": 0, "out": 0, "calls": 9},
    ])
    out = usage._handle_usage("session", session_id="mine")
    assert "this session" in out
    assert "$0.50" in out          # 1M × $0.50/M — the OTHER row's $4.50 absent
    assert "$4.50" not in out
    assert "api calls    1" in out  # only this session's calls
    assert "mistral-large-latest" in out  # model row always shown


def test_session_view_multi_model_session(usage, tmp_path):
    _make_ledger(str(tmp_path), [
        {"sid": "s", "model": "mistral-large-latest",
         "in": 1_000_000, "cached": 0, "out": 0, "calls": 1},
        {"sid": "s", "model": "codestral-latest",
         "in": 1_000_000, "cached": 0, "out": 0, "calls": 2},
    ])
    out = usage._handle_usage("session", session_id="s")
    assert "mistral-large-latest" in out and "codestral-latest" in out
    assert "$0.30" in out          # codestral 1M in = $0.30


def test_session_view_unpriced_marked_approx(usage, tmp_path):
    _make_ledger(str(tmp_path), [
        {"sid": "s", "model": "mystery", "in": 1, "cached": 0, "out": 0, "calls": 1},
    ])
    out = usage._handle_usage("session", session_id="s")
    assert "no ledger rows" not in out
    assert "≈" in out
    assert "unpriced" in out


def test_session_view_unknown_session_explains(usage, tmp_path):
    _make_ledger(str(tmp_path), [])
    out = usage._handle_usage("session", session_id="never-seen")
    assert "no ledger rows" in out
    assert "daemon polls" in out  # the ~30s polling hint


def test_session_view_without_session_context(usage, tmp_path):
    """_handler called with no session_id (e.g. a surface without context):
    explain instead of rendering an empty block."""
    _make_ledger(str(tmp_path), [])
    out = usage._handle_usage("session")
    assert "no session context" in out


def test_session_view_core_dispatch_wiring(usage, tmp_path):
    """Core's invoke_plugin_command passes session_id via **kwargs — the exact
    call path a real /tokenstats dispatch takes. First positional param gets
    raw_args, declared keywords get the context."""
    _make_ledger(str(tmp_path), [
        {"sid": "dispatched", "model": "mistral-large-latest",
         "in": 2_000_000, "cached": 0, "out": 0, "calls": 2},
    ])
    # Use core's real dispatcher if importable; else mimic its contract.
    try:
        from hermes_cli.plugin_command_dispatch import invoke_plugin_command
    except ImportError:
        invoke_plugin_command = None
    if invoke_plugin_command is None:
        out = usage._handle_usage("session", session_id="dispatched")
    else:
        out = invoke_plugin_command(
            usage._handle_usage, "session",
            source=None, session_key="dispatched", session_id="dispatched",
            platform="local")
    assert "this session" in out
    assert "$1.00" in out  # 2M in × $0.50/M


def test_session_composes_with_profile(usage, tmp_path):
    """session + profile X reads that profile's ledger for the session."""
    _make_ledger(str(tmp_path), [])
    other = os.path.join(str(tmp_path), "trading")
    os.makedirs(other, exist_ok=True)
    conn = sqlite3.connect(os.path.join(other, "ledger.db"))
    with open(SCHEMA) as f:
        conn.executescript(f.read())
    conn.close()
    monkeypatch_hint = usage._handle_usage("session profile trading",
                                          session_id="x")
    assert "profile: trading" in monkeypatch_hint


# ── EUR mirror (USD + EUR in parentheses) ─────────────────────────────

def test_cost_line_shows_eur_mirror(usage, tmp_path):
    """Every cost line shows `(€Y.YY)` behind `$X.XX`, via the shared rate."""
    _make_ledger(str(tmp_path), [
        {"sid": "s1", "model": "mistral-large-latest",
         "in": 1_000_000, "cached": 0, "out": 0, "calls": 1},
    ])
    out = usage._handle_usage("")
    rate = usage._eur_rate()
    assert f"$0.50 (€{0.50 * rate:.2f})" in out


def test_models_breakdown_shows_eur_mirror(usage, tmp_path):
    _make_ledger(str(tmp_path), [
        {"sid": "s1", "model": "mistral-large-latest",
         "in": 1_000_000, "cached": 0, "out": 0, "calls": 1},
    ])
    out = usage._handle_usage("models")
    rate = usage._eur_rate()
    assert f"$0.50 (€{0.50 * rate:.2f})" in out  # also in the model row


def test_session_view_shows_eur_mirror(usage, tmp_path):
    _make_ledger(str(tmp_path), [
        {"sid": "s", "model": "mistral-large-latest",
         "in": 1_000_000, "cached": 0, "out": 0, "calls": 1},
    ])
    out = usage._handle_usage("session", session_id="s")
    rate = usage._eur_rate()
    assert f"$0.50 (€{0.50 * rate:.2f})" in out


def test_eur_rate_matches_plugin_js_constant(usage):
    """Drift guard: _eur_rate() must equal plugin.js EUR_RATE — the CLI
    must not grow a second hardcoded rate any more than a second price
    table. Fails stale when plugin.js changes without regenerating."""
    here = os.path.dirname(os.path.abspath(__file__))
    js_path = os.path.join(here, "..", "plugin.js")
    if not os.path.exists(js_path):
        pytest.skip("plugin.js not present (installed layout)")
    with open(js_path, encoding="utf-8") as fh:
        src = fh.read()
    m = re.search(r"const\s+EUR_RATE\s*=\s*(-?[\d.]+)", src)
    assert m, "plugin.js EUR_RATE constant not found"
    assert usage._eur_rate() == float(m.group(1))


def test_eur_rate_fallback_without_prices_json(monkeypatch):
    """No prices.json rate, no plugin.js: the documented fallback 0.85 (the
    plugin.js constant) keeps EUR rendering instead of crashing."""
    import importlib.util, shutil, uuid
    dest = tempfile.mkdtemp(prefix="usage_norate_")
    try:
        plugin_dir = os.path.join(HERE, "plugin_pkg", "usage")
        # prices.json copied but rate stripped, plugin.js unreachable
        with open(os.path.join(plugin_dir, "prices.json")) as fh:
            data = json.load(fh)
        data.pop("eur_rate", None)
        with open(os.path.join(dest, "prices.json"), "w") as fh:
            json.dump(data, fh)
        shutil.copy(os.path.join(plugin_dir, "__init__.py"),
                    os.path.join(dest, "__init__.py"))
        spec = importlib.util.spec_from_file_location(
            "usage_norate_" + uuid.uuid4().hex, os.path.join(dest, "__init__.py"))
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        monkeypatch.setattr(mod, "_PLUGIN_JS_CANDIDATES",
                            ("/nonexistent/plugin.js",), raising=False)
        monkeypatch.setattr(mod, "_PRICE_CACHE", None, raising=False)
        assert mod._eur_rate() == 0.85
        assert "(€" in mod._fmt_cost(1.0)
    finally:
        shutil.rmtree(dest, ignore_errors=True)
