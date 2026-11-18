#!/usr/bin/env bash
# All-in-one installer for the token-stats backend stack:
#
#   1. Plugin package → ~/.hermes/plugins/token-stats/
#      (backend routes incl. the WEB DASHBOARD pane entry, web-entry.js)
#   2. plugins.enabled += token-stats in ~/.hermes/config.yaml
#      (edit via ruamel round-trip — comments preserved, backup first)
#   3. Known-ledger daemon → systemd unit token-stats-ledger.service
#      (template paths to THIS repo + the chosen python, enable + start)
#   4. Dashboard restart (port 9119) so the backend mounts
#   5. Smoke check (health route answers 200/401 = mounted, 404 = not)
#
# Idempotent: safe to re-run at any time (e.g. to refresh the plugin
# package after a git pull).
#
# NOTE (v1.0.0): the legacy gateway RPC hooks (usage.history /
# usage.totals, server.py patching) were REMOVED — the plugin backend is
# the supported data path. This installer no longer touches $HERMES_LIB.
#
# Python: the daemon is pure stdlib; fastapi for the plugin backend comes
# from the Hermes host runtime. The script therefore uses the Hermes-bundled
# python (venv shim → tools python) and only VERIFIES importability instead
# of pip-installing anything — nothing outside Hermes itself is needed.
#
# token-stats installer — TWO install modes (v1.0.0):
#
#   1. Full ledger stack (default): plugin backend + known-ledger daemon
#      (history pane with monotonic known counters, custom prices store,
#      web dashboard pane) — everything runs against the dashboard :9119.
#   2. Client-only (--client-only): solely the DESKTOP plugin file,
#      plugin.js → ~/.hermes/desktop-plugins/token-stats/. No backend,
#      no daemon, no dashboard restart — the pane then runs live-only
#      (no session history). For users who just want the chip/pane
#      without any server-side setup.
#
# One-liner (detects the pipe, clones the repo first, then re-execs itself):
#
#   full:      curl -fsSL https://raw.githubusercontent.com/AndiAtom/hermes-token-stats/main/backend/install.sh | bash -s -- --yes
#   client:    curl -fsSL https://raw.githubusercontent.com/AndiAtom/hermes-token-stats/main/backend/install.sh | bash -s -- --client-only --yes
#
# Flags / env:
#   --client-only    install only the desktop plugin file (no backend)
#   --hermes-home X  Hermes home directory      (default ~/.hermes; env
#                    HERMES_HOME applies too — flag wins over env)
#   --no-daemon      skip the ledger daemon setup (plugin backend only)
#   --no-restart     do not restart the dashboard (you do it yourself)
#   --yes | ASSUME_YES=1   non-interactive (default answer yes)
#   --doctor         check the environment (paths, python prereqs,
#                    systemd) and exit — install nothing
#   HERMES_LIB       Hermes install root   (default /usr/local/lib/hermes-agent)
#   HERMES_HOME      Hermes home            (default ~/.hermes)
#   DASHBOARD_PORT   dashboard port        (default 9119)
#   INSTALL_DIR      curl-mode clone target (default ~/.hermes-token-stats)
#   REPO_URL         curl-mode clone source (default this repo on GitHub)
set -euo pipefail

# ── curl | bash bootstrap ─────────────────────────────────────────────
# When this script is piped in (curl ... | bash), BASH_SOURCE is unset and
# that case: clone the repo to a PERSISTENT location (the ledger daemon unit
# templates WorkingDirectory= to the repo — a temp clone would break it),
# then re-exec the installer from there with all flags preserved.
if [ -z "${BASH_SOURCE[0]:-}" ]; then
  REPO_URL="${REPO_URL:-https://github.com/AndiAtom/hermes-token-stats.git}"
  INSTALL_DIR="${INSTALL_DIR:-$HOME/.hermes-token-stats}"
  printf '\033[1;34m[..]\033[0m %s\n' "piped installer: cloning/updating $INSTALL_DIR from $REPO_URL"
  command -v git >/dev/null 2>&1 \
    || { printf '\033[1;31m[ERROR]\033[0m %s\n' "git not found — required for the curl install" >&2; exit 1; }
  if [ -d "$INSTALL_DIR/.git" ]; then
    git -C "$INSTALL_DIR" pull --ff-only \
      || printf '\033[1;33m[!!]\033[0m %s\n' "git pull failed — continuing with the existing checkout"
  else
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
  exec bash "$INSTALL_DIR/backend/install.sh" "$@"
fi

# --hermes-home <dir>: flag wins over the HERMES_HOME env (both optional;
# default ~/.hermes). Parsed up front — the whole flag/arg processing is
# ONE while/shift loop here so value flags can consume their argument.
# The mode/update flags set shell vars consumed further below.
DO_DAEMON=1
DO_RESTART=1
DOCTOR=0
CLIENT_ONLY=0
HERMES_HOME_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --client-only) CLIENT_ONLY=1 ;;
    --no-daemon) DO_DAEMON=0 ;;
    --no-restart) DO_RESTART=0 ;;
    --yes) ASSUME_YES=1 ;;
    --doctor) DOCTOR=1 ;;
    --hermes-home) shift; [ $# -gt 0 ] && HERMES_HOME_ARG="$1" || { echo "[error] --hermes-home needs a directory argument" >&2; exit 2; } ;;
    --hermes-home=*) HERMES_HOME_ARG="${1#--hermes-home=}" ;;
    *) echo "[error] unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done
if [ -n "$HERMES_HOME_ARG" ]; then
  HERMES_HOME="$HERMES_HOME_ARG"
else
  HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
fi
HERMES_LIB="${HERMES_LIB:-/usr/local/lib/hermes-agent}"
# Installer layouts (curl installer) keep the checkout in $HERMES_HOME/hermes-agent
# with NO /usr/local install — auto-detect that layout instead of dying in preflight.
if [ ! -d "$HERMES_LIB" ] && [ -d "$HERMES_HOME/hermes-agent" ]; then
  HERMES_LIB="$HERMES_HOME/hermes-agent"
fi
DASHBOARD_PORT="${DASHBOARD_PORT:-9119}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Python resolution, layout-aware:
#   git installs  → $HERMES_LIB/venv/bin/python (deps bundled)
#   installer     → bundled tools python (deps live in the uv cache, same as the
#                   gateway runtime, which runs the same interpreter with -I and
#                   the archive on sys.path). PYTHONPATH is extended so the
#                   ruamel config validation and the fastapi probe work.
if [ -x "$HERMES_LIB/venv/bin/python" ]; then
  PY="$HERMES_LIB/venv/bin/python"
else
  PY="$(ls -d "$HERMES_HOME"/tools/python-*/bin/python3 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$PY" ] || PY="$(command -v python3)"
  for _uvdir in "$HERMES_HOME"/cache/uv/archive-v0/*/; do
    [ -d "$_uvdir" ] && PYTHONPATH="${PYTHONPATH:+$PYTHONPATH:}$_uvdir"
  done
  export PYTHONPATH
fi

# (Arg parsing happened up front — see the while/shift loop near the top;
# DO_DAEMON/DO_RESTART/DOCTOR/CLIENT_ONLY keep their parsed values.)

say()  { printf '\033[1;32m[ok]\033[0m  %s\n' "$*"; }
info() { printf '\033[1;34m[..]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

# ── client-only: desktop plugin file only, then exit ──────────────────
# No backend, no daemon, no dashboard restart, no config edit — the
# plugin degrades gracefully (chip + live-only pane). Ledger backend
# can be added later by re-running the installer WITHOUT --client-only.
# (Placed here because it needs say/die — defined above. --doctor wins
# over --client-only: a combined invocation checks the environment and
# installs NOTHING, consistent with --doctor semantics.)
if [ "$CLIENT_ONLY" = "1" ] && [ "$DOCTOR" = "0" ]; then
  DEST_DIR="$HERMES_HOME/desktop-plugins/token-stats"
  mkdir -p "$DEST_DIR"
  install -m 0644 "$HERE/../plugin.js" "$DEST_DIR/plugin.js"
  if diff -q "$HERE/../plugin.js" "$DEST_DIR/plugin.js" >/dev/null; then
    say "client-only: plugin.js → $DEST_DIR/plugin.js"
  else
    die "client-only: plugin copy failed the diff check"
  fi
  cat <<EOF

Done (client-only). What to check next:
  • Desktop app: ⌘K → "Reload desktop plugins" — the Token Stats Ledger
    chip + pane appear. Without the ledger backend the pane shows
    live-only data (no session history, no custom prices via backend).
  • Want history + custom prices later? Re-run this installer WITHOUT
    --client-only on the machine running the dashboard (port 9119).
  • Manual price overrides work even client-only: drop a prices.json
    next to the plugin file (see the README "Custom prices").
EOF
  exit 0
fi

# ── Preflight ────────────────────────────────────────────────────────
# Fail-fast environment check. Everything the later steps touch is verified
# HERE, before a single file is copied or patched — and every failure message
# names the env knob that fixes it. P=pass, W=warning, F=fatal.
CONFIG="$HERMES_HOME/config.yaml"
echo "── preflight ─────────────────────────────────────────────"
P=0; W=0; F=0
pass() { printf '  [P] %s\n' "$*"; P=$((P+1)); }
skp() { printf '  [W] %s\n' "$*"; W=$((W+1)); }
bad() { printf '  [F] %s\n' "$*"; F=$((F+1)); }

# (1) Hermes install root (git layout, /usr/local, or installer layout)
if [ -d "$HERMES_LIB" ]; then
  pass "Hermes install: $HERMES_LIB ($( [ -x "$HERMES_LIB/venv/bin/python" ] && echo 'git/venv layout' || echo 'installer layout, bundled tools python'))"
else
  bad "Hermes install not found at $HERMES_LIB (set HERMES_LIB; installer layouts live in \$HERMES_HOME/hermes-agent)"
fi

# (2) Hermes home + config
if [ -d "$HERMES_HOME" ]; then
  pass "Hermes home: $HERMES_HOME"
else
  bad "Hermes home not found at $HERMES_HOME (set HERMES_HOME)"
fi
if [ -f "$CONFIG" ]; then
  if [ -w "$CONFIG" ]; then
    pass "config.yaml present and writable: $CONFIG"
  else
    bad "config.yaml not writable: $CONFIG (run as the Hermes user or with sudo)"
  fi
else
  bad "config not found: $CONFIG (set HERMES_HOME)"
fi

# (3) Python + prerequisites
if [ -x "$PY" ]; then
  pass "python: $PY"
else
  bad "Hermes python not found at $PY (broken Hermes install? set HERMES_LIB)"
fi
if [ -x "$PY" ] && "$PY" -c "import sqlite3" 2>/dev/null; then
  pass "python can import sqlite3 (ledger daemon requirement)"
else
  bad "python at $PY cannot import sqlite3 — ledger daemon will not run (broken Hermes python?)"
fi
if [ -x "$PY" ] && "$PY" -c "import fastapi" 2>/dev/null; then
  pass "python can import fastapi (plugin backend requirement)"
else
  skp "python at $PY cannot import fastapi — plugin backend routes will NOT load. Fastapi ships WITH Hermes normally; check your installation."
fi
if [ -x "$PY" ] && "$PY" -c "from ruamel.yaml import YAML" 2>/dev/null; then
  RUAMEL_OK=1
  pass "python can import ruamel.yaml (config.yaml validation)"
else
  RUAMEL_OK=0
  skp "python at $PY cannot import ruamel.yaml — config.yaml edit will skip the YAML parse validation"
fi

# (4) server.py writability — LEGACY CHECK REMOVED (v1.0.0): the installer
# no longer patches $HERMES_LIB (no gateway hooks). Kept as a no-op block
# marker so the preflight numbering in the README stays matching.

# (5) systemd (daemon setup); degraded mode without it
if [ "$DO_DAEMON" = "1" ]; then
  LEDGER_BASE_PF="${LEDGER_BASE:-$HOME/token-stats-ledger}"
  if ! mkdir -p "$LEDGER_BASE_PF" 2>/dev/null; then
    bad "cannot create the ledger base directory $LEDGER_BASE_PF (set LEDGER_BASE to a writable path)"
  elif touch "$LEDGER_BASE_PF/.ts-write-probe" 2>/dev/null; then
    rm -f "$LEDGER_BASE_PF/.ts-write-probe"
    pass "ledger base writable: $LEDGER_BASE_PF"
  else
    bad "ledger base not writable: $LEDGER_BASE_PF — daemon cannot create its DBs (permissions? set LEDGER_BASE)"
  fi
  if command -v systemctl >/dev/null 2>&1; then
    if [ "$(id -u)" = "0" ]; then
      if systemctl list-units >/dev/null 2>&1; then
        pass "systemd available (ledger daemon as SYSTEM unit token-stats-ledger.service)"
      else
        skp "systemctl not usable here — running in degraded mode: --no-daemon, poll the ledger manually via '$PY -m ledger.daemon' in a loop"
        DO_DAEMON=0
      fi
    else
      # Non-root: USER unit (systemd --user). Requires a user session
      # (XDG_RUNTIME_DIR / dbus) — absent on headless SSH into fresh systems.
      if systemctl --user list-units >/dev/null 2>&1; then
        pass "systemd user manager available (ledger daemon as USER unit, no sudo needed)"
      else
        skp "systemd --user not usable (no user session / XDG_RUNTIME_DIR) — degraded mode: --no-daemon. Fix: log in properly (not 'sudo su'), or run the daemon via tmux: $PY -m ledger.daemon"
        DO_DAEMON=0
      fi
    fi
  else
    skp "systemctl not found — degraded mode: --no-daemon, poll the ledger manually via '$PY -m ledger.daemon' in a loop"
    DO_DAEMON=0
  fi
fi
command -v ss >/dev/null 2>&1 || skp "ss not found — dashboard restart falls back to systemctl only"

echo "  ── $P passed, $W warnings, $F fatal"
if [ "$F" -gt 0 ]; then
  die "preflight failed — fix the [F] items above (fatal), then re-run"
fi
if [ "$DOCTOR" = "1" ]; then
  if [ "$W" -gt 0 ]; then
    warn "doctor: $W warning(s) — see [W] items above; install would continue with degraded features"
  else
    say "doctor: environment fully ready for install"
  fi
  exit 0
fi

# ── 1. Plugin package (backend + web dashboard entry) ────────────────
mkdir -p "$HERMES_HOME/plugins/token-stats"
cp -r "$HERE/plugin_pkg/token-stats/." "$HERMES_HOME/plugins/token-stats/"
# byte-verify (skip __pycache__ which the host may have created, and
# user_prices.json which is the USER's override store — v1.0.0: the file
# is never shipped in the repo, so a leftover store must not fail deploys)
if diff -r --exclude=__pycache__ --exclude=user_prices.json "$HERE/plugin_pkg/token-stats" "$HERMES_HOME/plugins/token-stats" >/dev/null; then
  say "plugin package → $HERMES_HOME/plugins/token-stats/ (backend + web entry)"
else
  die "plugin package copy failed the diff check"
fi
[ -f "$HERMES_HOME/plugins/token-stats/dashboard/web-entry.js" ] \
  || die "web-entry.js missing in the deployed package (outdated repo clone? git pull)"

# ── 2. Enable the plugin in config.yaml (surgical text insert) ────────
# NO YAML-library round-trip: ruamel reflows the ENTIRE file (indent flips,
# line wrapping, quote styles) even though it preserves comments — verified
# the hard way on a live config. Instead: insert exactly one list item,
# leaving every other byte untouched.
# Hardened for FOREIGN configs (v0.6.2): finds `enabled:` anywhere in the
# plugins block (any key order, comments in between), creates the section
# or the key when missing, handles flow-style lists ([a, b]) and CRLF line
# endings, and REFUSES unrecognized layouts loudly instead of guessing —
# the ruamel validation afterwards is the hard guarantee that nothing
# broken ever reaches the config.
if grep -qE '^\s*-\s*["'"'"']?token-stats["'"'"']?\s*$' "$CONFIG"; then
  say "plugins.enabled already contains token-stats"
else
  # Never clobber an existing backup from a previous run.
  if [ ! -f "$CONFIG.bak-token-stats" ]; then
    cp "$CONFIG" "$CONFIG.bak-token-stats"
  else
    cp "$CONFIG" "$CONFIG.bak-token-stats.$$"
    warn "backup $CONFIG.bak-token-stats existed — wrote $CONFIG.bak-token-stats.$$ instead"
  fi
  TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
  cat > "$TMP" <<'PYEOF'
import re, sys

PLUGIN = "token-stats"
ITEM = "    - " + PLUGIN + "\n"
path = sys.argv[1]
raw = open(path, newline="").read()
crlf = "\r\n" in raw
lines = raw.splitlines(keepends=True)
eol = "\r\n" if crlf else "\n"
out, i, inserted = [], 0, False


def norm(s):
    return s.rstrip("\r\n")


def item_text(s):
    # list item body after '- ', quotes stripped
    return s.strip()[2:].strip().strip("'\"").strip()


while i < len(lines):
    line = lines[i]
    out.append(line)

    # Case A: plugins: block -> locate `enabled:` key ANYWHERE inside the
    # block (any key order, comments between keys). Indent-based: a new
    # top-level key (indent 0) or a key at plugins' own indent ends the block.
    if norm(line) == "plugins:":
        p_indent = 0  # top-level block key by definition
        j = i + 1
        block_end = len(lines)
        enabled_at = None
        while j < len(lines):
            l = norm(lines[j])
            if not l or l.lstrip().startswith("#"):
                j += 1
                continue
            indent = len(l) - len(l.lstrip())
            if indent <= p_indent and not l.lstrip().startswith("- "):
                block_end = j
                break
            if re.match(r"^\s*enabled:\s*(.*)$", l):
                # only the plugins' OWN enabled key (same indent level as
                # sibling keys, not nested deeper)
                if enabled_at is None:
                    enabled_at = j
            j += 1
        if enabled_at is not None:
            e = lines[enabled_at]
            rest = re.match(r"^\s*enabled:\s*(.*)$", norm(e)).group(1).strip()
            if rest.startswith("["):
                # flow style: enabled: [a, b] -> insert into the brackets
                inner = rest[1:-1].strip() if rest.endswith("]") else None
                if inner is None:
                    sys.exit("[error] plugins.enabled flow list not closed on one line — edit by hand")
                items = [x.strip() for x in inner.split(",") if x.strip()]
                if any(item_text("  - " + x) == PLUGIN for x in items):
                    print("[ok] plugins.enabled already contains token-stats (flow)")
                    sys.exit(0)
                items.append(PLUGIN)
                indent = len(norm(e)) - len(norm(e).lstrip())
                new = " " * indent + "enabled: [" + ", ".join(items) + "]"
                lines[enabled_at] = new + eol
                open(path, "w", newline="").writelines(lines)
                sys.exit(0)
            # block style: append after the last item of the list
            k = enabled_at + 1
            while k < block_end and norm(lines[k]).lstrip().startswith("- "):
                k += 1
            if k == enabled_at + 1:
                sys.exit("[error] plugins.enabled found but empty — add '    - token-stats' by hand")
            item_indent = re.match(r"^\s*-", norm(lines[enabled_at + 1])).group(0)
            out = lines[:k] + [item_indent.replace("-", "- " + PLUGIN) + eol] + lines[k:]
            open(path, "w", newline="").writelines(out)
            print("[ok] plugins.enabled += token-stats (backup: config.yaml.bak-token-stats)")
            sys.exit(0)
        # enabled: missing in the block -> insert it right after plugins:,
        # matching the block's key indent (or default 2 spaces)
        key_indent = "  "
        for l in lines[i + 1:block_end]:
            n = norm(l)
            if n and not n.lstrip().startswith("#") and not n.lstrip().startswith("- "):
                key_indent = n[: len(n) - len(n.lstrip())]
                break
        out = lines[: i + 1] + [key_indent + "enabled:" + eol, key_indent + "  - " + PLUGIN + eol] + lines[i + 1:]
        open(path, "w", newline="").writelines(out)
        print("[ok] plugins.enabled created under plugins: (backup: config.yaml.bak-token-stats)")
        sys.exit(0)

    i += 1

# Case B: no plugins: block at all -> append section at EOF (fresh installs).
new_eol = eol if (lines and lines[-1].endswith(eol)) else ("\r\n" if crlf else "\n")
out = lines + ["", "plugins:" + new_eol, "  enabled:" + new_eol, "    - " + PLUGIN + new_eol]
open(path, "w", newline="").writelines(out)
print("[ok] plugins section appended (backup: config.yaml.bak-token-stats)")
PYEOF
  "$PY" "$TMP" "$CONFIG"
  # Validate the result parses as YAML using Hermes' own ruamel — skipped
  # with a warning when ruamel is unavailable (foreign python layouts).
  if [ "${RUAMEL_OK:-0}" = "1" ]; then
    "$PY" -c "from ruamel.yaml import YAML; d = YAML().load(open('$CONFIG')); assert 'token-stats' in d['plugins']['enabled'], 'entry missing after edit'; print('[ok] config.yaml parses, token-stats enabled')" \
      || die "config.yaml edit failed validation — restore from $CONFIG.bak-token-stats"
  else
    warn "ruamel unavailable — skipped the config.yaml parse validation (insert was surgical; verify by hand if unsure)"
  fi
fi

# ── 3. Known-ledger daemon (systemd) ─────────────────────────────────
if [ "$DO_DAEMON" = "1" ]; then
  LEDGER_BASE="${LEDGER_BASE:-$HOME/token-stats-ledger}"
  mkdir -p "$LEDGER_BASE"

  UNIT_SRC="$HERE/ledger/token-stats-ledger.service"
  # Template the unit: python + repo dir are host-specific and systemd does
  # no ~/$HOME expansion in ExecStart/WorkingDirectory. The sed patterns
  # anchor on the three known keys of the shipped unit file (ExecStart=,
  # WorkingDirectory=, Environment=PYTHONPATH=) — full-line replacement,
  # so paths containing spaces would still land correctly.
  # Ledger paths do NOT need templating: daemon and plugin backend both
  # resolve ~/token-stats-ledger at runtime in their own process — they
  # agree as long as both run as the SAME user (root system unit / root
  # dashboard, or user unit / user dashboard).
  # Unit scope follows the invoking user: a non-root user gets a USER unit
  # (systemd --user) — running a root system unit would write the ledger
  # to /root/token-stats-ledger while the user-owned dashboard process
  # reads ~/token-stats-ledger → empty pane, plus root-owned WAL/shm files
  # the user could not write. User units need lingering enabled for
  # headless hosts (survive logout); warned about below.
  write_unit() {
    # User units boot via default.target (multi-user.target does not exist
    # in the user manager — enable would link a dead target and the daemon
    # would not autostart at next login).
    if [ "$(id -u)" = "0" ]; then WANT="multi-user.target"; else WANT="default.target"; fi
    sed -e "s|ExecStart=.*|ExecStart=$PY -m ledger.daemon|" \
        -e "s|WorkingDirectory=.*|WorkingDirectory=$HERE|" \
        -e "s|Environment=PYTHONPATH=.*|Environment=PYTHONPATH=$HERE|" \
        -e "s|^WantedBy=.*|WantedBy=$WANT|" \
        "$UNIT_SRC"
  }
  if [ "$(id -u)" = "0" ]; then
    UNIT_DST="/etc/systemd/system/token-stats-ledger.service"
    if [ -f "$UNIT_DST" ] && [ -w "$UNIT_DST" ]; then
      write_unit > "$UNIT_DST"
    elif command -v sudo >/dev/null 2>&1; then
      write_unit | sudo tee "$UNIT_DST" >/dev/null
    else
      write_unit > "$UNIT_DST"
    fi
    systemctl daemon-reload
    systemctl enable --now token-stats-ledger.service
  else
    # Non-root: USER unit — no sudo needed, no root-owned ledger files.
    # Old system-unit installs (root-era) must not shadow the user unit.
    if [ -f /etc/systemd/system/token-stats-ledger.service ]; then
      warn "found a ROOT system unit /etc/systemd/system/token-stats-ledger.service from an earlier root install — it writes the ledger to /root/... while your dashboard reads ~/token-stats-ledger. Stop/disable it as root if this host was previously installed as root."
    fi
    UNIT_DST="$HOME/.config/systemd/user/token-stats-ledger.service"
    mkdir -p "$HOME/.config/systemd/user"
    write_unit > "$UNIT_DST"
    systemctl --user daemon-reload
    systemctl --user enable --now token-stats-ledger.service
    # Headless hosts: user units die at logout unless lingering is enabled.
    if ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
      if loginctl enable-linger "$USER" 2>/dev/null; then
        say "enabled lingering for user $USER (user unit survives logout on headless hosts)"
      else
        warn "could not enable lingering for $USER — the daemon stops when you log out. Fix: sudo loginctl enable-linger $USER"
      fi
    fi
  fi
  sleep 2
  if [ "$(id -u)" = "0" ]; then
    ACTIVE=0; systemctl is-active --quiet token-stats-ledger.service && ACTIVE=1
  else
    ACTIVE=0; systemctl --user is-active --quiet token-stats-ledger.service && ACTIVE=1
  fi
  if [ "$ACTIVE" = "1" ]; then
    say "ledger daemon active (unit templated: python=$PY, repo=$HERE, scope=$( [ "$(id -u)" = "0" ] && echo system || echo user))"
  else
    warn "ledger daemon did not come up — check: journalctl $( [ "$(id -u)" = "0" ] || echo '--user') -u token-stats-ledger -n 30"
  fi
fi

# ── 4. Restart the dashboard so the backend + web entry mount ─────────
# IMPORTANT: the desktop app and the web dashboard talk to the DASHBOARD
# process (default port 9119), not the messaging gateway. The plugin
# manifest/script caches are per-process — without a restart the new
# web entry stays invisible.
if [ "$DO_RESTART" = "1" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl --user is-active hermes-dashboard.service >/dev/null 2>&1; then
      systemctl --user restart hermes-dashboard.service; info "restarted user unit hermes-dashboard.service"
    elif systemctl is-active hermes-dashboard.service >/dev/null 2>&1; then
      sudo systemctl restart hermes-dashboard.service; info "restarted system unit hermes-dashboard.service"
    fi
  fi
  # Fallback (and Andi's setup): dashboard runs as a bare process on the port.
  if ! ss -tln 2>/dev/null | grep -q ":$DASHBOARD_PORT "; then
    info "no listener on :$DASHBOARD_PORT — starting one"
    setsid nohup hermes dashboard --host 0.0.0.0 --port "$DASHBOARD_PORT" --no-open \
      >> "$HERMES_HOME/dashboard-restart.log" 2>&1 &
  else
    PID="$(ss -tlnp 2>/dev/null | grep ":$DASHBOARD_PORT " | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
    if [ -n "$PID" ]; then
      kill "$PID"
      for _ in $(seq 1 10); do ss -tln 2>/dev/null | grep -q ":$DASHBOARD_PORT " || break; sleep 1; done
      setsid nohup hermes dashboard --host 0.0.0.0 --port "$DASHBOARD_PORT" --no-open \
        >> "$HERMES_HOME/dashboard-restart.log" 2>&1 &
      info "old dashboard (PID $PID) killed, relaunching"
    fi
  fi
  # wait for the port to accept connections again
  UP=0
  for _ in $(seq 1 20); do
    if ss -tln 2>/dev/null | grep -q ":$DASHBOARD_PORT "; then UP=1; break; fi
    sleep 1
  done
  if [ "$UP" = "1" ]; then
    say "dashboard listening on :$DASHBOARD_PORT (log: $HERMES_HOME/dashboard-restart.log)"
  else
    warn "dashboard did not come back on :$DASHBOARD_PORT within 20 s — start it manually: hermes dashboard --port $DASHBOARD_PORT --no-open"
  fi
fi

# ── 5. Smoke check ────────────────────────────────────────────────────
sleep 2
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$DASHBOARD_PORT/api/plugins/token-stats/health" || true)"
case "$CODE" in
  200) say "smoke: /api/plugins/token-stats/health → 200 (backend mounted, auth open on loopback)" ;;
  401) say "smoke: health route answers 401 → backend MOUNTED (auth-gated; log into the dashboard to use it)" ;;
  404) warn "smoke: health route → 404 — backend not mounted. Was the dashboard restarted? Is token-stats in plugins.enabled? Restart the dashboard process and reload." ;;
  000) warn "smoke: dashboard on :$DASHBOARD_PORT not reachable (skipped)" ;;
  *)   warn "smoke: unexpected status $CODE — check the dashboard log" ;;
esac

if [ "$(id -u)" = "0" ]; then
  STAT_CMD="systemctl status token-stats-ledger"
else
  STAT_CMD="systemctl --user status token-stats-ledger"
fi
cat <<EOF

Done. What to check next:
  • Web dashboard:  open http://<host>:9119/token-stats  (hard-reload if open) — Token Stats tab in the sidebar
  • Desktop plugin: the installer just deployed it — reload in the app via ⌘K → "Reload desktop plugins" (client-only installs: re-run with --client-only)
  • Daemon:         $STAT_CMD
EOF
