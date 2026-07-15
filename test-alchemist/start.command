#!/bin/bash
# Test Alchemist launcher (macOS) — double-click to start the server.
# Optional: pass a port  ->  ./start.command 3005
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
    echo
    echo "Node.js 18+ is required. Install it from https://nodejs.org"
    echo
    read -r -p "Press Enter to close..."
    exit 1
fi

PORT="${1:-${PORT:-35000}}"
export PORT

if [ ! -d node_modules ]; then
    echo "Installing dependencies (first run only)..."
    npm install
fi

echo
echo "  Test Alchemist  ->  http://localhost:$PORT"
echo "  (close this window or run stop.command to stop)"
echo
node server.js
