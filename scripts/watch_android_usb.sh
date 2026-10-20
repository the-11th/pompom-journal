#!/bin/bash
# Trigger Datapom once when an authorized phone enters USB file-transfer mode.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADB="${ADB:-${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb}"
last_device=""
retry_device=""
retry_delay=1
retry_countdown=0
mkdir -p "$ROOT/data"

while true; do
  current_device="$("$ADB" devices 2>/dev/null | awk -v selected="${ANDROID_SERIAL:-}" '
    $2 == "device" && ((selected != "" && $1 == selected) || (selected == "" && $1 !~ /^emulator-/)) { print $1; exit }')"
  ready_device=""
  if [ -z "$current_device" ]; then
    last_device=""
    retry_device=""
  elif usb_state="$("$ADB" -s "$current_device" shell getprop sys.usb.state 2>/dev/null)"; then
    usb_state="${usb_state//$'\r'/}"
    case ",$usb_state," in
      *,mtp,*) ready_device="$current_device" ;;
      *) last_device=""; retry_device="" ;;
    esac
  fi
  # A failed property read is not a confirmed disconnect/mode change. Preserve
  # the completed interval so a transient ADB error cannot restart a good sync.
  if [ -n "$ready_device" ] && [ "$ready_device" = "$last_device" ]; then
    # The dock server may quit after its last browser closes. Restart through
    # the same helper only when it stops responding, not on every healthy poll.
    if ! curl -fsS --connect-timeout 2 --max-time 2 http://127.0.0.1:5001/ >/dev/null 2>&1; then
      last_device=""
    fi
  fi
  if [ -n "$ready_device" ] && [ "$ready_device" != "$last_device" ]; then
    if [ "$ready_device" != "$retry_device" ]; then
      retry_device="$ready_device"; retry_delay=1; retry_countdown=0
    fi
    if [ "$retry_countdown" -gt 0 ]; then
      retry_countdown=$((retry_countdown - 1))
    elif ANDROID_SERIAL="$ready_device" "$ROOT/scripts/sync_android_usb.sh" >> "$ROOT/data/usb-sync.log" 2>&1; then
      last_device="$ready_device"
      retry_delay=1; retry_countdown=0
    else
      # Poll every five seconds; failed starts back off to at most one minute.
      retry_countdown=$((retry_delay - 1))
      retry_delay=$((retry_delay * 2))
      if [ "$retry_delay" -gt 12 ]; then retry_delay=12; fi
    fi
  fi
  sleep 5
done
