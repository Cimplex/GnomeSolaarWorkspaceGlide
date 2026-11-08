#!/usr/bin/env bash
# Install the extension for the current user. Run without sudo.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

uuid=$(python3 -c 'import json; print(json.load(open("extension/metadata.json"))["uuid"])')
target="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

if [[ $EUID -eq 0 ]]; then
    echo "Run ./install.sh as your normal user, without sudo." >&2
    exit 1
fi

mkdir -p "$target/schemas"
cp extension/*.js extension/solaarProbe.py extension/metadata.json "$target/"
cp extension/schemas/*.gschema.xml "$target/schemas/"
glib-compile-schemas "$target/schemas"

echo "Installed to $target"
if gnome-extensions info "$uuid" >/dev/null 2>&1; then
    echo "Turn it on with:  gnome-extensions enable $uuid"
    echo "If it was already on, log out and back in to load the new version."
else
    echo "Log out and back in so GNOME Shell finds it, then run:"
    echo "  gnome-extensions enable $uuid"
fi
