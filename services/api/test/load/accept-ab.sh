#!/usr/bin/env bash
#
# A/B: does holding 500 live WebSockets change the accept path's latency?
#
# Two soaks of the same profile reported accept p95 of 161 ms and then 748 ms,
# and the largest structural difference between them was not any code on the
# accept path - it was that the first run only got 285 of its 500 sockets
# authenticated (a subscriber bug, since fixed) while the second got all 500.
#
# A publish to a channel with no subscriber is nearly free. A publish to a live
# socket is not. Every accept publishes `ride.accepted` to both parties, so if
# that is the cost, it shows up here as a difference between the two runs and
# nowhere else.
#
# Run A: HTTP load only.
# Run B: identical, plus 500 held WebSockets.
#
# Everything else is held constant: same fixtures, same profile, same duration,
# same machine, back to back.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

K6="/c/Users/moaay/k6/k6.exe"
DURATION="${DURATION:-4m}"

run_http() {
  FIXTURES=./fixtures.json BASE_URL=http://127.0.0.1:3000/v1 \
    DRIVERS=200 RIDES_PER_MINUTE=120 RACERS=20 DURATION="$DURATION" \
    "$K6" run --quiet matching.load.js > "$1" 2>&1
}

echo "=== A: HTTP load only, no sockets ==="
run_http accept-ab-A.out
grep -E "wins|losses|accept|5xx|requests" accept-ab-A.out | sed 's/^/  /'

echo
echo "=== B: same load, plus 500 held sockets ==="
FIXTURES=./fixtures.json VUS=500 STAGGER_MS=10 HOLD_SECONDS=300 PING_SECONDS=30 \
  MAX_DURATION=10m SUMMARY_OUT=accept-ab-ws.json "$K6" run --quiet realtime.load.js \
  > accept-ab-ws.out 2>&1 &
WS=$!
sleep 20
run_http accept-ab-B.out
grep -E "wins|losses|accept|5xx|requests" accept-ab-B.out | sed 's/^/  /'
wait $WS 2>/dev/null

echo
echo "=== sockets that were actually live during B ==="
grep -E '"readied"|"refused"' accept-ab-ws.json | sed 's/^/  /'
echo "AB COMPLETE"
