# Gesture scenarios run against a real headless GNOME Shell. Sourced by session.sh.
# Default (Standard) direction: moving left goes to the next workspace, right to the previous one.
F="python3 $HERE/fake_solaar.py"
rep() { local s=""; for i in $(seq 1 $2); do s="$s;$1"; done; echo "${s#;}"; }
gx() { gsettings --schemadir "$SCHEMAS" "$1" org.gnome.shell.extensions.solaar-workspace-glide "${@:2}"; sleep 0.4; }
ws() { ev "global.workspace_manager.get_active_workspace_index()" | grep -o "'[0-9]*'" | tr -d "'"; }
ov() { ev "Main.overview.visible" | grep -o "'[a-z]*'" | tr -d "'"; }
pass=0; fail=0
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
echo "RESULT: $pass passed, $fail failed"
