#!/usr/bin/env bash
#
# Build a signed release bundle.
#
# Exists because two things silently produce a broken release and neither one
# announces itself:
#
#   * `flutter build appbundle --release` with no --dart-define falls back to
#     http://10.0.2.2:3000/v1, the Android emulator's route to a developer's
#     machine. The bundle installs and opens; every request then fails in a way
#     the user reads as a bad connection. The app now refuses to start on such
#     a build and says why, but the build itself still succeeds.
#
#   * The Gradle template signs release with the DEBUG key. That one is caught
#     in app/build.gradle.kts, which fails the build outright.
#
# Usage:
#   scripts/build-release.sh aly    https://api.example.iq/v1 wss://api.example.iq/v1/realtime
#   scripts/build-release.sh rider  https://api.example.iq/v1 wss://api.example.iq/v1/realtime
#   scripts/build-release.sh driver https://api.example.iq/v1 wss://api.example.iq/v1/realtime
#
# `aly` is the one that ships (CLAUDE.md 1.1). `rider` and `driver` still build
# because they still exist - the merge is additive until the owner cuts over.
#
# The Maps key comes from MAPS_API_KEY in the environment or from
# apps/<app>/android/local.properties. Neither is in the repository.

set -euo pipefail

APP="${1:-}"
API_BASE_URL="${2:-}"
WS_URL="${3:-}"

if [[ "$APP" != "aly" && "$APP" != "rider" && "$APP" != "driver" ]]; then
  echo "usage: $0 <aly|rider|driver> <https://api-base/v1> <wss://realtime-url>" >&2
  exit 2
fi

if [[ -z "$API_BASE_URL" || -z "$WS_URL" ]]; then
  echo "error: both API_BASE_URL and WS_URL are required." >&2
  echo "       A release build without them points at a development host." >&2
  exit 2
fi

# Checked here as well as in the app, so the mistake surfaces before a
# fifteen-minute build rather than after it.
[[ "$API_BASE_URL" == https://* ]] || { echo "error: API_BASE_URL must be https://" >&2; exit 2; }
[[ "$WS_URL" == wss://* ]]         || { echo "error: WS_URL must be wss://" >&2; exit 2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/apps/$APP"

if [[ ! -f android/key.properties && -z "${ANDROID_KEYSTORE_PATH:-}" ]]; then
  echo "error: no upload key configured. See docs/RELEASE.md." >&2
  exit 2
fi

echo "building $APP against $API_BASE_URL"

flutter build appbundle --release \
  --dart-define=API_BASE_URL="$API_BASE_URL" \
  --dart-define=WS_URL="$WS_URL" \
  --dart-define=MAPS_CONFIGURED=true

BUNDLE="build/app/outputs/bundle/release/app-release.aab"
echo
echo "built:  $BUNDLE"
echo "bytes:  $(stat -c %s "$BUNDLE" 2>/dev/null || stat -f %z "$BUNDLE")"
echo
echo "signed with:"
unzip -p "$BUNDLE" META-INF/UPLOAD.RSA 2>/dev/null \
  | keytool -printcert 2>/dev/null \
  | grep -E "Owner:|SHA1:" || echo "  (keytool not on PATH - verify the signature manually)"
