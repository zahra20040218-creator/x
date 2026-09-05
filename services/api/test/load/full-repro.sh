#!/usr/bin/env bash
# The full 16-minute soak profile, with the split accept metric, to settle
# whether accept p95 = 748 ms reproduces at all and which path produces it.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
K6="/c/Users/moaay/k6/k6.exe"
FIXTURES=./fixtures.json VUS=500 STAGGER_MS=10 HOLD_SECONDS=960 PING_SECONDS=30 \
  MAX_DURATION=30m SUMMARY_OUT=repro-ws.json "$K6" run --quiet realtime.load.js > repro-ws.out 2>&1 &
WS=$!
sleep 20
FIXTURES=./fixtures.json BASE_URL=http://127.0.0.1:3000/v1 DRIVERS=200 RIDES_PER_MINUTE=120 \
  RACERS=20 DURATION=14m "$K6" run --quiet matching.load.js > repro-http.out 2>&1
wait $WS 2>/dev/null
echo "REPRO COMPLETE" >> repro-http.out
