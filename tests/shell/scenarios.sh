# Gesture scenarios run against a real headless GNOME Shell. Sourced by session.sh.
# Default (Standard) direction: moving left goes to the next workspace, right to the previous one.
F="python3 $HERE/fake_solaar.py"
rep() { local s=""; for i in $(seq 1 $2); do s="$s;$1"; done; echo "${s#;}"; }
gx() { gsettings --schemadir "$SCHEMAS" "$1" org.gnome.shell.extensions.solaar-workspace-glide "${@:2}"; sleep 0.4; }
pass=0; fail=0
# Wait until no workspace switch or overview animation is running (up to 3 s).
settled() {
    for _ in $(seq 1 30); do
        ev "!Main.wm._workspaceAnimation._switchData && !Main.overview.animationInProgress" | grep -q "'true'" && return
        sleep 0.1
    done
}
ws() { settled; ev "global.workspace_manager.get_active_workspace_index()" | grep -o "'[0-9]*'" | tr -d "'"; }
ov() { settled; ev "Main.overview.visible" | grep -o "'[a-z]*'" | tr -d "'"; }
animating() { ev "Boolean(Main.wm._workspaceAnimation._switchData)" | grep -o "'[a-z]*'" | tr -d "'"; }
check() { # name expected actual
    if [[ "$2" == "$3" ]]; then pass=$((pass+1)); echo "PASS $1 ($3)"; else fail=$((fail+1)); echo "FAIL $1: expected $2, got $3"; fi
}
NEXT="$(rep -40,0 20)"; PREV="$(rep 40,0 20)"; UP="$(rep 0,-40 20)"; DOWN="$(rep 0,40 20)"
$F MX 416 "$NEXT" release;               check "move left: next workspace" 1 "$(ws)"
$F MX 416 "$NEXT" release;               check "again: next workspace" 2 "$(ws)"
$F MX 416 "$PREV" release;               check "move right: previous workspace" 1 "$(ws)"
$F MX 416 "3,0;2,0" release;             check "tap inside the dead zone does nothing" 1 "$(ws)"
$F MX 416 "$NEXT" cancel;                check "Ended(cancelled) returns to start" 1 "$(ws)"
$F MX 416 "$(rep -5,0 6)" release;       check "short move settles back" 1 "$(ws)"
$F MX 416 "$UP" release;                 check "move up: overview opens" true "$(ov)"
$F MX 416 "$DOWN" release;               check "move down: overview closes" false "$(ov)"
check "workspace unchanged by overview" 1 "$(ws)"
gx set listen-all-buttons false
$F MX 416 "$NEXT" release;               check "unselected button is ignored" 1 "$(ws)"
gx set selected-buttons "['MX:416']"
$F MX 416 "$NEXT" release;               check "selected button glides" 2 "$(ws)"
$F MX 195 "$NEXT" release;               check "other button still ignored" 2 "$(ws)"
gx set listen-all-buttons true
$F MX 416 "$PREV" none;                  check "Solaar quitting mid-hold cancels" 2 "$(ws)"
check "no modal grab left behind" 0 "$(ev 'Main.modalCount' | grep -o "'[0-9]*'" | tr -d "'")"
$F MX 416 "$PREV" release;               check "next hold after that works" 1 "$(ws)"
check "seen buttons recorded" "['MX:416', 'MX:195']" "$(gsettings --schemadir "$SCHEMAS" get org.gnome.shell.extensions.solaar-workspace-glide seen-buttons)"
ev "(async () => { await Main.extensionManager.disableExtension('solaar-workspace-glide@cimplex'); await Main.extensionManager.enableExtension('solaar-workspace-glide@cimplex'); return true; })()" >/dev/null; sleep 0.5
check "extension state after disable/enable" 1 "$(ev "Main.extensionManager.lookup('solaar-workspace-glide@cimplex').state" | grep -o "'[0-9]*'" | tr -d "'")"
$F MX 416 "$PREV" release;               check "glides after re-enable" 0 "$(ws)"

# Switch point and flicks. SHORT moves about a quarter of the way to the next workspace.
SHORT="$(rep -15,0 6)"
$F MX 416 "$SHORT" release;              check "short move stays at the default 50% switch point" 0 "$(ws)"
gx set switch-threshold-percent 20
$F MX 416 "$SHORT" release;              check "short move switches at a 20% switch point" 1 "$(ws)"
gx set switch-threshold-percent 50
gx set flick-min-speed 30
gx set flick-keep-percent 30
gx set flick-enabled true
FAKE_PAUSE=0 $F MX 416 "$SHORT" release; check "quick short move released at speed is a flick" 2 "$(ws)"
FAKE_PAUSE=0.3 $F MX 416 "$SHORT" release; check "same move with a pause before letting go is not" 2 "$(ws)"
FAKE_PAUSE=0 $F MX 416 "$(rep -15,0 4);$(rep 15,0 2);$(rep -15,0 2)" release; check "a move that turns back is not a flick" 2 "$(ws)"
FAKE_PAUSE=0 FAKE_INTERVAL=0.05 $F MX 416 "$(rep -15,0 6)" release; check "a slow move is not a flick" 2 "$(ws)"
FAKE_PAUSE=0 $F MX 416 "$(rep 0,-15 6)" release; check "an upward flick opens the overview" true "$(ov)"
FAKE_PAUSE=0 $F MX 416 "$(rep 0,15 6)" release;  check "a downward flick closes it" false "$(ov)"
gx set flick-enabled false

# Settling animates like a touchpad release (animations are on in this shell).
check "animations are on in this shell" true "$(ev "imports.gi.St.Settings.get().enable_animations" | grep -o "'[a-z]*'" | tr -d "'")"
ev "global.workspace_manager.get_workspace_by_index(0).activate(global.display.get_current_time_roundtrip())" >/dev/null
start=$(ws)
check "starting from the first workspace" 0 "$start"
FAKE_PAUSE=0 FAKE_AFTER=0 $F MX 416 "$(rep -20,0 10)" release   # about 60% of the way
check "release animates instead of snapping" true "$(animating)"
check "and then lands on the next workspace" $((start + 1)) "$(ws)"
gx set flick-enabled true
FAKE_PAUSE=0 FAKE_AFTER=0 $F MX 416 "$SHORT" release
FAKE_PAUSE=0 $F MX 416 "$SHORT" release
check "a second flick during the first settle carries on" $((start + 3)) "$(ws)"
gx set flick-enabled false
gsettings set org.gnome.desktop.interface enable-animations false; sleep 0.4
FAKE_PAUSE=0 FAKE_AFTER=0 $F MX 416 "$PREV" release
check "with animations off the release snaps at once" false "$(animating)"
check "to the previous workspace" $((start + 2)) "$(ws)"
gsettings set org.gnome.desktop.interface enable-animations true
echo "RESULT: $pass passed, $fail failed"
