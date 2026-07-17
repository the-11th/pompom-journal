#!/bin/bash
# Creates or updates the TodoPom Automator app at /Applications/TodoPom.app.
# Run once on a new machine after cloning the repo.

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP="/Applications/TodoPom.app"
STUB_APP="/System/Library/CoreServices/Automator Application Stub.app"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [ ! -d "$STUB_APP" ]; then
  echo "Error: Automator Application Stub not found. Is Automator installed?"
  exit 1
fi

echo "Creating $APP ..."
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$STUB_APP/Contents/MacOS/Automator Application Stub" \
  "$APP/Contents/MacOS/Automator Application Stub"
cp "$STUB_APP/Contents/PkgInfo" "$APP/Contents/PkgInfo"
cp "$SCRIPT_DIR/Info.plist" "$APP/Contents/Info.plist"

echo "Installing workflow ..."
cp "$SCRIPT_DIR/document.wflow" "$APP/Contents/document.wflow"
COMMAND="cd $(printf '%q' "$APP_DIR")
exec /bin/bash $(printf '%q' "$APP_DIR/TodoPup.command")"
plutil -replace actions.0.action.ActionParameters.COMMAND_STRING \
  -string "$COMMAND" "$APP/Contents/document.wflow"

echo "Installing icon ..."
ICONSET="$TMP_DIR/TodoPom.iconset"
mkdir -p "$ICONSET"
sips -c 288 288 -s format png "$SCRIPT_DIR/icon.gif" \
  --out "$TMP_DIR/icon.png" >/dev/null
for SIZE in 16 32 128 256 512; do
  sips -z "$SIZE" "$SIZE" "$TMP_DIR/icon.png" \
    --out "$ICONSET/icon_${SIZE}x${SIZE}.png" >/dev/null
  DOUBLE=$((SIZE * 2))
  sips -z "$DOUBLE" "$DOUBLE" "$TMP_DIR/icon.png" \
    --out "$ICONSET/icon_${SIZE}x${SIZE}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/TodoPom.icns"

# Sign the generated local bundle so macOS can validate its integrity.
codesign --force --deep --sign - "$APP"

# Touch the bundle so macOS re-registers it.
touch "$APP"

echo "Done. TodoPom is at $APP — drag it to your dock if needed."
