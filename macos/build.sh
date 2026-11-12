#!/bin/bash
# Builds macos/WifiScanHelper.app as a universal binary (Apple Silicon + Intel).
# Requires the Xcode Command Line Tools:  xcode-select --install
#
# Optional: set SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" to sign
# for distribution. Without it the app is ad-hoc signed, which is fine for local use.
set -euo pipefail

cd "$(dirname "$0")"
APP="WifiScanHelper.app"
BUILD="build"
MIN_OS="13.0"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install the Xcode Command Line Tools first: xcode-select --install" >&2
  exit 1
fi

rm -rf "$APP" "$BUILD"
mkdir -p "$BUILD" "$APP/Contents/MacOS"

for ARCH in arm64 x86_64; do
  echo "Compiling for ${ARCH}..."
  swiftc -O -target "$ARCH-apple-macos$MIN_OS" \
    -framework AppKit -framework CoreLocation -framework CoreWLAN \
    WifiScanHelper.swift -o "$BUILD/WifiScanHelper-$ARCH"
done

lipo -create "$BUILD/WifiScanHelper-arm64" "$BUILD/WifiScanHelper-x86_64" -output "$APP/Contents/MacOS/WifiScanHelper"
cp Info.plist "$APP/Contents/Info.plist"
chmod 755 "$APP/Contents/MacOS/WifiScanHelper"
rm -rf "$BUILD"

if [ -n "${SIGN_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp -s "$SIGN_IDENTITY" "$APP"
else
  codesign --force -s - "$APP"
fi
codesign --verify --verbose "$APP"
lipo -info "$APP/Contents/MacOS/WifiScanHelper"
echo "Built $(pwd)/$APP"
