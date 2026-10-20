#!/bin/bash
# Creates or updates the Datapom Automator app at /Applications/Datapom.app.
# Run once on a new machine after cloning the repo.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
APPLICATIONS_DIR="${DATAPOM_APPLICATIONS_DIR:-/Applications}"
APP="$APPLICATIONS_DIR/Datapom.app"
STUB_APP="${DATAPOM_AUTOMATOR_STUB:-/System/Library/CoreServices/Automator Application Stub.app}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [ ! -d "$STUB_APP" ]; then
  echo "Error: Automator Application Stub not found. Is Automator installed?"
  exit 1
fi

# Moving the existing bundle keeps its filesystem identity, so Dock bookmarks
# can follow the rename. Preserve its resources, including a customized icon.
if [ ! -d "$APP" ]; then
  for OLD_NAME in TodoPom TodoPup; do
    if [ -d "$APPLICATIONS_DIR/$OLD_NAME.app" ]; then
      mv "$APPLICATIONS_DIR/$OLD_NAME.app" "$APP"
      break
    fi
  done
fi
for ICON_NAME in Datapom TodoPom TodoPup; do
  if [ -f "$APP/Contents/Resources/$ICON_NAME.icns" ]; then
    cp "$APP/Contents/Resources/$ICON_NAME.icns" "$TMP_DIR/custom.icns"
    break
  fi
done

echo "Creating $APP ..."
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$STUB_APP/Contents/MacOS/Automator Application Stub" \
  "$APP/Contents/MacOS/Automator Application Stub"
cp "$STUB_APP/Contents/PkgInfo" "$APP/Contents/PkgInfo"
cp "$SCRIPT_DIR/Info.plist" "$APP/Contents/Info.plist"

echo "Installing workflow ..."
cp "$SCRIPT_DIR/document.wflow" "$APP/Contents/document.wflow"
COMMAND="cd $(printf '%q' "$APP_DIR")
exec /bin/bash $(printf '%q' "$APP_DIR/Datapom.command")"
plutil -replace actions.0.action.ActionParameters.COMMAND_STRING \
  -string "$COMMAND" "$APP/Contents/document.wflow"

echo "Installing icon ..."
if [ -f "$TMP_DIR/custom.icns" ]; then
  cp "$TMP_DIR/custom.icns" "$APP/Contents/Resources/Datapom.icns"
else
ICONSET="$TMP_DIR/Datapom.iconset"
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
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Datapom.icns"
fi

# Sign the generated local bundle so macOS can validate its integrity.
codesign --force --deep --sign - "$APP"

# Touch the bundle so macOS re-registers it.
touch "$APP"

echo "Done. Datapom is at $APP — drag it to your dock if needed."
