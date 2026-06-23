#!/usr/bin/env bash
# Vendor the delivery-team plugin (agents + commands + templates) into a target
# project's .claude/ directory. This is INSTALL.md Option C — the universal,
# zero-install path that works in any environment — and the way to keep a
# vendored copy (e.g. the demo) in lockstep with the plugin.
#
# Usage:
#   scripts/vendor.sh <target-project-dir>     # copy into <dir>/.claude/
#   scripts/vendor.sh --check <target-dir>     # report drift only, exit 1 if any
#
# Run from anywhere; paths are resolved against this script's location.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARTS=(agents commands templates)

CHECK=0
if [[ "${1:-}" == "--check" ]]; then CHECK=1; shift; fi

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "usage: $0 [--check] <target-project-dir>" >&2
  exit 2
fi
if [[ ! -d "$TARGET" ]]; then
  echo "error: target dir '$TARGET' does not exist" >&2
  exit 2
fi

DEST="$TARGET/.claude"

if [[ "$CHECK" == "1" ]]; then
  drift=0
  for part in "${PARTS[@]}"; do
    if ! diff -rq "$PLUGIN_ROOT/$part" "$DEST/$part" >/dev/null 2>&1; then
      echo "DRIFT: $part differs (or is missing) in $DEST"
      drift=1
    fi
  done
  if [[ "$drift" == "0" ]]; then
    echo "in sync — $DEST matches the plugin"
  fi
  exit "$drift"
fi

mkdir -p "$DEST"
for part in "${PARTS[@]}"; do
  rm -rf "${DEST:?}/$part"
  cp -r "$PLUGIN_ROOT/$part" "$DEST/$part"
  echo "vendored $part -> $DEST/$part"
done
echo "done. Commands appear as bare /deliver, /self-review; agents as @<name>."
