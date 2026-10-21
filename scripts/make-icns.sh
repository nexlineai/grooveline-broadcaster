#!/bin/bash
# Converts assets/icon.png → assets/icon.icns
# Requires macOS (uses sips + iconutil — both built-in, no extra tools needed)
set -e

SRC="assets/icon.png"
ICONSET="assets/icon.iconset"

[ -f "$SRC" ] || { echo "❌ Missing $SRC"; exit 1; }

echo "→ Building iconset from $SRC..."
mkdir -p "$ICONSET"

# sips requires same-format output — copy to tmp PNG if source is JPEG
TMP=$(mktemp /tmp/icon_XXXX.png)
sips -s format png "$SRC" --out "$TMP" > /dev/null 2>&1

sips -z 16   16   "$TMP" --out "$ICONSET/icon_16x16.png"      > /dev/null
sips -z 32   32   "$TMP" --out "$ICONSET/icon_16x16@2x.png"   > /dev/null
sips -z 32   32   "$TMP" --out "$ICONSET/icon_32x32.png"      > /dev/null
sips -z 64   64   "$TMP" --out "$ICONSET/icon_32x32@2x.png"   > /dev/null
sips -z 128  128  "$TMP" --out "$ICONSET/icon_128x128.png"    > /dev/null
sips -z 256  256  "$TMP" --out "$ICONSET/icon_128x128@2x.png" > /dev/null
sips -z 256  256  "$TMP" --out "$ICONSET/icon_256x256.png"    > /dev/null
sips -z 512  512  "$TMP" --out "$ICONSET/icon_256x256@2x.png" > /dev/null
sips -z 512  512  "$TMP" --out "$ICONSET/icon_512x512.png"    > /dev/null
sips -z 1024 1024 "$TMP" --out "$ICONSET/icon_512x512@2x.png" > /dev/null

rm "$TMP"
iconutil -c icns "$ICONSET" -o "assets/icon.icns"
rm -rf "$ICONSET"

echo "✅ assets/icon.icns created"
