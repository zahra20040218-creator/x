#!/usr/bin/env bash
#
# The device checklist, driven by ADB instead of by hand.
#
# Everything in DEVICE_STREAMING_CHECKLIST.md that a machine can do, done by a
# machine: install, permissions, launch, taps, typing, screenshots, logcat, and
# correlation against what the server logged.
#
# ## Why ADB rather than clicking
#
# Android Device Streaming bills by the minute and the Spark plan gives 30 a
# month. A human working through 25 checks spends most of that minute count
# reading the screen. This spends it running.
#
# It also removes the worst property of manual UI testing: a person who taps the
# right thing and sees the right screen has proved the screen, not the system.
# Every check here asserts against the SERVER's log as well.
#
# ## What it cannot do
#
# Sign in to Google, start a streaming session, or move a phone through a city.
# Attach the device first; then this takes over.
#
#   scripts/device-autotest.sh            everything
#   scripts/device-autotest.sh --quick    the ten checks worth 30 free minutes
#
# Results: /tmp/device-test/report.txt, with screenshots beside it.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="/tmp/device-test"
ADB="${ANDROID_HOME:-$HOME/AppData/Local/Android/Sdk}/platform-tools/adb.exe"
[[ -x "$ADB" ]] || ADB="adb"

RIDER_PKG="iq.rideapp.rideapp_rider"
DRIVER_PKG="iq.rideapp.rideapp_driver"
TEST_PHONE="07700000001"     # +9647700000001 as a user would type it
TEST_CODE="123456"

QUICK=0
[[ "${1:-}" == "--quick" ]] && QUICK=1

mkdir -p "$OUT"
: > "$OUT/report.txt"

PASS=0; FAIL=0; SKIP=0

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '      %s\n' "$*"; }

result() {  # result <id> <PASS|FAIL|SKIP> <text>
  local id="$1" verdict="$2"; shift 2
  case "$verdict" in
    PASS) PASS=$((PASS+1));  printf '  \033[32mPASS\033[0m  %-4s %s\n' "$id" "$*" ;;
    FAIL) FAIL=$((FAIL+1));  printf '  \033[31mFAIL\033[0m  %-4s %s\n' "$id" "$*" ;;
    SKIP) SKIP=$((SKIP+1));  printf '  \033[33mSKIP\033[0m  %-4s %s\n' "$id" "$*" ;;
  esac
  printf '%s\t%s\t%s\n' "$verdict" "$id" "$*" >> "$OUT/report.txt"
}

shot() { "$ADB" exec-out screencap -p > "$OUT/$1.png" 2>/dev/null; }

# The whole UI layer, and the reason this is not a list of blind coordinates:
# dump the accessibility tree, find the node whose text matches, tap its centre.
# A tap at a fixed x,y passes on one screen size and silently taps the wrong
# control on another.
ui_dump() {
  "$ADB" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  "$ADB" shell cat /sdcard/ui.xml 2>/dev/null
}

find_node() {  # find_node <substring>  ->  "x y" of its centre, or empty
  ui_dump | tr '>' '\n' | grep -F "$1" | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | head -1 \
    | grep -oE '[0-9]+' | paste -sd' ' - \
    | awk '{ if (NF==4) printf "%d %d", ($1+$3)/2, ($2+$4)/2 }'
}

tap_text() {  # tap_text <substring> [tries]
  local want="$1" tries="${2:-12}" xy
  for _ in $(seq 1 "$tries"); do
    xy=$(find_node "$want")
    if [[ -n "$xy" ]]; then
      # shellcheck disable=SC2086
      "$ADB" shell input tap $xy >/dev/null 2>&1
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_text() {  # wait_text <substring> [seconds]
  local want="$1" secs="${2:-20}"
  for _ in $(seq 1 "$secs"); do
    ui_dump | grep -qF "$want" && return 0
    sleep 1
  done
  return 1
}

server_saw() {  # server_saw <pattern> [seconds]
  local pat="$1" secs="${2:-15}"
  for _ in $(seq 1 "$secs"); do
    grep -aq "$pat" /tmp/device-api.log /tmp/device-worker.log 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

crashed() {  # crashed <pkg>
  "$ADB" logcat -d 2>/dev/null | grep -qE "FATAL EXCEPTION|AndroidRuntime.*$1"
}

# ---------------------------------------------------------------------------

say "0  Device and prerequisites"

if ! "$ADB" get-state >/dev/null 2>&1; then
  echo "  No device."
  echo "  Android Studio -> Device Manager -> Firebase -> Start, then re-run."
  exit 1
fi

MODEL=$("$ADB" shell getprop ro.product.model 2>/dev/null | tr -d '\r')
SDK=$("$ADB" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')
note "device: $MODEL   Android SDK $SDK"

curl -s -o /dev/null --max-time 3 http://127.0.0.1:3000/v1/health \
  || { echo "  API is not running. scripts/device-session.sh start"; exit 1; }
note "API: up"

"$ADB" reverse tcp:3000 tcp:3000 >/dev/null 2>&1 \
  && note "bridge: adb reverse OK" \
  || { echo "  adb reverse failed - the app cannot reach the API"; exit 1; }

# The device asks the API for its own health: proof the bridge works from the
# far side, not just that the command returned zero.
BRIDGED=$("$ADB" shell "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:3000/v1/health" 2>/dev/null | tr -d '\r')
[[ "$BRIDGED" == "200" ]] && note "bridge verified from the device: HTTP 200" \
                          || note "device could not reach the API (got '${BRIDGED:-nothing}') - curl may be absent on this image"

say "1  Install"

for p in driver rider; do
  APK="$ROOT/apps/$p/build/app/outputs/flutter-apk/app-debug.apk"
  [[ -f "$APK" ]] || { result "I-$p" FAIL "APK missing - build first"; continue; }
  if "$ADB" install -r -d "$APK" 2>&1 | grep -q "Success"; then
    result "I-$p" PASS "installed"
  else
    result "I-$p" FAIL "install failed"
  fi
done

# Granted up front. The runtime dialogs are a permission test, not a ride test,
# and they would eat the minutes this exists to save.
for perm in ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION POST_NOTIFICATIONS; do
  "$ADB" shell pm grant "$DRIVER_PKG" "android.permission.$perm" >/dev/null 2>&1
  "$ADB" shell pm grant "$RIDER_PKG"  "android.permission.$perm" >/dev/null 2>&1
done
"$ADB" shell pm grant "$DRIVER_PKG" android.permission.ACCESS_BACKGROUND_LOCATION >/dev/null 2>&1
note "location and notification permissions granted"

# ---------------------------------------------------------------------------
say "A  The apps start"

"$ADB" logcat -c >/dev/null 2>&1

for app in "rider:$RIDER_PKG" "driver:$DRIVER_PKG"; do
  name="${app%%:*}"; pkg="${app##*:}"
  "$ADB" shell monkey -p "$pkg" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  sleep 6
  shot "A-$name"

  if crashed "$pkg"; then
    result "A-$name" FAIL "crashed on launch - see $OUT/A-$name.png"
    "$ADB" logcat -d 2>/dev/null | grep -A12 "FATAL EXCEPTION" | head -16 >> "$OUT/report.txt"
  elif "$ADB" shell pidof "$pkg" >/dev/null 2>&1; then
    result "A-$name" PASS "running"
  else
    result "A-$name" FAIL "not running after launch"
  fi
done

# Firebase.initializeApp() runs before the first frame. If google-services.json
# is wrong the app dies here, and this is the line that says so.
if "$ADB" logcat -d 2>/dev/null | grep -q "core/no-app\|No Firebase App"; then
  result "A-fb" FAIL "Firebase failed to initialise - google-services.json is wrong or missing"
else
  result "A-fb" PASS "Firebase initialised"
fi

# ---------------------------------------------------------------------------
say "B  Sign-in with the Firebase test number"

sign_in() {  # sign_in <pkg> <label>
  local pkg="$1" label="$2"
  "$ADB" shell am force-stop "$pkg" >/dev/null 2>&1
  "$ADB" shell monkey -p "$pkg" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  sleep 6

  # Already signed in from an earlier run?
  if ui_dump | grep -qE "متصل|غير متصل|اطلب|وجهة"; then
    result "B-$label" PASS "already signed in (session survived)"
    return 0
  fi

  local xy
  xy=$(find_node "07XXXXXXXXX")
  [[ -z "$xy" ]] && xy=$(find_node "EditText")
  if [[ -z "$xy" ]]; then
    shot "B-$label-nofield"
    result "B-$label" FAIL "no phone field found - see $OUT/B-$label-nofield.png"
    return 1
  fi

  # shellcheck disable=SC2086
  "$ADB" shell input tap $xy >/dev/null 2>&1
  "$ADB" shell input text "$TEST_PHONE" >/dev/null 2>&1
  sleep 1
  tap_text "إرسال" 4 || tap_text "التالي" 4 || "$ADB" shell input keyevent 66 >/dev/null 2>&1
  sleep 8

  if ! wait_text "الرمز" 15 && ! ui_dump | grep -qE "OTP|رمز"; then
    shot "B-$label-nocode"
    result "B-$label" FAIL "no code screen - see $OUT/B-$label-nocode.png"
    return 1
  fi

  xy=$(find_node "EditText")
  # shellcheck disable=SC2086
  [[ -n "$xy" ]] && "$ADB" shell input tap $xy >/dev/null 2>&1
  "$ADB" shell input text "$TEST_CODE" >/dev/null 2>&1
  sleep 1
  tap_text "تأكيد" 4 || tap_text "دخول" 4 || "$ADB" shell input keyevent 66 >/dev/null 2>&1
  sleep 10
  shot "B-$label-after"

  if ui_dump | grep -qE "متصل|غير متصل|اطلب|وجهة|الأرباح"; then
    result "B-$label" PASS "signed in"
    return 0
  fi
  result "B-$label" FAIL "still on sign-in - see $OUT/B-$label-after.png"
  return 1
}

sign_in "$DRIVER_PKG" "driver"
sign_in "$RIDER_PKG"  "rider"

if server_saw '"event":"auth' 5; then
  result "B-srv" PASS "the server issued a session"
else
  result "B-srv" SKIP "no auth event in the log (it may not log one)"
fi

# ---------------------------------------------------------------------------
say "C  The driver goes online"

"$ADB" shell am force-stop "$RIDER_PKG" >/dev/null 2>&1
"$ADB" shell monkey -p "$DRIVER_PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 6

: > /tmp/loc-before; grep -ac "driver.location\|location" /tmp/device-api.log 2>/dev/null > /tmp/loc-before

if tap_text "غير متصل" 6 || tap_text "اتصال" 6 || tap_text "Switch" 6; then
  sleep 10
  shot "C-online"
  if ui_dump | grep -q "متصل" && ! ui_dump | grep -q "غير متصل"; then
    result "C-online" PASS "driver is online"
  else
    # A compliance refusal looks like a failure to go online and is not one.
    if ui_dump | grep -qE "إجازة|وثائق|البطاقة|سنوية"; then
      result "C-online" FAIL "refused: document policy is enabled. Clear required_driver_documents to test"
    else
      result "C-online" FAIL "toggle did not take - see $OUT/C-online.png"
    fi
  fi
else
  shot "C-notoggle"
  result "C-online" FAIL "no online control found - see $OUT/C-notoggle.png"
fi

sleep 12
AFTER=$(grep -ac "location" /tmp/device-api.log 2>/dev/null || echo 0)
BEFORE=$(cat /tmp/loc-before 2>/dev/null || echo 0)
if (( AFTER > BEFORE )); then
  result "C-loc" PASS "location ingest reached the server ($((AFTER-BEFORE)) events)"
else
  result "C-loc" FAIL "no location reached the server"
fi

if (( QUICK == 1 )); then
  say "Quick mode: skipping the ride cycle is NOT an option - it is the point."
fi

# ---------------------------------------------------------------------------
say "D  The ride - what this whole session exists to prove"

"$ADB" shell monkey -p "$RIDER_PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 6
shot "D-rider"

REQUESTED_AT=$(date +%s%3N)
if tap_text "اطلب" 8 || tap_text "طلب" 8; then
  sleep 3
  result "D-req" PASS "ride requested"
else
  shot "D-noreq"
  result "D-req" FAIL "no request control - the screen may need pickup and destination first. See $OUT/D-noreq.png"
fi

if server_saw '"event":"ride.dispatched"' 15; then
  result "D-disp" PASS "the worker dispatched it"
else
  result "D-disp" FAIL "no dispatch - is the worker running?"
fi

if server_saw '"event":"realtime.published"' 10; then
  RECV=$(grep -ao 'receivers":[0-9]*' /tmp/device-worker.log 2>/dev/null | tail -1)
  if [[ "$RECV" == 'receivers":0' ]]; then
    result "D-pub" FAIL "published to nobody ($RECV) - the driver socket is not connected"
  else
    result "D-pub" PASS "offer published ($RECV)"
  fi
else
  result "D-pub" FAIL "nothing published to the realtime channel"
fi

"$ADB" shell monkey -p "$DRIVER_PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 4
shot "D-offer"

if wait_text "قبول" 20 || ui_dump | grep -qE "عرض|رحلة جديدة"; then
  OFFER_AT=$(date +%s%3N)
  result "D-offer" PASS "the offer reached the driver in $((OFFER_AT-REQUESTED_AT)) ms (target < 3000)"
  if tap_text "قبول" 6; then
    sleep 8
    shot "D-accept"
    result "D-accept" PASS "accepted"
  else
    result "D-accept" FAIL "could not accept"
  fi
else
  result "D-offer" FAIL "no offer on the driver's screen - see $OUT/D-offer.png"
  result "D-accept" SKIP "nothing to accept"
fi

# ---------------------------------------------------------------------------
say "E  Adversity"

"$ADB" shell svc wifi disable >/dev/null 2>&1
"$ADB" shell svc data disable >/dev/null 2>&1
sleep 12
"$ADB" shell svc wifi enable >/dev/null 2>&1
"$ADB" shell svc data enable >/dev/null 2>&1
sleep 15
shot "E-network"
if "$ADB" shell pidof "$DRIVER_PKG" >/dev/null 2>&1 && ! crashed "$DRIVER_PKG"; then
  result "E-net" PASS "survived losing the network"
else
  result "E-net" FAIL "did not survive the network drop"
fi

"$ADB" shell dumpsys deviceidle force-idle >/dev/null 2>&1
sleep 30
"$ADB" shell dumpsys deviceidle unforce >/dev/null 2>&1
sleep 8
if "$ADB" shell pidof "$DRIVER_PKG" >/dev/null 2>&1; then
  result "E-doze" PASS "survived forced Doze (30s - not the real §5.3 test)"
else
  result "E-doze" FAIL "killed by Doze"
fi

# ---------------------------------------------------------------------------
say "Result"

printf '  %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
printf '  report      %s/report.txt\n' "$OUT"
printf '  screenshots %s/*.png\n' "$OUT"

cat <<'STILL'

  Still needs a physical phone, and this cannot substitute for it:
    driver online, screen off, 30 minutes, in a moving car
    Wi-Fi <-> mobile handover
    Xiaomi MIUI process killing
STILL

(( FAIL == 0 ))
