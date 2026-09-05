#!/usr/bin/env bash
#
# Everything a streamed Android device needs, in one command.
#
# Android Device Streaming gives you ADB access to a real handset in a Google
# data centre. That device cannot reach your laptop's 127.0.0.1, so the API has
# to be bridged over ADB — which is what `adb reverse` does, and why the apps
# for this session are built pointing at `localhost` rather than the emulator's
# `10.0.2.2`.
#
#   scripts/device-session.sh start     bring everything up and bridge it
#   scripts/device-session.sh bridge    re-run just the bridge after reconnect
#   scripts/device-session.sh install   push both APKs to the device
#   scripts/device-session.sh watch     tail what the server sees, live
#   scripts/device-session.sh stop      shut down
#
# The bridge dies whenever the device disconnects. `bridge` is separate for
# exactly that reason — you will need it more than once in a session.

set -uo pipefail

# Tools are LOCATED, not assumed to be on PATH.
#
# Running this as `bash scripts/device-session.sh` from PowerShell gives bash a
# PATH that does not include the Windows installers' directories, so `node`,
# `flutter` and `adb` are all missing even though they are installed. The first
# version of this script failed with "node is not on PATH" for exactly that
# reason.
for extra in   "/c/Program Files/nodejs"   "$HOME/flutter/bin"   "${ANDROID_HOME:-$HOME/AppData/Local/Android/Sdk}/platform-tools"   "$HOME/pg17/pgsql/bin"   "/c/Program Files/Memurai"
do
  [[ -d "$extra" ]] && case ":$PATH:" in *":$extra:"*) ;; *) PATH="$PATH:$extra" ;; esac
done
export PATH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$ROOT/services/api"

PG_URL="postgres://rideapp:rideapp@127.0.0.1:5433/rideapp_test"
REDIS_URL="redis://127.0.0.1:6380"
JWT="load-test-secret-key-at-least-32-chars"
SA="$HOME/keystores/fcm-service-account.json"

ADB="${ANDROID_HOME:-$HOME/AppData/Local/Android/Sdk}/platform-tools/adb.exe"
[[ -x "$ADB" ]] || ADB="adb"

log() { printf '\n\033[1m%s\033[0m\n' "$*"; }

kill_port_3000() {
  local pid
  pid=$(powershell -NoProfile -Command \
    "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess" \
    2>/dev/null | tr -d '\r\n ')
  [[ -n "$pid" ]] && powershell -NoProfile -Command "Stop-Process -Id $pid -Force" 2>/dev/null
  return 0
}

bridge() {
  log "Bridging the device to this machine"
  "$ADB" devices | sed 's/^/  /'

  # Reverse, not forward: the DEVICE opens localhost:3000 and it lands here.
  if "$ADB" reverse tcp:3000 tcp:3000 >/dev/null 2>&1; then
    echo "  adb reverse tcp:3000 -> OK"
    echo "  the app's localhost:3000 now reaches this machine"
  else
    echo "  adb reverse FAILED"
    echo "  no device is attached, or streaming has disconnected."
    echo "  Reconnect in Android Studio, then: scripts/device-session.sh bridge"
    return 1
  fi
}

start() {
  if ! command -v node >/dev/null; then
    echo "node not found. Looked on PATH and in C:\Program Files\nodejs."
    echo "If it is installed elsewhere:  export PATH=\"\$PATH:/path/to/nodejs\""
    exit 1
  fi

  log "1/5  Checking infrastructure"
  local pg redis
  pg=$(PGPASSWORD=rideapp "$HOME/pg17/pgsql/bin/psql.exe" -h 127.0.0.1 -p 5433 -U rideapp \
        -d rideapp_test -tAc "SELECT 1" 2>/dev/null | tr -d '\r\n ')
  redis=$("/c/Program Files/Memurai/memurai-cli.exe" -h 127.0.0.1 -p 6380 PING 2>/dev/null | tr -d '\r\n ')
  echo "  PostgreSQL : ${pg:-DOWN}"
  echo "  Redis      : ${redis:-DOWN}"
  [[ "$pg" == "1" && "$redis" == "PONG" ]] || { echo "  Start them before continuing."; exit 1; }

  log "2/5  Building the server"
  (cd "$API" && DATABASE_URL="$PG_URL" npx tsc -p tsconfig.build.json) || exit 1
  echo "  built"

  log "3/5  Seeding drivers, riders and configuration"
  (cd "$API" && DATABASE_URL="$PG_URL" node dist/db/migrate.js up 2>&1 | tail -1)
  (cd "$API" && LOAD_DRIVERS=3 LOAD_RIDERS=3 JWT_SECRET="$JWT" DATABASE_URL="$PG_URL" \
      node scripts/load-fixtures.mjs >/dev/null 2>&1) && echo "  fixtures ready"
  (cd "$API" && DATABASE_URL="$PG_URL" node dist/db/seed.js 2>&1 | tail -1 | sed 's/^/  /')

  # Old positions from a previous session would make matching pick a driver who
  # is not the one on the handset.
  memurai-cli.exe -h 127.0.0.1 -p 6380 DEL drivers:online >/dev/null 2>&1
  echo "  stale driver positions cleared"

  log "4/5  Starting the API and the worker"
  kill_port_3000
  sleep 2

  local fcm=""
  [[ -f "$SA" ]] && fcm="$(cat "$SA")"

  ( cd "$API" && FCM_SERVICE_ACCOUNT_JSON="$fcm" DATABASE_URL="$PG_URL" REDIS_URL="$REDIS_URL" \
      FIREBASE_PROJECT_ID="darb-production-cc0cc" JWT_SECRET="$JWT" \
      CORS_ALLOWED_ORIGINS="http://localhost:5173" PORT=3000 NODE_ENV=development \
      node dist/main.js > /tmp/device-api.log 2>&1 & )

  # The worker is not optional: ride dispatch happens there. Without it a ride
  # is created and never offered to anybody.
  ( cd "$API" && FCM_SERVICE_ACCOUNT_JSON="$fcm" DATABASE_URL="$PG_URL" REDIS_URL="$REDIS_URL" \
      FIREBASE_PROJECT_ID="darb-production-cc0cc" JWT_SECRET="$JWT" NODE_ENV=development \
      node dist/worker.js > /tmp/device-worker.log 2>&1 & )

  echo -n "  waiting for the API "
  for _ in $(seq 1 30); do
    curl -s -o /dev/null --max-time 2 http://127.0.0.1:3000/v1/health && break
    echo -n "."; sleep 2
  done
  echo

  local health
  health=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:3000/v1/health)
  echo "  API    : $health"
  echo "  worker : $(grep -ac 'workers running' /tmp/device-worker.log 2>/dev/null) running"
  echo "  push   : $(grep -qac 'push.unconfigured' /tmp/device-worker.log && echo 'DISABLED - no service account' || echo 'configured')"

  log "5/5  Bridging"
  bridge || true

  cat <<'READY'

READY.

  Sign in on BOTH apps with the Firebase test number:
      +9647700000001      code 123456

  Watch what the server sees, in another terminal:
      scripts/device-session.sh watch
READY
}

install_apks() {
  local d="$ROOT/apps/driver/build/app/outputs/flutter-apk/app-debug.apk"
  local r="$ROOT/apps/rider/build/app/outputs/flutter-apk/app-debug.apk"

  for apk in "$d" "$r"; do
    [[ -f "$apk" ]] || { echo "missing: $apk"; echo "build first"; return 1; }
  done

  log "Installing"
  # -r replaces without clearing data; -d permits a downgrade during testing.
  "$ADB" install -r -d "$d" 2>&1 | tail -2
  "$ADB" install -r -d "$r" 2>&1 | tail -2
}

watch_logs() {
  log "Server events, live. Ctrl-C to stop."
  tail -f /tmp/device-api.log /tmp/device-worker.log 2>/dev/null \
    | grep --line-buffered -oE '"event":"[a-z._]+"[^,]*|"msg":"[^"]*"' \
    | grep --line-buffered -vE 'ratelimit|metrics'
}

stop() {
  log "Stopping"
  kill_port_3000
  powershell -NoProfile -Command \
    "Get-Process node -ErrorAction SilentlyContinue | Where-Object { \$_.StartTime -gt (Get-Date).AddHours(-6) } | Stop-Process -Force" 2>/dev/null
  "$ADB" reverse --remove-all >/dev/null 2>&1
  echo "  stopped"
}

case "${1:-start}" in
  start)   start ;;
  bridge)  bridge ;;
  install) install_apks ;;
  watch)   watch_logs ;;
  stop)    stop ;;
  *)       echo "usage: $0 {start|bridge|install|watch|stop}"; exit 2 ;;
esac
