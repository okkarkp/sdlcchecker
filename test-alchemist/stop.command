#!/bin/bash
# Stop Test Alchemist (frees the server port).
# Defaults to port 35000; pass another  ->  ./stop.command 3005
cd "$(dirname "$0")" || exit 1

PORT="${1:-35000}"
echo "Stopping Test Alchemist on port $PORT ..."

PIDS="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null)"

if [ -n "$PIDS" ]; then
    # shellcheck disable=SC2086
    kill -9 $PIDS 2>/dev/null
    echo "Test Alchemist stopped."
else
    echo "No Test Alchemist server was running on port $PORT."
fi

sleep 1
