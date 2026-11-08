#!/usr/bin/env bash
# Syntax, schema and unit tests. Needs node (tests only) and glib2.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

for source_file in extension/*.js; do node --check "$source_file"; done
python3 -m py_compile extension/solaarProbe.py && rm -rf extension/__pycache__
bash -n install.sh uninstall.sh pack.sh
glib-compile-schemas --strict --dry-run extension/schemas
node --test tests/*.test.js
