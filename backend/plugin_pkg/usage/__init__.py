"""``/usage`` — token totals and cost from the token-stats known ledger.

Head-up CLI view for users who never open the desktop pane. Reads the
ledger DB directly (``mode=ro``), so it needs no gateway route and no
``ctx.rest`` — the native plugin and the desktop chip therefore report
the same numbers from the same source.

Windows mirror the pane's calendar presets: ``1d`` (today), ``5d``
(workweek), ``7d`` (default, calendar week) and ``30d`` (running month),
plus ``all`` (whole ledger). Because a slash command has no focused
session, the default is an aggregate over the window rather than the
chip's per-session reading.

Cost is computed from the same price tables the desktop chip and pane use
— parsed out of the shipped ``plugin.js`` rather than duplicated here, so
CLI and UI cannot disagree. Unpriced models stay ``—`` and are excluded
from the total (marked ``≈``) instead of contributing a fabricated number.
"""
from __future__ import annotations

import logging
import os
import sqlite3
import time
from typing import Optional

logger = logging.getLogger(__name__)

LEDGER_BASE = os.path.expanduser(os.environ.get("LEDGER_BASE", "~/token-stats-ledger"))

# Price source of truth: plugin.js. The desktop plugin owns the canonical
# PRICES / PRICES_PROVIDER tables (and PRICES_OPENROUTER / PRICES_NOUS), and
# the CLI must not fork them — a second hardcoded copy silently drifts and
# the CLI then reports different costs than the pane for the same ledger.
# We parse the shipped JS object literals instead. Parsed once, cached.
_PLUGIN_JS_CANDIDATES = (
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 "..", "..", "..", "plugin.js"),          # repo layout
    os.path.join(os.path.expanduser("~"), ".hermes", "desktop-plugins",
                 "token-stats", "plugin.js"),              # installed layout
)

_PRICE_CACHE: Optional[dict] = None


def _js_prices(src: str, const: str) -> dict:
    """Parse ``const <const> = { ... }`` into {model: (in, cached, out)}.

    Looks for `'model': { input: N, cached: N, output: N }` rows. Deliberately
    strict: anything that does not match is skipped rather than guessed, so a
    future JS syntax change degrades to "fewer priced models", never to wrong
    prices.
    """
    import re

    start = src.find("const " + const + " = {")
    if start < 0:
        return {}
    # Scan to the matching closing brace at column 0.
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


def _load_prices() -> dict:
    """{'model': {...}, 'provider': {provider: {model: {...}}}} — cached."""
    global _PRICE_CACHE
    if _PRICE_CACHE is not None:
        return _PRICE_CACHE

    src = ""
    for cand in _PLUGIN_JS_CANDIDATES:
        try:
            with open(os.path.normpath(cand), encoding="utf-8") as fh:
                src = fh.read()
            break
        except OSError:
            continue

    table = _js_prices(src, "PRICES")
    providers = {}
    for name, const in (("openrouter", "PRICES_OPENROUTER"),
                        ("nous", "PRICES_NOUS")):
        sub = _js_prices(src, const)
        if sub:
            providers[name] = sub

    _PRICE_CACHE = {"model": table, "provider": providers}
    if not table:
        logger.debug("usage: no price table parsed from plugin.js — cost shows —")
    return _PRICE_CACHE

WINDOWS = {
    "1d": ("today", 1, True),
    "5d": ("workweek", 7, False),
    "7d": ("last 7 days", 7, False),
    "30d": ("running month", 30, False),
    "all": ("all time", 0, False),
}

HELP = """Usage: /usage [1d|5d|7d|30d|all] [models] [profile NAME]

  /usage            token totals for the last 7 days (default)
  /usage 1d         today only
  /usage models     per-model breakdown for the window
  /usage profile X  read ledger profile X instead of 'default'
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
    """Epoch cutoff for the window. 0 = no cutoff (whole ledger)."""
    label, days, today_only = WINDOWS[window]
    if not days:
        return 0.0
    if today_only:
        lt = time.localtime()
        return time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
    return time.time() - days * 86400


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


def _rows(conn: sqlite3.Connection, cutoff: float) -> list[sqlite3.Row]:
    sql = (
        "SELECT session_id, model, billing_provider, task, known_in, "
        "known_cached, known_out, known_calls, last_poll FROM ledger_rows"
    )
    params: tuple = ()
    if cutoff:
        # Rows are pruned by last_poll window: recent activity only.
        sql += " WHERE last_poll >= ?"
        params = (cutoff,)
    return conn.execute(sql, params).fetchall()


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
        rows = _rows(conn, cutoff)
        age = _heartbeat_age(conn)
    except sqlite3.Error as exc:
        return f"Token Stats: ledger query failed ({exc})."
    finally:
        conn.close()

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
        per: dict[tuple[str, str], list] = {}
        for r in rows:
            key = (r["model"], r["billing_provider"] or "")
            acc = per.setdefault(key, [0, 0, 0, 0])
            acc[0] += r["known_in"] or 0
            acc[1] += r["known_cached"] or 0
            acc[2] += r["known_out"] or 0
            acc[3] += r["known_calls"] or 0
        for (model, provider) in sorted(
            per, key=lambda k: -(per[k][0] + per[k][1] + per[k][2])
        ):
            i, ca, o, calls = per[(model, provider)]
            c = _cost(i, ca, o, model, provider)
            cost = f"${c:.2f}" if c is not None else "—"
            lines.append(
                f"  {model[:26]:<26} {_fmt_int(i + ca + o):>8} {calls:>6} {cost:>8}"
            )
        lines.append("─" * 46)

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


def _handle_usage(raw_args: str = "", **kwargs) -> str:
    """Render the ``/usage`` block. Never raises: every failure becomes a line."""
    try:
        tokens = (raw_args or "").split()
        window = "7d"
        want_models = False
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
            elif tok == "profile":
                if i + 1 >= len(tokens):
                    return "Token Stats: 'profile' needs a name.\n\n" + HELP
                profile = tokens[i + 1]
                i += 1
            else:
                return f"Token Stats: unknown argument '{tokens[i]}'.\n\n" + HELP
            i += 1

        return _render(window, want_models, profile)
    except Exception as exc:  # noqa: BLE001 — a slash command must never raise
        logger.debug("usage: handler failed", exc_info=True)
        return f"Token Stats: internal error ({exc})."


def register(ctx) -> None:
    ctx.register_command(
        "usage",
        _handle_usage,
        description="Token totals and cost from the token-stats ledger",
        args_hint="[1d|5d|7d|30d|all] [models] [profile NAME]",
    )
