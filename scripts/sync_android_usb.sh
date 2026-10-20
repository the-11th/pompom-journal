#!/bin/bash
# Pair and run a full Datapom sync through an authenticated ADB USB tunnel.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADB="${ADB:-${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb}"
PYTHON="${PYTHON:-$ROOT/.venv/bin/python}"
TOKEN_FILE="${TODOPUP_USB_TOKEN_FILE:-$ROOT/data/usb-sync-token}"
BASE_URL="http://127.0.0.1:5001"

if [ ! -x "$ADB" ]; then
  echo "adb not found at $ADB" >&2
  exit 2
fi
ADB_COMMAND=("$ADB" -d)
if [ -n "${ANDROID_SERIAL:-}" ]; then
  ADB_COMMAND=("$ADB" -s "$ANDROID_SERIAL")
fi
if [ "$("${ADB_COMMAND[@]}" get-state 2>/dev/null)" != "device" ]; then
  echo "Phone is not ready for USB sync. Unlock it and authorize USB debugging." >&2
  exit 1
fi

mkdir -p "$ROOT/data"
server_ready() { curl -fsS --connect-timeout 2 --max-time 2 "$BASE_URL/" >/dev/null 2>&1; }
if [ "${TODOPUP_SKIP_SERVER_CHECK:-}" != "1" ]; then
  if ! server_ready; then
    nohup "$PYTHON" "$ROOT/phone_server.py" >> "$ROOT/data/server.log" 2>&1 &
    ready=0
    for attempt in {1..15}; do
      if server_ready; then ready=1; break; fi
      sleep 1
    done
    if [ "$ready" != 1 ]; then
      echo "Datapom did not become ready on the Mac. USB sync will retry." >&2
      exit 1
    fi
  fi
fi

mkdir -p "$(dirname "$TOKEN_FILE")"
PAIR_URIS="$("$PYTHON" -c '
import json
import os
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

base_url, token_path = sys.argv[1:]
try:
    cached_token = Path(token_path).read_text(encoding="utf-8").strip()
except (FileNotFoundError, UnicodeError):
    cached_token = ""
request = urllib.request.Request(base_url + "/integrations/mobile/usb",
    data=json.dumps({"token": cached_token}).encode("utf-8"),
    headers={"Content-Type": "application/json"}, method="POST")
try:
    with urllib.request.urlopen(request, timeout=15) as response:
        result = json.load(response)
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise ValueError("Invalid USB setup response")
    token, usage_token = result.get("token"), result.get("usage_token")
    if not all(isinstance(value, str) and value for value in (token, usage_token)):
        raise ValueError("Missing USB setup credentials")
except (OSError, ValueError):
    raise SystemExit("USB setup failed. Restart Datapom and run the helper again.") from None
if token != cached_token:
    fd, temporary = tempfile.mkstemp(prefix=".usb-token-", dir=str(Path(token_path).parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(token)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, token_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
os.chmod(token_path, 0o600)
for url, value in ((base_url, token), (base_url + "/integrations/phone/ingest", usage_token)):
    print("todopup://config?" + urllib.parse.urlencode({"url": url, "token": value}))
' "$BASE_URL" "$TOKEN_FILE")"
PAIR_URI="${PAIR_URIS%%$'\n'*}"
USAGE_PAIR_URI="${PAIR_URIS#*$'\n'}"

"${ADB_COMMAND[@]}" reverse tcp:5001 tcp:5001 >/dev/null

start_activity() {
  local output
  if ! output="$("${ADB_COMMAND[@]}" shell "am start -W -n com.todopup.usage/.MainActivity -a android.intent.action.VIEW -d '$1'" 2>&1)" ||
      ! printf '%s\n' "$output" | grep -Eq '^[[:space:]]*Status: ok[[:space:]]*$'; then
    # am can exit zero while reporting an unavailable activity. Its raw output
    # contains the configuration URI, so never copy it to the shared log.
    echo "Datapom could not open on the phone. Unlock it and retry." >&2
    return 1
  fi
}

start_activity "$PAIR_URI"
sleep 1

start_activity "$USAGE_PAIR_URI"
sleep 1
start_activity todopup://usage
sleep "${TODOPUP_USAGE_SYNC_WAIT_SECONDS:-5}"
start_activity todopup://sync

echo "Datapom USB sync started for entries, tasks, tags, and phone usage."
