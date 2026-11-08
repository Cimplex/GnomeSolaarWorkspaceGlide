#!/usr/bin/env bash
# Build a zip that `gnome-extensions install` accepts, in dist/.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
mkdir -p dist
gnome-extensions pack extension --force --out-dir=dist \
    --extra-source=gesture.js --extra-source=movementStream.js --extra-source=motion.js \
    --extra-source=nativeDrag.js --extra-source=nativeOverviewDrag.js --extra-source=pointerHold.js \
    --extra-source=solaarDiscovery.js --extra-source=solaarTools.js --extra-source=solaarProbe.py \
    --extra-source=testService.js
ls -1 dist/*.shell-extension.zip
