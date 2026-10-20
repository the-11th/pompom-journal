#!/bin/bash
# Install a Datapom APK without losing phone-local journal/task data.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APK="${1:-$ROOT/android/app/build/outputs/apk/debug/app-debug.apk}"
PACKAGE="com.todopup.usage"
ADB="${ADB:-${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb}"

if [ ! -x "$ADB" ]; then
  echo "adb not found at $ADB" >&2
  exit 2
fi
if [ ! -f "$APK" ]; then
  echo "APK not found: $APK" >&2
  exit 2
fi

"$ADB" wait-for-device

if ! "$ADB" shell pm path "$PACKAGE" 2>/dev/null | grep -q '^package:'; then
  "$ADB" install "$APK"
  echo "Datapom installed. Future updates can use this same command."
  exit 0
fi

BACKUP_DIR="$(mktemp -d -t todopup-phone-data.XXXXXX)"
BACKUP="$BACKUP_DIR/phone-data.tar"
RESTORE_DIR="$BACKUP_DIR/restore"
trap 'rm -rf "$BACKUP_DIR"' EXIT

"$ADB" shell am force-stop "$PACKAGE" >/dev/null
"$ADB" shell run-as "$PACKAGE" mkdir -p shared_prefs files app_webview
"$ADB" exec-out run-as "$PACKAGE" tar -cf - shared_prefs files app_webview > "$BACKUP"

if install_output="$("$ADB" install -r "$APK" 2>&1)"; then
  printf '%s\n' "$install_output"
  echo "Datapom updated in place; all entries, tasks, and connection data were preserved."
  exit 0
fi
printf '%s\n' "$install_output" >&2
install_failure="${install_output##*Failure \[}"
if [[ "$install_failure" == "$install_output" || "$install_failure" != INSTALL_FAILED_UPDATE_INCOMPATIBLE:* || "$install_failure" != *" $PACKAGE signatures do not match"* ]]; then
  echo "Update failed; the installed app and its data remain unchanged. Resolve the install error and retry." >&2
  exit 3
fi

if [ ! -s "$BACKUP" ] || ! tar -tf "$BACKUP" >/dev/null 2>&1; then
  echo "Update signature differs and the phone-data backup is invalid; refusing to uninstall." >&2
  exit 3
fi

PERSISTENT_BACKUP="$ROOT/data/phone-backups/todopup-phone-data-$(date +%Y%m%d-%H%M%S).tar"
mkdir -p "$(dirname "$PERSISTENT_BACKUP")"
cp "$BACKUP" "$PERSISTENT_BACKUP"
mkdir -p "$RESTORE_DIR"
tar -xf "$BACKUP" -C "$RESTORE_DIR"
# Check every restore path while the original app is still installed. A
# recoverability error must never be discovered only after uninstalling it.
while IFS= read -r -d '' file; do
  relative="${file#"$RESTORE_DIR/"}"
  case "$relative" in *[!a-zA-Z0-9_./\ -]*)
    echo "Unsupported recovery filename; installed app retained. Backup: $PERSISTENT_BACKUP" >&2
    exit 4
  ;; esac
done < <(find "$RESTORE_DIR/files" "$RESTORE_DIR/app_webview" -type f -print0 2>/dev/null)
echo "APK signature changed; performing one-time preserve-and-restore migration."
echo "Recovery backup saved to $PERSISTENT_BACKUP"
"$ADB" uninstall "$PACKAGE"
"$ADB" install "$APK"
"$ADB" shell run-as "$PACKAGE" mkdir -p shared_prefs
for name in todopup_journal_outbox.xml todopup_mobile_ui.xml todopup_task_outbox.xml todopup_usage.xml todopup_tracking.xml; do
  file="$RESTORE_DIR/shared_prefs/$name"
  [ -f "$file" ] || continue
  remote="/data/local/tmp/todopup-recover-$name"
  verified="$BACKUP_DIR/verified-$name"
  "$ADB" push "$file" "$remote" >/dev/null
  "$ADB" shell chmod 644 "$remote"
  "$ADB" shell run-as "$PACKAGE" cp "$remote" "shared_prefs/$name"
  "$ADB" shell run-as "$PACKAGE" chmod 660 "shared_prefs/$name"
  "$ADB" exec-out run-as "$PACKAGE" cat "shared_prefs/$name" > "$verified"
  cmp "$file" "$verified"
  "$ADB" shell rm -f "$remote"
done
if [ -d "$RESTORE_DIR/files" ] || [ -d "$RESTORE_DIR/app_webview" ]; then
  while IFS= read -r -d '' file; do
    relative="${file#"$RESTORE_DIR/"}"
    remote="/data/local/tmp/todopup-recover-file"
    "$ADB" shell run-as "$PACKAGE" mkdir -p "'$(dirname "$relative")'"
    "$ADB" push "$file" "$remote" >/dev/null
    "$ADB" shell chmod 644 "$remote"
    "$ADB" shell run-as "$PACKAGE" cp "$remote" "'$relative'"
    "$ADB" exec-out run-as "$PACKAGE" cat "'$relative'" > "$BACKUP_DIR/verified-file"
    cmp "$file" "$BACKUP_DIR/verified-file"
    "$ADB" shell rm -f "$remote"
  done < <(find "$RESTORE_DIR/files" "$RESTORE_DIR/app_webview" -type f -print0 2>/dev/null)
fi
"$ADB" shell am force-stop "$PACKAGE" >/dev/null
"$ADB" shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 >/dev/null

echo "Datapom updated and phone-local entries/tasks were preserved."
echo "Because Android removes encryption keys on uninstall, create a fresh device token and reconnect once."
