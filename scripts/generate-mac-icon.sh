#!/bin/sh
# Run on macOS after updating the shared logo; commit build/icon.icns.
# Native iconutil avoids corrupted small layers in the automatic PNG conversion.
set -eu
cd "$(dirname "$0")/.."
icon_tmp=$(mktemp -d)
trap 'rm -rf "$icon_tmp"' EXIT
iconset="$icon_tmp/icon.iconset"
mkdir -p "$iconset" build
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" src/renderer/src/assets/navo-logo.png \
    --out "$iconset/icon_${size}x${size}.png" >/dev/null
  doubled=$((size * 2))
  sips -z "$doubled" "$doubled" src/renderer/src/assets/navo-logo.png \
    --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o build/icon.icns
