#!/usr/bin/env bash
# One-command installer: deploy the delivery-team GitHub Copilot integration into
# a target repo AND enable the two VS Code settings it needs — so a teammate only
# has to open the repo and reload.
#
# Usage:
#   integrations/github-copilot/install.sh <target-repo-dir>   # default: current dir
#   integrations/github-copilot/install.sh --check <dir>       # report only, no writes
#
# What it does:
#   1. Copies .github/{copilot-instructions.md, prompts/, chatmodes/} into <dir>.
#      It NEVER touches <dir>/.github/workflows/ (your real CI stays put).
#   2. Writes/merges <dir>/.vscode/settings.json to enable:
#        chat.promptFiles = true
#        github.copilot.chat.codeGeneration.useInstructionFiles = true
#      (workspace-scoped, so every teammate who opens the repo gets it — no
#       per-user Settings clicking).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CHECK=0
if [[ "${1:-}" == "--check" ]]; then CHECK=1; shift; fi
TARGET="${1:-$PWD}"
[[ -d "$TARGET" ]] || { echo "error: target '$TARGET' is not a directory" >&2; exit 2; }

SETTINGS=("chat.promptFiles" "github.copilot.chat.codeGeneration.useInstructionFiles")

if [[ "$CHECK" == "1" ]]; then
  drift=0
  for part in copilot-instructions.md prompts chatmodes; do
    diff -rq "$SRC/.github/$part" "$TARGET/.github/$part" >/dev/null 2>&1 \
      || { echo "DRIFT/missing: .github/$part"; drift=1; }
  done
  vs="$TARGET/.vscode/settings.json"
  if [[ -f "$vs" ]] && grep -q "chat.promptFiles" "$vs" 2>/dev/null; then
    echo "vscode settings: present"
  else
    echo "vscode settings: MISSING chat.promptFiles"; drift=1
  fi
  [[ "$drift" == "0" ]] && echo "in sync — $TARGET is set up for Copilot"
  exit "$drift"
fi

# 1. Copy the Copilot files (chatmodes + prompts + instructions), not workflows.
mkdir -p "$TARGET/.github/prompts" "$TARGET/.github/chatmodes"
cp "$SRC/.github/copilot-instructions.md" "$TARGET/.github/copilot-instructions.md"
cp "$SRC/.github/prompts/"*.md            "$TARGET/.github/prompts/"
cp "$SRC/.github/chatmodes/"*.md          "$TARGET/.github/chatmodes/"
echo "✓ copied .github/{copilot-instructions.md, prompts/, chatmodes/} into $TARGET"

# 2. Write/merge .vscode/settings.json (merge if it already exists; never clobber).
mkdir -p "$TARGET/.vscode"
VS="$TARGET/.vscode/settings.json"
python3 - "$VS" <<'PY'
import json, os, sys
path = sys.argv[1]
data = {}
if os.path.exists(path):
    try:
        with open(path) as fh:
            data = json.load(fh)
    except Exception:
        # Non-JSON (e.g. has comments): don't destroy it — bail and let the user merge.
        sys.stderr.write("! .vscode/settings.json exists but isn't plain JSON — "
                         "add the two keys manually:\n"
                         '    "chat.promptFiles": true,\n'
                         '    "github.copilot.chat.codeGeneration.useInstructionFiles": true\n')
        sys.exit(0)
data["chat.promptFiles"] = True
data["github.copilot.chat.codeGeneration.useInstructionFiles"] = True
with open(path, "w") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
print(f"✓ wrote {path} (chat.promptFiles + useInstructionFiles = true)")
PY

echo
echo "Done. Tell teammates: open the repo in VS Code, then Reload Window"
echo "(Cmd+Shift+P -> Developer: Reload Window). The 11 personas appear in the"
echo "Copilot Chat mode dropdown; /deliver and /self-review are available."
