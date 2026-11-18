"""Ledger-Daemon: pollt zyklisch jede Profil-state.db (read-only) und
führt die monotone Ledger-DB pro Profil.

Pro Hermes-Profil eine eigene Ledger-DB: <LEDGER_BASE>/<profile>/ledger.db
Discovery pro Zyklus: ~/.hermes/state.db (= Profil 'default') +
glob('~/.hermes/profiles/*/state.db'). Neue Profile werden automatisch
aufgenommen. ENV-Overrides: LEDGER_BASE, LEDGER_INTERVAL, STATE_DB_OVERRIDE
(JSON-Map Profilname→Pfad, Test-Hook für isolierte Läufe).
"""

import glob
import json
import os
import sqlite3
import sys
import time

from .engine import LedgerEngine
from .poller import poll_profile

HERMES_HOME = os.path.expanduser("~/.hermes")
DEFAULT_BASE = os.path.expanduser("~/token-stats-ledger")


def discover_state_dbs():
    """Profilname → state.db-Pfad. Override-Map (Tests) ersetzt Discovery."""
    override = os.environ.get("STATE_DB_OVERRIDE")
    if override:
        return json.loads(override)

    profiles = {"default": os.path.join(HERMES_HOME, "state.db")}
    for path in glob.glob(os.path.join(HERMES_HOME, "profiles", "*", "state.db")):
        profile = os.path.basename(os.path.dirname(path))
        profiles[profile] = path
    return profiles


def open_ledger(profile, base):
    """Ledger-DB pro Profil (WAL, Schema idempotent via IF NOT EXISTS)."""
    os.makedirs(os.path.join(base, profile), exist_ok=True)
    db = sqlite3.connect(os.path.join(base, profile, "ledger.db"))
    db.row_factory = sqlite3.Row
    schema_path = os.path.join(os.path.dirname(__file__), "schema.sql")
    with open(schema_path) as f:
        db.executescript(f.read())
    return db


def run_cycle(base, connections=None):
    """Ein Zyklus über alle Profile. Gibt (Profil, Row-Zahl)-Paare zurück.

    v0.5.0: connections ist ein dict {profil: (db, engine)} über Zyklen
    hinweg wiederverwendet — das ständige open/close pro Zyklus war der
    Hauptteil der verbleibenden Disk-Writes (~38 KiB/Poll: shm-Init +
    WAL-Anlegen + Close-Checkpoint je Zyklus). WAL erlaubt den parallelen
    Read-only-Zugriff des Plugin-Backends, ein Offenhalten ist sicher.
    Neue Profile (Discovery) werden beim ersten Sehen geöffnet.
    """
    if connections is None:
        connections = {}
    results = []
    for profile, state_path in sorted(discover_state_dbs().items()):
        if not os.path.exists(state_path):
            continue
        if profile not in connections:
            db = open_ledger(profile, base)
            connections[profile] = (db, LedgerEngine(db))
        db, engine = connections[profile]
        n = poll_profile(state_path, engine)
        results.append((profile, n))
    return results


def main():
    interval = int(os.environ.get("LEDGER_INTERVAL", "15"))
    base = os.environ.get("LEDGER_BASE", DEFAULT_BASE)
    once = "--once" in sys.argv
    connections = {}  # {profil: (db, engine)} — über Zyklen gehalten (v0.5.0)

    while True:
        started = time.monotonic()
        try:
            # Connections über Zyklen halten (v0.5.0 Write-Sparsamkeit)
            for profile, n in run_cycle(base, connections):
                ts = time.strftime("%Y-%m-%d %H:%M:%S")
                print(f"[ledger] {ts} profile={profile} rows={n}", flush=True)
        except Exception as e:  # noqa: BLE001 — Daemon stirbt nicht an einem Zyklus
            print(f"[ledger] ERROR cycle failed: {e}", file=sys.stderr, flush=True)
        if once:
            break
        time.sleep(max(0, interval - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
