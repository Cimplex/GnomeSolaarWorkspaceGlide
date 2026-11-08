#!/usr/bin/env bash
# Runs inside dbus-run-session with private XDG directories (see run.sh).
set -u
HERE=$(dirname "$(readlink -f "$0")")
T=$HERE
SCHEMAS=$XDG_DATA_HOME/gnome-shell/extensions/solaar-workspace-glide@cimplex/schemas
gsettings set org.gnome.shell enabled-extensions "['solaar-workspace-glide@cimplex', 'swg-test-helper@local']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
gsettings set org.gnome.mutter dynamic-workspaces false
gsettings set org.gnome.desktop.wm.preferences num-workspaces 4
gsettings set org.gnome.desktop.interface enable-animations true   # the default; some checks turn it off
gsettings --schemadir "$SCHEMAS" set org.gnome.shell.extensions.solaar-workspace-glide debug-progress true

gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x800 > "$SHELL_LOG" 2>&1 &
SHELL_PID=$!
ev() { gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.gnome.Shell.Eval "$1" 2>&1; }
for _ in $(seq 1 150); do
    ev 1 | grep -q true && break
    sleep 0.2
done
ev "Main.overview.hide()" >/dev/null   # the shell starts in the overview, like a fresh login
sleep 1
source "${SCENARIOS:-$HERE/scenarios.sh}"
kill "$SHELL_PID"; wait "$SHELL_PID" 2>/dev/null
# The shell may have started the document portal, which mounts a FUSE file system here.
fusermount3 -u "$XDG_RUNTIME_DIR/doc" 2>/dev/null || fusermount -u "$XDG_RUNTIME_DIR/doc" 2>/dev/null || true
[[ $fail -eq 0 ]]
