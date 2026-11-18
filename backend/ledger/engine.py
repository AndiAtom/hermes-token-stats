"""Known-Ledger Delta-Engine (Task 1 des Ledger-Plans).

Monotone Zähler pro Korn (session_id, model, billing_provider,
billing_base_url, billing_mode, task) und Counter (in/cached/out/calls).

Delta-Regeln (Andi-Formel, final 23.09.2026; diff=0-Regel 24.09.2026):

    Initial-Poll (Row neu):  known = live;  last_db = live
    Folge-Poll:  diff = live - last_db
        diff >= 0:          known += diff;  last_db = live
                            (diff=0 → No-op auf known, normaler Delta-Pfad)
        diff <  0:          known += live;  last_db = live
                            (DB-Reset → jeder Folgewert sind neue Tokens)
    Row fehlt (snapshot=True): removed  → last_db = NULL
    Row wieder da:            Baseline ohne Delta, reappeared nur loggen

known sinkt nie. last_db wird in JEDEM Fall auf live gesetzt (außer removed).
"""

import time

COUNTERS = ("in", "cached", "out", "calls")

KEY_COLS = (
    "session_id", "model", "billing_provider",
    "billing_base_url", "billing_mode", "task",
)

_KEY_WHERE = " AND ".join(f"{c} = ?" for c in KEY_COLS)


class LedgerEngine:
    def __init__(self, db):
        self.db = db

    # ── internal helpers ──────────────────────────────────────────────

    def _fetch(self, key):
        return self.db.execute(
            f"SELECT * FROM ledger_rows WHERE {_KEY_WHERE}",
            key,
        ).fetchone()

    def _log_event(self, session_id, kind, counter, last_db, db_now):
        self.db.execute(
            "INSERT INTO ledger_events (session_id, ts, kind, counter, last_db, db_now) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, time.time(), kind, counter, last_db, db_now),
        )

    def _remove_counter(self, key, row, now):
        """Row fehlt im Snapshot → last_db NULL, removed-Events pro Counter.

        v0.5.0: idempotent — ist last_db bereits NULL (Row dauerhaft
        ge-cuttet, z.B. archiviert), passiert NICHTS. Vorher wurde jede
        ge-cuttete Row in JEDEM Zyklus erneut geupdated (679 Rows × 15 s
        = der Hauptteil der Disk-Writes).
        """
        if all(row[f"last_db_{c}"] is None for c in COUNTERS):
            return
        for c in COUNTERS:
            if row[f"last_db_{c}"] is not None:
                self._log_event(key[0], "removed", c, row[f"last_db_{c}"], None)
        self.db.execute(
            f"UPDATE ledger_rows SET last_db_in = NULL, last_db_cached = NULL, "
            f"last_db_out = NULL, last_db_calls = NULL, live_db_in = NULL, "
            f"live_db_cached = NULL, live_db_out = NULL, live_db_calls = NULL, "
            f"last_poll = ? WHERE {_KEY_WHERE}",
            (now,) + key,
        )

    # ── core ──────────────────────────────────────────────────────────

    def apply_poll(self, rows, snapshot=False):
        """Eine Poll-Runde anwenden.

        rows: Liste von Dicts mit den KEY_COLS + den Countern
              (in, cached, out, calls) als absolute DB-Werte.
        snapshot: True, wenn rows der VOLLSTÄNDige Tabellenstand sind
              (Poller liest jede Cycle die ganze Tabelle). Dann werden
              fehlende Rows als removed behandelt. False (Default):
              nur angegebene Rows updaten, Rest unangetastet lassen.
        """
        now = time.time()
        seen_keys = set()

        for r in rows:
            key = tuple(r.get(c, "") for c in KEY_COLS)
            seen_keys.add(key)
            existing = self._fetch(key)

            if existing is None:
                # Initial-Poll: known = live, last_db = live
                self.db.execute(
                    "INSERT INTO ledger_rows ("
                    "session_id, model, billing_provider, billing_base_url, "
                    "billing_mode, task, known_in, known_cached, known_out, "
                    "known_calls, last_db_in, last_db_cached, last_db_out, "
                    "last_db_calls, live_db_in, live_db_cached, live_db_out, "
                    "live_db_calls, first_seen, last_poll) VALUES ("
                    "?,?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?)",
                    key + (
                        r.get("in", 0), r.get("cached", 0),
                        r.get("out", 0), r.get("calls", 0),
                    ) * 3 + (now, now),
                )
                continue

            # Folge-Poll: je Counter die Delta-Regel.
            # v0.5.0 Write-Sparsamkeit: last_poll wird NUR noch bei
            # realer Änderung gebumpt (voller Row-Update), Liveness
            # übernimmt ledger_meta.heartbeat. Bei unveränderten Werten
            # (diff=0, diff<0 ohne known-Änderung ist nicht möglich) wird
            # GAR NICHTS geschrieben — der Daemon schreibt also in einem
            # stillen 15s-Zyklus nur den Heartbeat (~16 Byte).
            sets, vals = [], []
            dirty = False
            for c in COUNTERS:
                live = r.get(c, 0)
                last = existing[f"last_db_{c}"]
                if last is None:
                    # Reappear: Baseline ohne Delta. ABER: liegt der DB-Wert
                    # über allem je Gesehenen (live > known), sind die
                    # Differenz-Tokens nachweislich neu — nachziehen
                    # (v0.5.0: mit dem Archive-Cut-Off ist der Fall
                    # "Row war weg und hat zwischenzeitlich gewachsen"
                    # erreichbar; known bleibt monoton, Doppelzählen ist
                    # ausgeschlossen, weil known die Obergrenze ist).
                    self._log_event(key[0], "reappeared", c, None, live)
                    if live > (existing[f"known_{c}"] or 0):
                        self.db.execute(
                            f"UPDATE ledger_rows SET known_{c} = ? "
                            f"WHERE {_KEY_WHERE}",
                            (live,) + key,
                        )
                    dirty = True  # Baseline neu verankern
                else:
                    diff = live - last
                    if diff < 0:
                        self._log_event(key[0], "decrease", c, last, live)
                        self.db.execute(
                            f"UPDATE ledger_rows SET known_{c} = known_{c} + ? "
                            f"WHERE {_KEY_WHERE}",
                            (live,) + key,
                        )
                        dirty = True
                    elif diff > 0:
                        self.db.execute(
                            f"UPDATE ledger_rows SET known_{c} = known_{c} + ? "
                            f"WHERE {_KEY_WHERE}",
                            (diff,) + key,
                        )
                        dirty = True
                    # diff == 0 → No-op (Andi-Regel 24.09.2026): weder known
                    # noch Baseline ändern → auch kein Row-Update nötig.
                sets.append(f"last_db_{c} = ?")
                vals.append(live)
                sets.append(f"live_db_{c} = ?")
                vals.append(live)

            if dirty:
                sets.append("last_poll = ?")
                vals.append(now)
                vals.extend(key)
                self.db.execute(
                    f"UPDATE ledger_rows SET {', '.join(sets)} WHERE {_KEY_WHERE}",
                    vals,
                )

        if snapshot:
            # Alle bisherigen Rows, die NICHT im Snapshot waren → removed
            for row in self.db.execute(
                "SELECT * FROM ledger_rows"
            ).fetchall():
                key = tuple(row[c] for c in KEY_COLS)
                if key not in seen_keys:
                    self._remove_counter(key, row, now)

        self.db.commit()

    # ── read API ──────────────────────────────────────────────────────

    def heartbeat(self):
        """Daemon-Heartbeat: ledger_meta['heartbeat'] = now (UPSERT, 1 Row).

        v0.5.0: Frische-Signal für /health — last_poll friert seit dem
        Archive-Cut-Off ein, sobald alle Sessions archiviert sind.
        """
        now = time.time()
        self.db.execute(
            "INSERT INTO ledger_meta (key, value) VALUES ('heartbeat', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (now,),
        )
        self.db.commit()

    def get(self, session_id, model, task, billing_provider="", billing_base_url="", billing_mode=""):
        row = self.db.execute(
            f"SELECT * FROM ledger_rows WHERE {_KEY_WHERE}",
            (session_id, model, billing_provider, billing_base_url, billing_mode, task),
        ).fetchone()
        return dict(row) if row else None

    def events(self, session_id, limit=50):
        return [
            dict(r) for r in self.db.execute(
                "SELECT * FROM ledger_events WHERE session_id = ? "
                "ORDER BY id DESC LIMIT ?",
                (session_id, limit),
            ).fetchall()
        ]
