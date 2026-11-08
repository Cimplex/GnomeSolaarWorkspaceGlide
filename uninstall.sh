#!/usr/bin/env bash
# Remove the extension for the current user. Settings stay in dconf.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

uuid=$(python3 -c 'import json; print(json.load(open("extension/metadata.json"))["uuid"])')
target="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

gnome-extensions disable "$uuid" 2>/dev/null || true
rm -rf -- "$target"
echo "Removed $target"
echo "Settings are kept. To clear them too:  dconf reset -f /org/gnome/shell/extensions/solaar-workspace-glide/"
