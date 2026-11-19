"""``/tokenstats`` — token totals and cost from the token-stats known ledger.

Head-up CLI view for users who never open the desktop pane. Reads the
ledger DB directly (``mode=ro``), so it needs no gateway route and no
``ctx.rest`` — the native plugin and the desktop chip therefore read the
same ledger, though the chip additionally applies the pane's UI-only
settings (user price overrides, the EU region factor and the EUR display
default); this command always reports USD list price.

Windows mirror the pane's calendar presets: ``1d`` (today, since local
midnight), ``5d`` (this workweek, Mon 00:00), ``30d`` (this calendar month,
since the 1st), plus ``all`` (whole ledger) and one intentionally rolling
preset, ``7d`` (the default). Because a slash command has no focused
session, the default is an aggregate over the window rather than the
chip's per-session reading.

Window attribution uses real session activity — ``last_activity_at`` from
state.db, falling back to the ledger's ``first_seen`` — exactly as the pane
does. It deliberately does NOT use the ledger's ``last_poll``: the engine
bumps that only when a counter moves, so for a quiet session it is neither
"last activity" nor "last poll" but "last poll that saw a delta", which
would keep weeks-old sessions inside a 7-day window.

Cost is computed from the same price tables the desktop chip and pane use
— parsed out of the shipped ``plugin.js`` rather than duplicated here, so
CLI and UI cannot disagree. Unpriced models stay ``—`` and are excluded
from the total (marked ``≈``) instead of contributing a fabricated number.
"""
from __future__ import annotations

import datetime
import logging
import os
import sqlite3
import time
from typing import Optional

logger = logging.getLogger(__name__)

LEDGER_BASE = os.path.expanduser(os.environ.get("LEDGER_BASE", "~/token-stats-ledger"))

# Price source of truth: plugin.js. The desktop plugin owns the canonical
# PRICES / PRICES_PROVIDER tables, and the CLI must not fork them — a second
# hardcoded copy silently drifts and the CLI then reports different costs than
# the pane for the same ledger.
#
# Resolution order:
#   1. prices.json next to THIS file — generated from plugin.js by
#      scripts/gen_prices_usage.py and shipped with the plugin. This is the
#      only candidate that exists for a pure CLI install (no desktop plugin,
#      no repo checkout), which is the audience /tokenstats is FOR.
#   2. plugin.js parsed live — repo checkouts and machines with the desktop
#      plugin installed, so a developer editing prices sees the change
#      immediately without regenerating.
# Parsed once per process.
_HERE = os.path.dirname(os.path.abspath(__file__))

_PLUGIN_JS_CANDIDATES = (
    os.path.join(_HERE, "..", "..", "..", "plugin.js"),          # repo layout
    os.path.join(os.path.expanduser("~"), ".hermes", "desktop-plugins",
                 "token-stats", "plugin.js"),                    # desktop install
)

_PRICE_CACHE: Optional[dict] = None


def _js_prices(src: str, const: str) -> dict:
    """Parse ``const <const> = { ... }`` into {model: (in, cached, out)}.

    Fallback only — the shipped prices.json is preferred. Strict on purpose:
    anything that does not match is skipped rather than guessed, so a future
    JS syntax change degrades to "fewer priced models", never to wrong prices.
    """
    import re

    start = src.find("const " + const + " = {")
    if start < 0:
        return {}
    end = src.find("\n}", start)
    if end < 0:
        return {}
    block = src[start:end]
    row = re.compile(
        r"'([^']+)'\s*:\s*\{\s*input:\s*(-?[\d.]+)\s*,\s*"
        r"cached:\s*(-?[\d.]+)\s*,\s*output:\s*(-?[\d.]+)\s*\}"
    )
    out = {}
    for m in row.finditer(block):
        try:
            out[m.group(1)] = (float(m.group(2)), float(m.group(3)), float(m.group(4)))
        except ValueError:
            continue
    return out


def _normalize(raw: dict) -> dict:
    """JSON lists -> tuples, and validate the shape."""
    model = {k: tuple(float(x) for x in v) for k, v in (raw.get("model") or {}).items()}
    prov = {}
    for name, sub in (raw.get("provider") or {}).items():
        if isinstance(sub, dict) and sub:
            prov[name] = {k: tuple(float(x) for x in v) for k, v in sub.items()}
    return {"model": model, "provider": prov}


def _load_prices() -> dict:
    """{'model': {...}, 'provider': {provider: {model: {...}}}}.

    Cached only when non-empty: a long-lived process that starts before the
    desktop plugin exists must not pin an empty table forever.
    """
    global _PRICE_CACHE
    if _PRICE_CACHE:
        return _PRICE_CACHE

    # 1. Shipped JSON (always present in a deployed plugin).
    try:
        import json
        with open(os.path.join(_HERE, "prices.json"), encoding="utf-8") as fh:
            data = _normalize(json.load(fh))
        if data["model"]:
            _PRICE_CACHE = data
            return data
    except (OSError, ValueError):
        logger.debug("usage: prices.json unreadable, falling back to plugin.js",
                     exc_info=True)

    # 2. Parse plugin.js live.
    src = ""
    for cand in _PLUGIN_JS_CANDIDATES:
        try:
            with open(os.path.normpath(cand), encoding="utf-8") as fh:
                src = fh.read()
            break
        except OSError:
            continue

    model = _js_prices(src, "PRICES")
    providers = {}
    for name, const in (("openrouter", "PRICES_OPENROUTER"),
                        ("nous", "PRICES_NOUS")):
        sub = _js_prices(src, const)
        if sub:
            providers[name] = sub
    # The client aliases PRICES_PROVIDER.nous -> PRICES_OPENROUTER when there
    # is no dedicated Nous table; mirror that so Nous rows price like the UI.
    if "nous" not in providers and "openrouter" in providers:
        providers["nous"] = dict(providers["openrouter"])

    _PRICE_CACHE = {"model": model, "provider": providers}
    if not model:
        logger.debug("usage: no price table found (prices.json and plugin.js "
                     "both unavailable) — cost will render —")
    return _PRICE_CACHE

WINDOWS = {
    "1d": ("today", "calendar"),
    "5d": ("this workweek", "workweek"),
    "7d": ("last 7 days", "rolling7"),
    "30d": ("this month", "month"),
    "all": ("all time", "all"),
}

HELP = """Usage: /tokenstats [1d|5d|7d|30d|all] [models] [session] [profile NAME]

  /tokenstats            token totals for the last 7 days (default)
  /tokenstats 1d         today only (since local midnight)
  /tokenstats 5d         this workweek (since Mon 00:00)
  /tokenstats 30d        this calendar month (since the 1st)
  /tokenstats models     per-model breakdown for the window
  /tokenstats session    THIS session only (the CLI session you are in)
  /tokenstats profile X  read ledger profile X instead of 'default'
"""


def _ledger_path(profile: str) -> str:
    return os.path.join(LEDGER_BASE, profile, "ledger.db")


def _profiles() -> list[str]:
    if not os.path.isdir(LEDGER_BASE):
        return []
    return sorted(
        d for d in os.listdir(LEDGER_BASE)
        if os.path.exists(os.path.join(LEDGER_BASE, d, "ledger.db"))
    )


def _connect(path: str) -> Optional[sqlite3.Connection]:
    """Read-only handle. Never creates the DB, never blocks the daemon."""
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5.0)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error:
        logger.debug("usage: cannot open %s", path, exc_info=True)
        return None


def _heartbeat_age(conn: sqlite3.Connection) -> Optional[float]:
    """Seconds since the daemon last polled; None when never seen."""
    try:
        row = conn.execute(
            "SELECT value FROM ledger_meta WHERE key = 'heartbeat'"
        ).fetchone()
    except sqlite3.Error:
        return None
    return (time.time() - row["value"]) if row else None


def _cutoff(window: str) -> float:
    """Epoch cutoff for the window. 0 = no cutoff (whole ledger).

    Calendar semantics, matching the pane's presets:
      1d  -> local midnight today
      5d  -> Monday 00:00 of the current week
      7d  -> rolling 7 days (the one intentionally rolling preset)
      30d -> the 1st of the current month, local midnight
      all -> no cutoff

    Built with datetime rather than time.mktime: mktime on a 9-tuple is
    DST-fragile and can land an hour off on transition days.
    """
    kind = WINDOWS[window][1]
    now = datetime.datetime.now()
    if kind == "all":
        return 0.0
    if kind == "calendar":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif kind == "workweek":
        start = (now - datetime.timedelta(days=now.weekday())).replace(
            hour=0, minute=0, second=0, microsecond=0)
    elif kind == "month":
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    else:  # rolling7
        return time.time() - 7 * 86400
    return start.timestamp()


def _fmt_int(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def _price_for(model: str, provider: str = "") -> Optional[tuple[float, float, float]]:
    """Resolve a price the same way the clients' estimateCost() does.

    Order: PRICES_PROVIDER[provider][model] → PRICES[model] → None.
    Provider keys match billing_provider EXACTLY (no prefix match), matching
    the documented client behavior; model ids fall back to longest-prefix so
    dated variants (…-2411) price like their base id.
    """
    prices = _load_prices()
    if provider:
        sub = prices["provider"].get(provider)
        if sub and model in sub:
            return sub[model]
    table = prices["model"]
    if model in table:
        return table[model]
    for key in sorted(table, key=len, reverse=True):
        if model.startswith(key):
            return table[key]
    return None


def _cost(inp: int, cached: int, out: int, model: str,
          provider: str = "") -> Optional[float]:
    p = _price_for(model, provider)
    if p is None:
        return None
    pin, pcached, pout = p
    return (inp / 1e6) * pin + (cached / 1e6) * pcached + (out / 1e6) * pout


def _rows(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Every ledger row. Window filtering happens on REAL activity, below."""
    return conn.execute(
        "SELECT session_id, model, billing_provider, task, known_in, "
        "known_cached, known_out, known_calls, first_seen, last_poll "
        "FROM ledger_rows"
    ).fetchall()


def _session_activity() -> dict:
    """session_id -> last_activity_at from state.db, read-only.

    This is what the pane uses (plugin_api._session_meta) and what the clients
    treat as the real activity signal. The ledger's own last_poll is NOT
    usable for windowing: engine.py bumps it only on a dirty counter and
    freezes it otherwise, so it is neither "last activity" nor "last poll" —
    it is "last poll that observed a delta". Using it made the 7d window keep
    sessions that started weeks earlier, with their whole lifetime counters.
    Missing state.db (a pure-ledger profile) -> empty map, caller falls back
    to first_seen.
    """
    out: dict = {}
    state_db = os.path.expanduser(
        os.environ.get("LEDGER_STATE_DB", "~/.hermes/state.db"))
    if not os.path.exists(state_db):
        return out
    try:
        conn = sqlite3.connect(f"file:{state_db}?mode=ro", uri=True, timeout=5.0)
        conn.row_factory = sqlite3.Row
    except sqlite3.Error:
        return out
    try:
        for r in conn.execute(
            "SELECT id, COALESCE(last_activity_at, ended_at, started_at, 0) "
            "AS last_active FROM sessions"
        ):
            val = r["last_active"]
            if val:
                out[r["id"]] = float(val)
    except sqlite3.Error:
        logger.debug("usage: state.db session activity query failed", exc_info=True)
    finally:
        conn.close()
    return out


def _render(window: str, want_models: bool, profile: str) -> str:
    path = _ledger_path(profile)
    if not os.path.exists(path):
        others = _profiles()
        hint = f"\n  known profiles: {', '.join(others)}" if others else ""
        return (
            f"Token Stats: no ledger for profile '{profile}'.\n"
            f"  expected: {path}{hint}\n"
            "  install the ledger daemon first (backend/install.sh), or set LEDGER_BASE."
        )

    conn = _connect(path)
    if conn is None:
        return f"Token Stats: ledger at {path} is unreadable (permissions?)."

    try:
        cutoff = _cutoff(window)
        all_rows = _rows(conn)
        age = _heartbeat_age(conn)
    except sqlite3.Error as exc:
        return f"Token Stats: ledger query failed ({exc})."
    finally:
        conn.close()

    # Window on REAL session activity (state.db last_activity_at), falling
    # back to the ledger's first_seen for sessions state.db no longer knows.
    # Never on last_poll — see _session_activity().
    activity = _session_activity()
    rows = []
    for r in all_rows:
        when = activity.get(r["session_id"]) or r["first_seen"] or 0
        if not cutoff or when >= cutoff:
            rows.append(r)

    label = WINDOWS[window][0]
    lines = [f"Token Stats — {label} (profile: {profile})", "─" * 46]

    if not rows:
        lines.append("  no usage recorded in this window")
        if age is not None and age > 300:
            lines.append(f"  (daemon last polled {_fmt_age(age)} ago — is it running?)")
        return "\n".join(lines)

    total_in = sum(r["known_in"] or 0 for r in rows)
    total_cached = sum(r["known_cached"] or 0 for r in rows)
    total_out = sum(r["known_out"] or 0 for r in rows)
    total_calls = sum(r["known_calls"] or 0 for r in rows)
    sessions = len({r["session_id"] for r in rows})

    # Aggregated cost per (model, provider) group — a model is either priced
    # or not; provider-scoped prices win over model-only, as in the clients.
    cost_total = 0.0
    unpriced = False
    groups: dict[tuple[str, str], list] = {}
    for r in rows:
        key = (r["model"], r["billing_provider"] or "")
        acc = groups.setdefault(key, [0, 0, 0, 0])
        acc[0] += r["known_in"] or 0
        acc[1] += r["known_cached"] or 0
        acc[2] += r["known_out"] or 0
        acc[3] += r["known_calls"] or 0
    for (model, provider), (i, ca, o, _calls) in groups.items():
        c = _cost(i, ca, o, model, provider)
        if c is None:
            unpriced = True
        else:
            cost_total += c

    prompt = total_in + total_cached
    hit = (total_cached / prompt * 100) if prompt else 0.0

    lines.append(f"  {'sessions':<12} {sessions}")
    lines.append(f"  {'input':<12} {_fmt_int(total_in)}")
    lines.append(f"  {'cached':<12} {_fmt_int(total_cached)}  ({hit:.1f}% hit)")
    lines.append(f"  {'output':<12} {_fmt_int(total_out)}")
    lines.append(f"  {'tokens':<12} {_fmt_int(prompt + total_out)}")
    lines.append(f"  {'api calls':<12} {total_calls}")
    approx = "≈" if unpriced else ""
    lines.append(f"  {'cost':<12} {approx}${cost_total:.2f}")

    if want_models:
        lines.append("─" * 46)
        # Group by (model, provider) so a provider-scoped price is used —
        # the same model can cost differently on different providers.
        # The token column is in+cached+out, which is why a cheap-per-token
        # but heavily-cached model can dominate a row with a small cost.
        per: dict[tuple[str, str], list] = {}
        for r in rows:
            key = (r["model"], r["billing_provider"] or "")
            acc = per.setdefault(key, [0, 0, 0, 0])
            acc[0] += r["known_in"] or 0
            acc[1] += r["known_cached"] or 0
            acc[2] += r["known_out"] or 0
            acc[3] += r["known_calls"] or 0
        lines.append(f"  {'model':<24} {'tokens':>8} {'calls':>5} {'cost':>8}")
        for (model, provider) in sorted(
            per, key=lambda k: -(per[k][0] + per[k][1] + per[k][2])
        ):
            i, ca, o, calls = per[(model, provider)]
            c = _cost(i, ca, o, model, provider)
            cost = f"${c:.2f}" if c is not None else "—"
            lines.append(
                f"  {model[:24]:<24} {_fmt_int(i + ca + o):>8} {calls:>5} {cost:>8}"
            )

    if unpriced:
        lines.append("  ≈ unpriced models excluded from the cost total")
    if age is not None:
        lines.append(f"  ledger heartbeat: {_fmt_age(age)} ago")
    return "\n".join(lines)


def _fmt_age(seconds: float) -> str:
    if seconds < 90:
        return f"{int(seconds)}s"
    if seconds < 5400:
        return f"{int(seconds / 60)}m"
    return f"{seconds / 3600:.1f}h"


def _render_session(session_id: str, want_models: bool, profile: str) -> str:
    """Per-session view for ``/tokenstats session`` — the CLI twin of the chip.

    Same ledger, same price resolution as the aggregate view, restricted to
    the rows of ONE session (the one the command runs in, injected by core's
    plugin_command_dispatch as the ``session_id`` context keyword).
    """
    if not session_id:
        return (
            "Token Stats: no session context on this surface —\n"
            "  /tokenstats session needs the session it is typed in.\n"
            "  Aggregate windows work everywhere: try /tokenstats 7d"
        )
    path = _ledger_path(profile)
    if not os.path.exists(path):
        others = _profiles()
        hint = f"\n  known profiles: {', '.join(others)}" if others else ""
        return (
            f"Token Stats: no ledger for profile '{profile}'.\n"
            f"  expected: {path}{hint}\n"
            "  install the ledger daemon first (backend/install.sh), or set LEDGER_BASE."
        )
    conn = _connect(path)
    if conn is None:
        return f"Token Stats: ledger at {path} is unreadable (permissions?)."
    try:
        all_rows = _rows(conn)
        age = _heartbeat_age(conn)
    except sqlite3.Error as exc:
        return f"Token Stats: ledger query failed ({exc})."
    finally:
        conn.close()

    rows = [r for r in all_rows if r["session_id"] == session_id]
    short = session_id[:12] + "…" if len(session_id) > 12 else session_id
    lines = [f"Token Stats — this session ({short}, profile: {profile})",
             "─" * 46]

    if not rows:
        lines.append("  no ledger rows for this session yet")
        lines.append("  (the daemon polls every ~30s — first tokens can take a minute)")
        if age is not None:
            lines.append(f"  ledger heartbeat: {_fmt_age(age)} ago")
        return "\n".join(lines)

    total_in = sum(r["known_in"] or 0 for r in rows)
    total_cached = sum(r["known_cached"] or 0 for r in rows)
    total_out = sum(r["known_out"] or 0 for r in rows)
    total_calls = sum(r["known_calls"] or 0 for r in rows)

    # Same (model, provider) grouping and price resolution as the aggregate.
    cost_total = 0.0
    unpriced = False
    groups: dict[tuple[str, str], list] = {}
    for r in rows:
        key = (r["model"], r["billing_provider"] or "")
        acc = groups.setdefault(key, [0, 0, 0, 0])
        acc[0] += r["known_in"] or 0
        acc[1] += r["known_cached"] or 0
        acc[2] += r["known_out"] or 0
        acc[3] += r["known_calls"] or 0
    for (model, provider), (i, ca, o, _calls) in groups.items():
        c = _cost(i, ca, o, model, provider)
        if c is None:
            unpriced = True
        else:
            cost_total += c

    prompt = total_in + total_cached
    hit = (total_cached / prompt * 100) if prompt else 0.0

    lines.append(f"  {'input':<12} {_fmt_int(total_in)}")
    lines.append(f"  {'cached':<12} {_fmt_int(total_cached)}  ({hit:.1f}% hit)")
    lines.append(f"  {'output':<12} {_fmt_int(total_out)}")
    lines.append(f"  {'tokens':<12} {_fmt_int(prompt + total_out)}")
    lines.append(f"  {'api calls':<12} {total_calls}")
    approx = "≈" if unpriced else ""
    lines.append(f"  {'cost':<12} {approx}${cost_total:.2f}")

    # Always show the model breakdown for a session — a session is usually
    # single-model, and the cost claim is only checkable with the row visible.
    lines.append("─" * 46)
    lines.append(f"  {'model':<24} {'tokens':>8} {'calls':>5} {'cost':>8}")
    for (model, provider) in sorted(
        groups, key=lambda k: -(groups[k][0] + groups[k][1] + groups[k][2])
    ):
        i, ca, o, calls = groups[(model, provider)]
        c = _cost(i, ca, o, model, provider)
        cost = f"${c:.2f}" if c is not None else "—"
        lines.append(
            f"  {model[:24]:<24} {_fmt_int(i + ca + o):>8} {calls:>5} {cost:>8}"
        )
    if unpriced:
        lines.append("  ≈ unpriced models excluded from the cost total")
    if age is not None:
        lines.append(f"  ledger heartbeat: {_fmt_age(age)} ago")
    return "\n".join(lines)


def _handle_usage(raw_args: str = "", **kwargs) -> str:
    """Render the ``/tokenstats`` block. Never raises: every failure becomes a line.

    Core's plugin_command_dispatch passes ``session_id`` (plus ``source``,
    ``session_key``, ``platform``) as context keywords when the handler declares
    them — either explicitly or via ``**kwargs`` — so the session view works on
    every surface (TUI, gateway, CLI) without any plugin-side plumbing.
    """
    try:
        tokens = (raw_args or "").split()
        window = "7d"
        want_models = False
        want_session = False
        profile = "default"

        i = 0
        while i < len(tokens):
            tok = tokens[i].lower()
            if tok in {"-h", "--help", "help"}:
                return HELP
            if tok in WINDOWS:
                window = tok
            elif tok in {"models", "all-models", "-m"}:
                want_models = True
            elif tok == "session":
                want_session = True
            elif tok == "profile":
                if i + 1 >= len(tokens):
                    return "Token Stats: 'profile' needs a name.\n\n" + HELP
                profile = tokens[i + 1]
                i += 1
            else:
                return f"Token Stats: unknown argument '{tokens[i]}'.\n\n" + HELP
            i += 1

        if want_session:
            sid = str(kwargs.get("session_id") or "")
            return _render_session(sid, want_models, profile)
        return _render(window, want_models, profile)
    except Exception as exc:  # noqa: BLE001 — a slash command must never raise
        logger.debug("usage: handler failed", exc_info=True)
        return f"Token Stats: internal error ({exc})."


def register(ctx) -> None:
    ctx.register_command(
        "tokenstats",
        _handle_usage,
        description="Token totals and cost from the token-stats ledger",
        args_hint="[1d|5d|7d|30d|all|session] [models] [profile NAME]",
    )
