# backend (hermes-token-stats)

> [!NOTE]
> Formerly the standalone repo `hermes-usage-history-rpc` — merged into the
> [`hermes-token-stats`](https://github.com/AndiAtom/hermes-token-stats)
> monorepo as `backend/` in v1.0.0. This README documents the backend
> part.

> [!IMPORTANT]
> **This repo has been merged into
> [`hermes-token-stats`](https://github.com/AndiAtom/hermes-token-stats)
> and is now archived.** All development, releases and install paths have
> moved there (this backend lives on as `backend/`). Versions unified to
> a single `v1.0.0` (the client `v5.x` and this repo's `v0.x` lines both
> ended there). This copy remains readable for reference.

Server-side usage analytics for [Hermes Agent](https://github.com/NousResearch/hermes-agent):
a known-ledger daemon + plugin backend serving **monotonic**
(compression-safe) token counters.

## What it does

The plugin backend reads **persistent** token/cost data from `state.db` —
client-independent and across gateway restarts (the gap: the existing
`session.usage` RPC only serves live in-memory data of the focused
session).

Data sources: `sessions` (lifetime totals per session) + `session_model_usage`
(per model/task, including auxiliary tasks like `title_generation`,
`background_review`). Read-only, no writes.

> [!NOTE]
> **Legacy gateway RPCs removed (v1.0.0).** The former
> `usage.history` / `usage.totals` JSON-RPC methods (patched into the
> gateway's `server.py`) have been retired — the plugin backend
> (`/api/plugins/token-stats/*`, see below) is the supported data path.
> The desktop client keeps a silent fallback for old Hermes installs
> (< 0.21.4, which lack plugin backend support) and degrades those to
> live-only data instead of crashing. This installer no longer touches
`$HERMES_LIB`.

## Known-Ledger (monotonic counters)

`state.db` is NOT monotonic: compression resets, `ON DELETE CASCADE` on
`session_model_usage` and rewinds make counters drop. Client-side
"largest seen value" heuristics lose deltas. The ledger fixes that:

- **Daemon** (`ledger/daemon.py`, systemd unit `token-stats-ledger.service`)
  polls every profile's `state.db` read-only (`mode=ro`) every 15 s
  (configurable via `LEDGER_INTERVAL`) and accumulates per-grain
  `(session_id, model, provider, base_url, mode, task)` counters: `known`
  (monotonic, never drops — what the client sees), `last_db` (diff base),
  `live_db` (last poll). Negative deltas add the new DB value
  (re-baseline), vanished rows log `removed`/`reappeared` events in
  `ledger_events`. One ledger DB per profile:
  `~/token-stats-ledger/<profile>/ledger.db` (`LEDGER_BASE`, default below
  the invoking user's home — for a root systemd service that is
  `/root/token-stats-ledger`).
  **Archive cut-off (v0.5.0):** rows of archived sessions
  (`sessions.archived = 1`) whose last usage write is older than 1 h
  (`ARCHIVE_GRACE_SECONDS`) drop out of the poll snapshot — their `known`
  counters freeze at the final value (removed-path) and stay visible.
  Resume/unarchive re-adds them (reappear-path, baseline without delta;
  a DB value above `known` pulls the delta in). Measured effect:
  ~95 % fewer disk writes (133 KiB → 7 KiB per poll).
  **Write sparsity (v0.5.0):** cycles with no changes write nothing but a
  heartbeat row (`ledger_meta.heartbeat`, ~16 bytes) — `last_poll` on a
  row means "last change", daemon liveness is the heartbeat. Ledger DB
  connections stay open across cycles (WAL allows concurrent backend
  readers).
- **Plugin backend** (`plugin_pkg/token-stats/`) mounts under
  `/api/plugins/token-stats/` (official plugin backend — `ctx.rest` from the
  desktop plugin reaches it; survives Hermes updates since it lives in
  `~/.hermes/plugins/`):

| Route | Parameters | Returns |
|---|---|---|
| `/api/plugins/token-stats/ledger` | `days`, `since` (inclusive), `until` (EXCLUSIVE upper bound, calendar windows), `limit`, `session_id`, `models`, `totals` (v0.7.0: `1` = full-window aggregation, limit-independent), `profile` | `sessions[]` + `model_usage[]` — shape-compatible with `usage.history` (known counters + state.db metadata, window/filter on real activity); with `totals=1` additionally `totals` `{sessions, input_tokens, cache_read_tokens, output_tokens, api_call_count, by_model[], by_task[] (aux only), by_day[]}` aggregated over the FULL window before the limit cut |
| `/api/plugins/token-stats/events` | `session_id`, `limit`, `profile` | anomaly history (decrease/removed/reappeared) |
| `/api/plugins/token-stats/profiles` | — | available ledger profiles |
| `/api/plugins/token-stats/prices` | `PUT` body: `{"prices": {"model": {input, cached, output}}, "providerPrices": {"provider": {"model": {...}}}}` — rates USD per 1M, ≥ 0, missing rates = 0; invalid entries dropped into `rejected[]` | v1.0.0 GET: `{prices, providerPrices}` (empty objects when unset). PUT: `{ok, applied, appliedProvider, rejected, stored}`. Store: `user_prices.json` next to the deployed package, read per request (editor/scp edits apply without restart) |
| `/api/plugins/token-stats/health` | `profile` | daemon liveness via heartbeat (`source: heartbeat`), rows, age; `last_poll` fallback for pre-v0.5.0 ledger DBs |

The RPCs (`usage.history`/`usage.totals`) were removed in v1.0.0 — the
plugin backend above is the only data path.

## Data availability — no backfill

> [!IMPORTANT]
> **The ledger starts recording at its first start — it does not backfill.**
> The daemon polls live and accumulates; it never imports historical usage
> that predates its installation. On the first poll every row is
> baselined with `known = live` (the current `state.db` values) — so
> pre-install usage that survived in `state.db` is included, but usage
> that `state.db` had already lost to compression resets before the
> ledger existed is not, and it never will be.
>
> Consequence for the client views: every window (1d/5d/7d/30d/∞) is only
> complete where it lies entirely after the ledger's first start — a
> mid-month install undercounts (or misses) the days before it, and the
> 30d running-month view only becomes fully trustworthy once a month
> boundary has passed since the install.

## Web dashboard plugin (v0.6.0)

`plugin_pkg/token-stats/dashboard/` also ships a **web-dashboard plugin**
(`web-entry.js`, referenced by the manifest's `entry` field): a full port of
the desktop pane's design as a tab in the Hermes **web** dashboard (the
browser UI on port 9119 — a separate plugin SDK from the desktop app's).
It registers via `window.__HERMES_PLUGINS__.register()` and fetches live
data from the same ledger backend routes via the host's `fetchJSON`
(30 s poll, calendar-window presets, day-group totals, ⚡ cache-hit bar,
🪙/€ histogram, model/subagent/aux breakdowns, ⚠ anomaly flags).

The pane logic (pricing tables, `estimateCost`, calendar windows,
aggregations) is a verbatim port of the desktop plugin. **Parity rule:**
every change or fix to the desktop pane is ported to the web entry as
well — the two implementations stay in lockstep (pricing changes in
particular must land in both files). The web entry carries its own
version marker (`vX.Y.Z-web.N` in the file header), bumped on every port.

Styling is self-contained: the web build ships a fixed
compiled Tailwind CSS, so the entry injects its own namespaced `.ts-*`
stylesheet built on the dashboard theme variables (`--midground-base` etc.)
and follows the active theme. No Tailwind classes are used.

> **Note — a third surface exists:** since Hermes ≥ v0.22.6 the gateway
> can also serve the **WebApp** (the full desktop bundle in the browser,
> port 9120). There the *desktop* plugin itself (`plugin.js`, documented
> in the monorepo root README) runs as-is — pane and chip already work there
> (rudimentary). That surface does not use `web-entry.js`; the ledger
> backend answers unchanged. Smoothed WebApp support is roadmapped as
> client v5.3 (see the [roadmap in the monorepo root](https://github.com/AndiAtom/hermes-token-stats#roadmap)).

| Scope | Web port |
|---|---|
| Presets, summary, histogram, day groups, breakdowns, anomaly flags | ✔ |
| Statusbar chip, live-usage overlay | ✖ (desktop-only — no session event stream in the web SDK) |
| Column drag-resize | ✔ since web.2 (persisted in localStorage, `token-stats:colWidths`) |

## Layout

```
ledger/schema.sql                      # Ledger DB schema (ledger_rows, ledger_events, ledger_meta; WAL)
ledger/engine.py                       # Delta engine: known/last_db/live_db per grain+counter (v0.5.0: write-sparse)
ledger/poller.py                       # state.db → rows mapping (read-only snapshot, v0.5.0: archive cut-off)
ledger/daemon.py                       # 15-s poll loop, per-profile discovery, --once mode (LEDGER_INTERVAL env)
ledger/token-stats-ledger.service      # systemd unit
plugin_pkg/token-stats/                # Plugin backend package (deploys to ~/.hermes/plugins/token-stats/)
plugin_pkg/token-stats/dashboard/      # Backend routes (plugin_api.py) + web-dashboard entry (web-entry.js)
test_ledger_engine.py                  # Delta-rule unit tests (incl. write-sparsity regressions)
test_ledger_poller.py                  # Poller cut-off/reappear/heartbeat tests (v0.5.0)
test_plugin_api.py                     # Backend route tests (TestClient, isolated ENV)
install.sh                             # Idempotent installer (plugin backend + config + daemon)
```

## Install / re-install after a Hermes update

```bash
# One-liner (clones the monorepo to ~/.hermes-token-stats, then installs):
curl -fsSL https://raw.githubusercontent.com/AndiAtom/hermes-token-stats/main/backend/install.sh | bash -s -- --yes

# Or from a checkout / re-run after a Hermes update:
./install.sh
```

All-in-one installer for the full stack — plugin package (backend routes +
web dashboard entry), `plugins.enabled` entry, known-ledger systemd daemon,
dashboard restart and a smoke check. Idempotent: safe to re-run at any
time (e.g. to refresh the plugin package after a `git pull`). No
third-party dependencies — the ledger daemon is pure stdlib, fastapi/ruamel
come with the Hermes runtime, and the installer only verifies their
importability.

> [!NOTE]
> **v1.0.0:** the gateway hook step (legacy `usage.history` /
> `usage.totals`, `server.py` patching) is gone. Hermes updates no longer
> wipe anything this installer applies — re-running after an update is now
> only needed if the plugin package itself changed.

Before touching anything, the installer runs a **preflight** that checks
every path and prerequisite it will need: Hermes install root (git/venv and
installer layouts are auto-detected), `config.yaml` presence and
writability, the Python prerequisites (`sqlite3` for the daemon, `fastapi`
for the plugin backend, `ruamel.yaml` for the config validation — a missing
ruamel only downgrades that validation, it doesn't abort), and systemd
(containers without systemd degrade to `--no-daemon` instead of failing).
Fatal items abort with the env knob that fixes them; `./install.sh --doctor`
runs the check alone and exits.

**Non-root installs** get a systemd **user unit** (`systemctl --user`) for
the ledger daemon — no sudo needed, ledger DBs stay in the user's home and
owned by the user (a root system unit would write to `/root/...` while the
user-owned dashboard process reads `~/token-stats-ledger` — empty pane).
User units bind to `default.target` and the installer enables **lingering**
for headless hosts (survives logout). Running with sudo on a root-owned
Hermes install keeps the system unit as before — the scope follows the
invoking user. A stale root-era system unit next to a user install is
detected and warned about.

Flags: `--client-only` (desktop plugin file only — no backend, no daemon),
`--hermes-home <dir>` (Hermes home directory; default `~/.hermes`, wins
over the `HERMES_HOME` env), `--no-daemon` (plugin backend only), `--no-restart`, `--yes` /
`ASSUME_YES=1` (non-interactive), `--doctor` (check environment only).
Env overrides: `HERMES_LIB`, `HERMES_HOME`, `DASHBOARD_PORT`, `LEDGER_BASE`,
`INSTALL_DIR` + `REPO_URL` (curl-mode clone location/source).

The config.yaml edit is inserted surgically (exactly one list item, no YAML
round-trip — a library dump reflows the whole file); a backup is written
next to the config first.

After installing, restart the service the **desktop app actually talks to**
(`hermes-dashboard.service`, port 9119 — NOT `hermes-gateway.service`): the
installer offers this as a y/N prompt and also supports `ASSUME_YES=1` for
non-interactive runs.

## Verification after install

```bash
# state.db must be untouched (read-only backend):
sqlite3 ~/.hermes/state.db "SELECT count(*) FROM sessions;"   # same before/after

# Health route answers 200/401 (mounted) — see the smoke check above.
# Desktop plugin consumes the backend via ctx.rest('/ledger?...').
```

## Roadmap

**Shipped in v0.7.4** — **non-root installs** (installer only — ledger
daemon, routes and web entry unchanged):

- The ledger daemon now installs as a **systemd user unit**
  (`systemctl --user`) when the installer runs as a non-root user — no sudo
  needed, ledger DBs stay in the user's home and owned by the user. A root
  system unit would silently write the ledger to `/root/token-stats-ledger`
  while the user-owned dashboard process reads `~/token-stats-ledger` —
  empty pane, plus root-owned WAL/shm files the user cannot write. The unit
  scope follows the invoking user; root installs keep the system unit.
- User units bind to `default.target` (`multi-user.target` does not exist
  in the user manager — the enabled symlink would point at a dead target
  and the daemon would not autostart at next login). **Lingering** is
  enabled automatically so the unit survives logout on headless hosts;
  a stale root-era system unit next to a user install is detected and
  warned about.
- Preflight hardened: `tui_gateway` writability (a root-owned Hermes
  install + non-root user fails FAST with "re-run with sudo" instead of
  dying midway through step 3), ledger base writability probe, and user
  manager availability (missing XDG session degrades to `--no-daemon`
  with fix hints instead of failing).
- Verified with a real non-root user: piped one-liner install into a
  user-owned installer layout — unit enabled in `default.target.wants`,
  active, lingering on, hooks applied; root-path regression unchanged.

**Shipped in v0.7.3** — **curl | bash one-liner install + preflight/doctor**
(installer only — ledger daemon, routes and web entry unchanged):

- `curl -fsSL .../install.sh | bash -s -- --yes` now works out of the box:
  a piped installer detects the missing `BASH_SOURCE`, clones the repo to a
  persistent location (`~/.hermes-token-stats`, override via
  `INSTALL_DIR`/`REPO_URL` — persistent because the daemon unit templates
  `WorkingDirectory=` to the repo), then re-execs itself from there with all
  flags preserved. Re-runs of the one-liner `git pull` the clone first.
- **Preflight before any file is touched**: Hermes install root (git/venv +
  installer layouts auto-detected), `config.yaml` presence/writability,
  Python prerequisites (`sqlite3` fatal, `fastapi` warn,
  `ruamel.yaml` optional — its validation downgrades to a warning instead
  of aborting), a **dry-run of both `server.py` patch anchors** (missing
  anchors abort BEFORE anything is written), and systemd detection
  (containers degrade to `--no-daemon` instead of failing).
- New `--doctor` flag: run the environment check alone and exit — handy to
  vet a host before installing (fleet use).
- Verified: piped install against a simulated installer-layout host
  (multiline import + trailing-comma tuple + foreign python) — hooks apply
  cleanly and idempotently; failure paths abort with the env knob that
  fixes them.

**Shipped in v0.7.1 / v5.2.1-web.1** — **display limit raised 200 → 2000**
in the web entry, lockstep with the desktop plugin's v5.2.1: the
activity-sorted top-200 cut fell *inside* a busy month window and hid
entire oldest days from the session list and histogram (all 18 sessions
of Oct 1 invisible). Backend (ledger daemon, routes) unchanged — only
`dashboard/web-entry.js` and `manifest.json` changed.

**Shipped in v0.7.0 / v5.2.0-web.1** — **server-side window aggregation**
on `/ledger` (`totals=1`), lockstep with the desktop plugin's v5.2.0:

- The route now aggregates the FULL window server-side (before the
  `limit` cut): `totals` `{sessions, input/cache_read/output tokens,
  api_call_count, by_model[], by_task[] (aux only), by_day[]}`, built
  from the same known counters that fill `sessions[]`
- Fixes the client's shrinking window totals: the display list is
  capped at `limit` (default 200) while the window is not — new sessions
  pushing old ones out of the top-200 silently shrank the sums
- `by_model` keys on `(model, billing_provider)` taken from the ledger
  grain row (grain-exact, correct for ledger-only sessions);
  `by_day` attributes per session on its activity day (same estimate
  the client histogram uses); the server stays price-free
- Without the param the response shape is unchanged (back-compat);
  `session_id` queries scope `totals` to that session
- Web entry (v5.2.0-web.1): summary totals + footer session count from
  `res.totals`, new i18n key `windowSessions`

**Shipped in v5.2.2-web.1** — **`deepseek-v4-1-flash-1017` pricing** (DeepSeek
V4.1 Flash 1017, now hosted on La Plateforme; official listing: $0.30 input /
$0.007 cached / $1.20 output per 1M tokens), lockstep with the desktop
plugin's v5.2.2. Backend (ledger daemon, routes) unchanged — only
`dashboard/web-entry.js` and `manifest.json` changed.

**Shipped in v5.1.2-web.1** — **`zai-glm-5-3-flash` pricing** (Z.ai GLM
5.3 Flash on La Plateforme, official listing: $0.15 input / $0.03 cached /
$0.50 output per 1M tokens), lockstep with the desktop plugin's v5.1.2.
Backend (ledger daemon, routes) unchanged — only `dashboard/web-entry.js`
and `manifest.json` changed.

**Shipped in v5.1.1-web.1** — **region (EU endpoint) pricing toggle** for
the web dashboard pane, lockstep with the desktop plugin's v5.1.1:
🌐/EU segmented buttons in the aggregate summary box, directly before the
Total label (desktop parity; v5.1.0-web.1 briefly had them in the header
toggle row). EU mode multiplies all token prices by 1.1 at the estimateCost
choke point — Mistral's api.eu.mistral.ai premium. Persisted via
`localStorage` (`token-stats:region`), same key as the desktop. Backend
(ledger daemon, routes) unchanged — only `dashboard/web-entry.js` and
`manifest.json` changed. Unpriced rows stay `—`, free models stay `0,00 €`.

**Shipped in v5.0.0-web.2** — the web dashboard entry now has the same
**language toggle** (DE, EN default, FR, NL, IT) and **currency toggle**
(€/$) as the desktop plugin's v5.0.x, ported under the existing
lockstep/parity rule (84-key dictionaries, byte-identical values). The
backend itself (ledger daemon, routes) is unchanged — only
`dashboard/web-entry.js` and `manifest.json` changed. Settings persist
via `localStorage` (`token-stats:lang` / `token-stats:currency`) — same
keys as the desktop. Since web.2 the histogram's cost-metric toggle icon
follows the active currency (€/$) instead of a hardcoded €.

**v0.8.0 (planned, alongside client v5.3)** — **Hermes WebApp support**
(the browser-hosted desktop served by the gateway, Hermes ≥ v0.22.6).
Status quo: the desktop plugin (`plugin.js`) already renders and works in
the WebApp as-is — pane and chip — when it is installed on the gateway
host (`~/.hermes/desktop-plugins/token-stats/`). The backend (ledger
daemon, routes, web entry) is **unchanged** by any of this today; the
roadmapped work (mobile-friendly pane UI, a documented one-step install
path) is client-side and tracked in the
[client repo's v5.3 roadmap entry](https://github.com/AndiAtom/hermes-token-stats#roadmap).
A backend release only becomes necessary if the install flow ends up
touching `install.sh` or the plugin package.

**macOS** — supported for the ledger core and the daemon:

- **Core**: `ledger/engine.py`, `poller.py`, `daemon.py` are pure Python
  stdlib and run on Darwin unmodified — verified by running the daemon
  against a live `state.db` on macOS 15 (multi-profile discovery, first-poll
  baselining and the idempotent no-op second cycle all behave as on Linux).
- **Daemon**: no systemd on macOS, so `install.sh` now writes a per-user
  **LaunchAgent** (`~/Library/LaunchAgents/ai.hermes.token-stats-ledger.plist`)
  and bootstraps it with `launchctl`. `RunAtLoad` + `KeepAlive` replace the
  systemd unit's enable-at-boot and restart-on-crash; logs go to
  `~/Library/Logs/token-stats/ledger.log`. A LaunchAgent needs a GUI login
  session — installing over plain SSH writes the plist but defers activation
  to the next login (the doctor reports this).
- **Installer**: `ss`, `setsid` and `grep -P` are Linux-only. The dashboard
  restart path now branches on `uname -s`, using `lsof` for the port probe
  and a plain `nohup` launch on Darwin. Verified with `bash -n` under
  macOS's stock bash 3.2 and no bash-4-only constructs (`mapfile`,
  `${x,,}`, `local -n`). One GNU-ism remains on the interpreter-probe path
  (`sort -V`), which degrades gracefully to `command -v python3` on macOS.

Remaining gap: **CI** still runs the ledger unit tests on Linux only. Add a
`macos-latest` job to verify the delta engine on Darwin per release — no
hardware required.

If you are a macOS user: run
`curl -fsSL .../install.sh | bash -s -- --doctor` and open an issue with
the output.

## Context

- Companion to the **[token-stats desktop plugin](https://github.com/AndiAtom/hermes-token-stats)**
  (plugin shows live + historical data; without this module its pane degrades
  to `live only`)
- `state.db` is per-profile; the `profile` parameter scaffolding is prepared in the handler
- Upstream candidate: cleanly submittable as a PR against NousResearch/hermes-agent
  (HandlerRegistry pattern, no writes, no new dependencies)

## License

[MIT](LICENSE) — © 2026 AndiAtom
