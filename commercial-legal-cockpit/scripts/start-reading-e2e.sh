#!/bin/sh
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export CONTRACTTWIN_API_KEY="${CONTRACTTWIN_API_KEY:-e2e-reading-key}"
export CONTRACTTWIN_DB_PATH="${CONTRACTTWIN_DB_PATH:-/tmp/contracttwin-reading-e2e.sqlite}"
export CONTRACTTWIN_CORE_URL="${CONTRACTTWIN_CORE_URL:-http://127.0.0.1:8080}"
cd "$ROOT/contracttwin"
python3 -m uvicorn contracttwin.api:app --host 127.0.0.1 --port 8080 >/tmp/contracttwin-reading-e2e.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" >/dev/null 2>&1 || true' EXIT
ready=0
i=0
while [ "$i" -lt 40 ]; do
  if python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=1)" >/dev/null 2>&1; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 0.25
done
if [ "$ready" -ne 1 ]; then
  echo "The reading service did not start." >&2
  cat /tmp/contracttwin-reading-e2e.log >&2 || true
  exit 1
fi
cd "$ROOT/commercial-legal-cockpit"
exec npm run start -- --hostname 127.0.0.1 --port 3000
