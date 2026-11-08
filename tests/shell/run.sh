#!/usr/bin/env bash
# Run the extension in a throwaway headless GNOME Shell and drive it with a
# fake Solaar that sends Movement Stream signals. Uses a private D-Bus and
# private XDG directories, so your session and settings are not touched.
# The helper extension turns on the shell's unsafe mode (for Eval) only in
# that private shell.
set -euo pipefail
HERE=$(dirname "$(readlink -f "$0")")
ROOT=$(readlink -f "$HERE/../..")
WORK=$(mktemp -d "${TMPDIR:-/tmp}/swg-shell-XXXXXX")   # short path: Wayland sockets are limited to 108 bytes
cleanup() {
    fusermount3 -u "$WORK/run/doc" 2>/dev/null || true
    rm -rf "$WORK" 2>/dev/null || { sleep 1; rm -rf "$WORK" 2>/dev/null; } || echo "note: could not remove $WORK"
}
trap cleanup EXIT
mkdir -p "$WORK/data/gnome-shell/extensions" "$WORK/config" "$WORK/run"
chmod 700 "$WORK/run"
EXT="$WORK/data/gnome-shell/extensions/solaar-workspace-glide@cimplex"
cp -r "$ROOT/extension" "$EXT"
glib-compile-schemas "$EXT/schemas"
cp -r "$HERE/helper" "$WORK/data/gnome-shell/extensions/swg-test-helper@local"

status=0
env -i HOME="$HOME" PATH=/usr/bin:/bin USER="${USER:-tester}" LANG=C.UTF-8 \
    XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache" \
    XDG_STATE_HOME="$WORK/state" XDG_RUNTIME_DIR="$WORK/run" XDG_DATA_DIRS=/usr/local/share:/usr/share \
    GSETTINGS_BACKEND=dconf SHELL_LOG="$WORK/shell.log" \
    timeout 240 dbus-run-session -- bash "$HERE/session.sh" > "$WORK/results.txt" 2>/dev/null || status=1
grep -E '^(PASS|FAIL|RESULT)' "$WORK/results.txt" || { echo "No results; the shell may not have started:"; tail -20 "$WORK/shell.log"; }
if grep -E 'JS ERROR|JS WARNING' "$WORK/shell.log"; then
    echo "GNOME Shell logged JavaScript errors (above)"
    status=1
fi
if [[ $status -ne 0 ]]; then
    echo "--- last extension log lines:"
    grep 'SolaarWorkspaceGlide' "$WORK/shell.log" | grep -v 'session bus' | tail -${LOG_LINES:-40}
fi
exit "$status"
