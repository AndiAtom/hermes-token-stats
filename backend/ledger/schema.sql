-- Known-Ledger: monotone Token-Zähler pro (session_id, model, provider, base_url, mode, task).
-- Kernidee (Andi-Formel, 23.09.2026): known = monoton akkumuliert, sinkt nie.
-- last_db = Diff-Basis aus state.db; live_db = letzter Poll (transient, Debugging).

PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS ledger_rows (
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    billing_provider TEXT NOT NULL DEFAULT '',
    billing_base_url TEXT NOT NULL DEFAULT '',
    billing_mode TEXT NOT NULL DEFAULT '',
    task TEXT NOT NULL DEFAULT '',
    -- known_*: an den Client gelieferte monotone Werte
    known_in INTEGER NOT NULL DEFAULT 0,
    known_cached INTEGER NOT NULL DEFAULT 0,
    known_out INTEGER NOT NULL DEFAULT 0,
    known_calls INTEGER NOT NULL DEFAULT 0,
    -- last_db_*: Diff-Basis (NULL = Row verschwunden, Baseline weg)
    last_db_in INTEGER, last_db_cached INTEGER, last_db_out INTEGER, last_db_calls INTEGER,
    -- live_db_*: letzter Poll-Wert (transient)
    live_db_in INTEGER, live_db_cached INTEGER, live_db_out INTEGER, live_db_calls INTEGER,
    first_seen REAL NOT NULL,
    last_poll REAL NOT NULL,
    PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
);

-- Anomalie-History: decrease / removed / reappeared — Nachvollziehbarkeit
CREATE TABLE IF NOT EXISTS ledger_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ts REAL NOT NULL,
    kind TEXT NOT NULL,          -- decrease | removed | reappeared
    counter TEXT NOT NULL,       -- in | cached | out | calls
    last_db INTEGER,             -- NULL bei removed
    db_now INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ledger_events_sid ON ledger_events(session_id, ts DESC);

-- Daemon-Heartbeat (v0.5.0): 1 Row, pro Zyklus geupdated. Ersatz für
-- MAX(last_poll) als Frische-Signal — seit dem Archive-Cut-Off friert
-- last_poll ein, sobald ALLE Sessions archiviert sind, obwohl der Daemon
-- läuft. Der Heartbeat schreibt ~16 Byte/Zyklus statt 133 KiB.
CREATE TABLE IF NOT EXISTS ledger_meta (
    key TEXT PRIMARY KEY,
    value REAL NOT NULL
);
