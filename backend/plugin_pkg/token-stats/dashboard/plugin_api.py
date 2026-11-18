"""token-stats known-ledger backend: monotonic (known) token counters for the
token-stats desktop plugin. Official plugin backend — auto-mounts under
/api/plugins/token-stats/ (the DESKTOP plugin's own ID — ctx.rest is
namespace-locked, so the backend must mount under the client's ID) when the
plugin is in plugins.enabled.

Two data sources, clean split:
- Ledger DB (<LEDGER_BASE>/<profile>/ledger.db, WAL): the monotonic known
  counters per (session_id, model, provider, base_url, mode, task).
  Written ONLY by the token-stats-ledger daemon; this backend reads it
  via mode=ro (WAL allows parallel readers).
- Hermes state.db (~/.hermes/state.db): session METADATA (title, source,
  timestamps, cache_write/reasoning tokens, cost estimates) that the
  ledger deliberately does not track.

Answer shape is compatible with the legacy usage.history RPC (sessions[] +
model_usage[]) so the client can swap data sources almost 1:1. Sessions
that exist only in the ledger (deleted from state.db via ON DELETE
CASCADE) stay visible — money is spent.
"""

import datetime
import glob
import os
import sqlite3

from fastapi import APIRouter

router = APIRouter()

LEDGER_BASE = os.environ.get("LEDGER_BASE", os.path.expanduser("~/token-stats-ledger"))
STATE_DB = os.environ.get(
    "LEDGER_STATE_DB", os.path.expanduser("~/.hermes/state.db")
)


def _day_key(ts):
    """Local-time 'YYYY-MM-DD' for a session-activity timestamp — the
    same day attribution the client's buildHistogram uses (tokens count
    on the activity day), so by_day and the histogram agree by design."""
    if not ts:
        ts = 0
    return datetime.datetime.fromtimestamp(
        ts, datetime.timezone.utc
    ).astimezone().strftime("%Y-%m-%d")


def _ro(path):
    """Read-only SQLite connection (WAL-safe for ledger reads)."""
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def available_profiles():
    """Profiles = directories under LEDGER_BASE containing a ledger.db."""
    out = []
    if os.path.isdir(LEDGER_BASE):
        for d in sorted(glob.glob(os.path.join(LEDGER_BASE, "*", "ledger.db"))):
            out.append(os.path.basename(os.path.dirname(d)))
    return out


def _ledger_rows(profile, session_id=""):
    """All ledger rows for a profile, grouped by session_id."""
    path = os.path.join(LEDGER_BASE, profile, "ledger.db")
    if not os.path.exists(path):
        return None
    conn = _ro(path)
    try:
        sql = (
            "SELECT session_id, model, billing_provider, billing_base_url, "
            "billing_mode, task, known_in, known_cached, known_out, "
            "known_calls, last_db_in, last_db_cached, last_db_out, "
            "last_db_calls, live_db_in, live_db_cached, live_db_out, "
            "live_db_calls, first_seen, last_poll FROM ledger_rows"
        )
        params = ()
        if session_id:
            sql += " WHERE session_id = ?"
            params = (session_id,)
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def _session_meta():
    """Metadata for ALL sessions from state.db (read-only, single query).

    Returns {session_id: {title, source, started_at, ended_at, last_active,
    message_count, model, billing_provider, billing_mode,
    cache_write_tokens, reasoning_tokens, estimated_cost_usd}}.

    NOTE: fetched for ALL sessions up front — the ledger route needs
    last_active BEFORE window-filtering and sorting (the ledger's own
    last_poll is bumped every daemon cycle for every row, so it is
    useless as an activity signal; state.db last_active is the real one).
    """
    out = {}
    if not os.path.exists(STATE_DB):
        return out
    conn = _ro(STATE_DB)
    try:
        for r in conn.execute(
            """
            SELECT id, COALESCE(title, '') AS title, source,
                   started_at, ended_at,
                   COALESCE(last_activity_at, ended_at, started_at) AS last_active,
                   message_count, model, billing_provider, billing_mode,
                   cache_write_tokens, reasoning_tokens, estimated_cost_usd,
                   parent_session_id,
                   COALESCE(json_extract(model_config, '$._delegate_from'), '')
                     AS delegate_from
              FROM sessions
            """
        ):
            d = dict(r)
            # Subagent detection (Hermes migrations v16/v30): source tag or
            # the $._delegate_from marker in model_config. parent_session_id
            # ALONE is NOT sufficient — compression lineage splits use it too.
            d["is_subagent"] = bool(
                d.get("source") == "subagent" or d.get("delegate_from"))
            out[r["id"]] = d
        return out
    finally:
        conn.close()


@router.get("/profiles")
async def profiles():
    """Available ledger profiles."""
    return {"profiles": available_profiles()}


@router.get("/ledger")
async def ledger(days: int = 30, since: float = 0, until: float = 0,
                limit: int = 200, session_id: str = "", models: bool = True,
                totals: int = 0, profile: str = "default"):
    """Monotonic known counters, shape-compatible with usage.history.

    Returns sessions[] (one entry per session_id, sums of known counters,
    plus state.db metadata where available) and model_usage[] (per-grain
    ledger rows with known + live values).

    Window: sessions with activity in [since, until). `since`/`until` are
    epoch seconds; `since` is INCLUSIVE, `until` EXCLUSIVE (0 = open).
    Explicit since/until (calendar windows, e.g. month start or Friday
    23:59:59) take precedence; otherwise `days` rolls back from now.
    """
    import time as _time
    from fastapi import HTTPException
    if profile not in available_profiles():
        raise HTTPException(
            status_code=404,
            detail={
                "error": f"profile '{profile}' not found",
                "available": available_profiles(),
                "ts": _time.time(),
            },
        )
    now = _time.time()
    if since:
        cutoff = since
    else:
        cutoff = now - days * 86400 if days and days > 0 else 0
    # Optional EXCLUSIVE upper bound (calendar windows, e.g. workweek
    # Mon 0:00 → Sat 0:00). 0 = open. Also applies to the days-window
    # path, so the shape of the filter stays uniform.
    upper = until if until else 0

    rows = _ledger_rows(profile, session_id=session_id)
    if rows is None:
        return {"sessions": [], "model_usage": []}

    # Group grain rows by session, then resolve per-session ACTIVITY:
    # state.db last_activity_at when the session still exists there,
    # else the ledger's first_seen (ledger-only session, e.g. after a
    # CASCADE delete — last_poll is useless: the daemon bumps it for
    # EVERY row EVERY cycle, so it would put dead sessions on top).
    by_sid = {}
    for r in rows:
        by_sid.setdefault(r["session_id"], []).append(r)

    meta = _session_meta()

    def activity(sid):
        m = meta.get(sid)
        if m and m.get("last_active"):
            return m["last_active"]
        return min(r["first_seen"] for r in by_sid[sid])

    # Window filtering (since/days/until) on REAL activity — same
    # semantics as usage.history's window. `until` is exclusive.
    sids = [s for s in by_sid
            if activity(s) >= cutoff and (not upper or activity(s) < upper)]
    if session_id:
        # Focus-session queries (chip): totals, if requested, scope to
        # that session too — not the whole window.
        sids = [s for s in sids if s == session_id]
    sids = sorted(sids, key=activity, reverse=True)

    # v0.7.0 — window totals: aggregate over ALL sessions in the window
    # BEFORE the limit cut. `sessions[]` stays limited (display list);
    # `totals` is the authoritative full-window sum, so client totals no
    # longer shrink when new sessions push old ones past `limit`.
    # Uses the SAME known_* counters that fill sessions[] — no second
    # bookkeeping. Server stays price-free (cost is client-side via PRICES).
    resp = {}
    if totals and sids:
        t_in = t_cached = t_out = t_calls = 0
        per_model = {}  # (model, billing_provider) -> sums
        per_task = {}   # task (!= '') -> sums  (aux breakdown only)
        per_day = {}    # 'YYYY-MM-DD' from activity -> sums
        for s in sids:
            rs = by_sid[s]
            s_in = sum(r["known_in"] for r in rs)
            s_cached = sum(r["known_cached"] for r in rs)
            s_out = sum(r["known_out"] for r in rs)
            s_calls = sum(r["known_calls"] for r in rs)
            t_in += s_in
            t_cached += s_cached
            t_out += s_out
            t_calls += s_calls
            m = meta.get(s, {})
            for r in rs:
                # billing_provider from the LEDGER grain row — grain-exact
                # and correct even for ledger-only sessions (state.db meta
                # would be None there). Matches the client's per-row pricing
                # path over model_usage[].
                bp = r["billing_provider"] or None
                mk = (r["model"], bp)
                e = per_model.setdefault(
                    mk, {"model": r["model"],
                         "billing_provider": bp,
                         "input_tokens": 0, "cache_read_tokens": 0,
                         "output_tokens": 0, "api_calls": 0, "sessions": set()})
                e["input_tokens"] += r["known_in"]
                e["cache_read_tokens"] += r["known_cached"]
                e["output_tokens"] += r["known_out"]
                e["api_calls"] += r["known_calls"]
                e["sessions"].add(s)
                if r["task"]:
                    tk = r["task"]
                    te = per_task.setdefault(
                        tk, {"task": tk, "input_tokens": 0,
                              "cache_read_tokens": 0, "output_tokens": 0,
                              "api_calls": 0, "sessions": set()})
                    te["input_tokens"] += r["known_in"]
                    te["cache_read_tokens"] += r["known_cached"]
                    te["output_tokens"] += r["known_out"]
                    te["api_calls"] += r["known_calls"]
                    te["sessions"].add(s)
            day = _day_key(activity(s))
            de = per_day.setdefault(
                day, {"day": day, "input_tokens": 0,
                      "cache_read_tokens": 0, "output_tokens": 0,
                      "api_calls": 0, "sessions": set()})
            de["input_tokens"] += s_in
            de["cache_read_tokens"] += s_cached
            de["output_tokens"] += s_out
            de["api_calls"] += s_calls
            de["sessions"].add(s)

        def _ready(d):
            out = dict(d)
            out["sessions"] = len(out["sessions"])
            return out

        resp["totals"] = {
            "sessions": len(sids),
            "input_tokens": t_in,
            "cache_read_tokens": t_cached,
            "output_tokens": t_out,
            "api_call_count": t_calls,
            "by_model": [_ready(e) for e in per_model.values()],
            "by_task": [_ready(e) for e in per_task.values()],
            "by_day": [_ready(e) for e in per_day.values()],
        }
    if not session_id:
        sids = sids[:limit]

    sessions = []
    for sid in sids:
        rs = by_sid[sid]
        m = meta.get(sid, {})
        last_active = max(r["last_poll"] for r in rs)
        sessions.append({
            "id": sid,
            "title": m.get("title", ""),
            "source": m.get("source", "ledger"),
            "started_at": m.get("started_at", min(r["first_seen"] for r in rs)),
            "ended_at": m.get("ended_at"),
            "last_active": m.get("last_active", last_active),
            "message_count": m.get("message_count"),
            "api_call_count": sum(r["known_calls"] for r in rs),
            "input_tokens": sum(r["known_in"] for r in rs),
            "output_tokens": sum(r["known_out"] for r in rs),
            "cache_read_tokens": sum(r["known_cached"] for r in rs),
            "cache_write_tokens": m.get("cache_write_tokens"),
            "reasoning_tokens": m.get("reasoning_tokens"),
            "estimated_cost_usd": m.get("estimated_cost_usd"),
            "model": m.get("model", rs[0]["model"] if rs else ""),
            "billing_provider": m.get("billing_provider"),
            "billing_mode": m.get("billing_mode"),
            # subagent extras (None for ledger-only sessions)
            "is_subagent": m.get("is_subagent", False),
            "parent_session_id": m.get("parent_session_id"),
            # ledger extras
            "ledger_only": sid not in meta,
            "last_poll": last_active,
        })

    model_usage = []
    if models:
        sid_set = set(sids)
        for r in rows:
            if r["session_id"] not in sid_set:
                continue
            model_usage.append({
                "session_id": r["session_id"],
                "model": r["model"],
                "task": r["task"],
                "billing_provider": r["billing_provider"],
                "billing_base_url": r["billing_base_url"],
                "billing_mode": r["billing_mode"],
                "api_calls": r["known_calls"],
                "input_tokens": r["known_in"],
                "output_tokens": r["known_out"],
                "cache_read_tokens": r["known_cached"],
                "first_seen": r["first_seen"],
                "last_seen": r["last_poll"],
                # ledger extras
                "live_in": r["live_db_in"],
                "live_cached": r["live_db_cached"],
                "live_out": r["live_db_out"],
                "live_calls": r["live_db_calls"],
                "last_db_in": r["last_db_in"],
            })

    out: dict = {"sessions": sessions, "model_usage": model_usage}
    # v0.7.0: totals ride along only when requested (totals=1) — old
    # clients and focus-session queries keep the lean response shape.
    if "totals" in resp:
        out["totals"] = resp["totals"]
    return out


@router.get("/events")
async def events(session_id: str, limit: int = 50, profile: str = "default"):
    """Anomaly history (decrease/removed/reappeared) per session."""
    path = os.path.join(LEDGER_BASE, profile, "ledger.db")
    if not os.path.exists(path):
        from fastapi import HTTPException
        raise HTTPException(
            status_code=404,
            detail={"error": f"profile '{profile}' not found",
                    "available": available_profiles()},
        )
    conn = _ro(path)
    try:
        return {"events": [dict(r) for r in conn.execute(
            "SELECT * FROM ledger_events WHERE session_id = ? "
            "ORDER BY id DESC LIMIT ?", (session_id, limit)).fetchall()]}
    finally:
        conn.close()


@router.get("/health")
async def health(profile: str = "default"):
    """Daemon liveness: row count + freshness of the last poll.

    v0.5.0: freshness comes from ledger_meta.heartbeat (written every
    cycle, ~16 bytes). MAX(last_poll) freezes once ALL sessions are
    archived (archive cut-off) — it is kept only as a fallback for
    ledger DBs created before the heartbeat existed.
    """
    path = os.path.join(LEDGER_BASE, profile, "ledger.db")
    if not os.path.exists(path):
        return {"ok": False, "profile": profile,
                "available": available_profiles()}
    import time as _time
    conn = _ro(path)
    try:
        rows = conn.execute("SELECT COUNT(*) FROM ledger_rows").fetchone()[0]
        hb = conn.execute(
            "SELECT value FROM ledger_meta WHERE key = 'heartbeat'"
        ).fetchone()
        last_poll = hb[0] if hb else conn.execute(
            "SELECT COALESCE(MAX(last_poll), 0) FROM ledger_rows"
        ).fetchone()[0]
        age = _time.time() - last_poll if last_poll else None
        return {
            "ok": bool(last_poll) and age is not None and age < 120,
            "profile": profile,
            "rows": rows,
            "last_poll": last_poll,
            "age_seconds": round(age, 1) if age is not None else None,
            "source": "heartbeat" if hb else "last_poll_fallback",
        }
    finally:
        conn.close()
