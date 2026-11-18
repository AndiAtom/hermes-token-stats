"""state.db-Poller: liest session_model_usage read-only und mappt die Felder.

Feinstes Korn (PK von session_model_usage), NICHT die Session-Totals aus
`sessions` — die mutieren sichtbar (Kompression, Rewinds).

v0.5.0 — Archive-Cut-Off: archivierte Sessions (sessions.archived = 1),
deren letzte Usage-Schreibung älter als ARCHIVE_GRACE_SECONDS ist, fallen
aus dem Poll-Snapshot. Die Engine behandelt sie über den removed-Pfad
(last_db = NULL, known bleibt monoton stehen, Pane zeigt die finalen
Werte weiter). Resume/Unarchive (Hermes setzt archived = 0, inkl. der
ganzen Kompressions-Lineage) nimmt sie wieder in den Snapshot auf →
reappear-Pfad: Baseline ohne Delta, kein Doppelzählen.

Der Cut-Off spart pro Poll ~88 % der Disk-Writes: der Daemon bump
last_poll nicht mehr für totes Blei (Gemessen 04.10.2026: 679 von 774
Rows archiviert, deren last_seen liegt nachweislich vor ended_at).

Grace-Begründung: 1 h Versicherung gegen einen Hermes-Version, die das
archived-Flag versetzt zur finalen Usage-Schreibung setzt. Datenstand
04.10.2026: 0 archivierte Rows mit last_seen > ended_at — faktisch
schreibt Hermes atomar. LEFT JOIN: Usage-Rows OHNE sessions-Eintrag
(Migrationslücke) werden wie aktiv behandelt und niemals stillschweigend
gecuttet — ihre Zähler würden ohne Event einfrieren.
"""

import sqlite3
import time

from .engine import LedgerEngine

# state.db-Spalte → Counter-Name (Poller-Mapping, Task 2 des Plans)
COLUMN_MAP = {
    "input_tokens": "in",
    "cache_read_tokens": "cached",
    "output_tokens": "out",
    "api_call_count": "calls",
}

# Letzte Usage-Schreibung einer archivierten Session muss jünger sein
# (Sekunden), damit sie noch gepollt wird. Siehe Modul-Docstring.
ARCHIVE_GRACE_SECONDS = 3600

QUERY = (
    "SELECT smu.session_id, smu.model, smu.billing_provider, "
    "smu.billing_base_url, smu.billing_mode, smu.task, "
    "smu.input_tokens, smu.cache_read_tokens, smu.output_tokens, "
    "smu.api_call_count "
    "FROM session_model_usage smu "
    "LEFT JOIN sessions s ON s.id = smu.session_id "
    "WHERE s.archived IS NULL OR s.archived = 0 "
    "OR smu.last_seen > ?"
)


def read_rows(state_db_path):
    """Aktiven Snapshot (mit Archive-Cut-Off) read-only lesen.

    mode=ro garantiert: niemals schreibend auf die state.db —
    der Daemon ist der einzige Schreiber der Ledger-DB, nicht der Quelle.
    """
    cutoff = time.time() - ARCHIVE_GRACE_SECONDS
    conn = sqlite3.connect(f"file:{state_db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = []
        for r in conn.execute(QUERY, (cutoff,)).fetchall():
            row = {c: r[c] for c in (
                "session_id", "model", "billing_provider",
                "billing_base_url", "billing_mode", "task",
            )}
            for col, counter in COLUMN_MAP.items():
                row[counter] = r[col]
            rows.append(row)
        return rows
    finally:
        conn.close()


def poll_profile(state_db_path, engine):
    """Ein Zyklus: state.db lesen → Engine füttern (Full-Snapshot).

    Das Rows-Set ist weiterhin ein VOLLSTÄNDiger Snapshot dessen, was
    der Daemon verwalten will — Rows, die drin waren und jetzt dem
    Cut-Off zum Opfer fallen, laufen regulär über den removed-Pfad
    (snapshot=True, siehe engine.apply_poll).
    """
    rows = read_rows(state_db_path)
    engine.apply_poll(rows, snapshot=True)
    engine.heartbeat()
    return len(rows)
