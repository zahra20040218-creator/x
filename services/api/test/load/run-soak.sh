#!/usr/bin/env bash
# §17 soak: 500 held sockets + real ride and location traffic, together.
#
# Launched detached, because a foreground shell that is killed at a timeout
# takes its child k6 processes with it - the first attempt died at 7 minutes
# and wrote no summary at all.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
K6="/c/Users/moaay/k6/k6.exe"
MC="/c/Program Files/Memurai/memurai-cli.exe"
PID="$(cat /tmp/soak.pid)"
MINUTES="${MINUTES:-16}"

: > soak-samples.txt
FIXTURES=./fixtures.json VUS=500 STAGGER_MS=10 HOLD_SECONDS=$((MINUTES*60)) PING_SECONDS=30 \
  MAX_DURATION=30m SUMMARY_OUT=soak-ws.json "$K6" run --quiet realtime.load.js > soak-ws.out 2>&1 &
WS=$!
sleep 20
FIXTURES=./fixtures.json BASE_URL=http://127.0.0.1:3000/v1 DRIVERS=200 RIDES_PER_MINUTE=120 \
  RACERS=20 DURATION=$((MINUTES-2))m "$K6" run --quiet matching.load.js > soak-http.out 2>&1 &
HTTP=$!

for i in $(seq 1 "$MINUTES"); do
  sleep 60
  S=$(powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 3000 -State Established -ErrorAction SilentlyContinue|Measure-Object).Count" 2>/dev/null | tr -d '\r')
  M=$(powershell -NoProfile -Command "[int]((Get-Process -Id $PID -ErrorAction SilentlyContinue).WorkingSet64/1MB)" 2>/dev/null | tr -d '\r')
  R=$("$MC" -h 127.0.0.1 -p 6380 INFO clients 2>/dev/null | grep -oE 'connected_clients:[0-9]+' | cut -d: -f2)
  H=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/v1/health)
  printf "%2dm sockets=%-5s mem=%-5s redis=%-5s health=%s\n" "$i" "${S:-?}" "${M:-DEAD}" "${R:-?}" "$H" >> soak-samples.txt
done

wait $WS $HTTP
echo "SOAK COMPLETE" >> soak-samples.txt
