#!/bin/bash
# Install TodoPup's persistent per-user macOS server and private Tailscale proxy.
# Usage: bash scripts/install_phone_access.sh https://your-mac.tailnet.ts.net

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC_URL="${1:-}"
LABEL="com.todopup.phone-server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$ROOT/data/server.log"

if [[ ! "$PUBLIC_URL" =~ ^https://[^/]+\.ts\.net/?$ ]]; then
  echo "Usage: $0 https://your-mac.your-tailnet.ts.net"
  exit 2
fi

if [ ! -x "$ROOT/.venv/bin/waitress-serve" ]; then
  echo "TodoPup dependencies are incomplete. Run:"
  echo "  $ROOT/.venv/bin/pip install -r $ROOT/requirements.txt"
  exit 2
fi

TAILSCALE="$(command -v tailscale || true)"
if [ -z "$TAILSCALE" ]; then
  for candidate in "/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
                   "/usr/local/bin/tailscale" "/opt/homebrew/bin/tailscale"; do
    if [ -x "$candidate" ]; then TAILSCALE="$candidate"; break; fi
  done
fi
if [ -z "$TAILSCALE" ]; then
  echo "Tailscale CLI not found. Install and sign in to Tailscale first."
  exit 2
fi

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data"

# PlistBuddy avoids a generated heredoc containing unescaped user paths.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
rm -f "$TMP"
/usr/libexec/PlistBuddy -c 'Add :Label string placeholder' "$TMP"
/usr/libexec/PlistBuddy -c 'Add :ProgramArguments array' "$TMP"
/usr/libexec/PlistBuddy -c 'Add :ProgramArguments:0 string placeholder' "$TMP"
/usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables dict' "$TMP"
/usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables:TODOPUP_PUBLIC_URL string placeholder' "$TMP"
/usr/libexec/PlistBuddy -c 'Add :WorkingDirectory string placeholder' "$TMP"
/usr/libexec/PlistBuddy -c 'Add :RunAtLoad bool true' "$TMP"
/usr/libexec/PlistBuddy -c 'Add :KeepAlive bool true' "$TMP"
/usr/libexec/PlistBuddy -c 'Add :StandardOutPath string placeholder' "$TMP"
/usr/libexec/PlistBuddy -c 'Add :StandardErrorPath string placeholder' "$TMP"
/usr/libexec/PlistBuddy -c "Set :Label $LABEL" "$TMP"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $ROOT/.venv/bin/python" "$TMP"
/usr/libexec/PlistBuddy -c 'Add :ProgramArguments:1 string phone_server.py' "$TMP"
/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:TODOPUP_PUBLIC_URL ${PUBLIC_URL%/}" "$TMP"
/usr/libexec/PlistBuddy -c "Set :WorkingDirectory $ROOT" "$TMP"
/usr/libexec/PlistBuddy -c "Set :StandardOutPath $LOG" "$TMP"
/usr/libexec/PlistBuddy -c "Set :StandardErrorPath $LOG" "$TMP"
plutil -convert xml1 "$TMP" -o "$PLIST"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL"

"$TAILSCALE" serve --bg 5001

echo "TodoPup phone access is running at ${PUBLIC_URL%/}"
echo "The Mac must remain logged in, awake, online, and connected to Tailscale."
