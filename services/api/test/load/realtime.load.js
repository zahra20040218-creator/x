/* eslint-disable */
/**
 * WebSocket load — the gap `LOAD_TESTING.md` recorded as "not yet covered".
 *
 *   k6 run --vus 500 --duration 3m services/api/test/load/realtime.load.js
 *
 * The HTTP load script measures the claim and location ingest. It says nothing
 * about the realtime channel, and the realtime channel is new: until this
 * session the socket carried no application traffic at all, so "it holds 500
 * connections" had never been anything but an assumption.
 *
 * ## What one connection costs, and why that is the whole question
 *
 * Every online driver holds a socket open for their entire shift. At the §3
 * target of 500 concurrent users that is 500 sockets the process must keep,
 * each with a Redis subscription behind it. Two things can go wrong and
 * neither shows up in an HTTP test:
 *
 *   - the process runs out of file descriptors or heap and starts refusing
 *     connections, which looks to a driver like being silently logged out;
 *   - each socket's Redis subscription is made on its own connection, and
 *     Redis runs out first.
 *
 * This holds sockets open and reports which of those happens, if either.
 *
 * ## What it deliberately does not do
 *
 * It does not send ride traffic. Connection capacity is the unknown; message
 * throughput on an idle socket is not. `soak` mode adds a periodic ping so a
 * long run also proves the connections stay up rather than merely opening.
 *
 * ## Reading the numbers
 *
 * Run on one Windows laptop, the generator competing with the server for the
 * same four cores. Every latency is a pessimistic floor, and the connection
 * ceiling found here is a floor too - the VPS will do better. What a run here
 * proves is the shape: whether the ceiling is 100 or 1000.
 *
 * Fixtures come from `scripts/load-fixtures.mjs`, which mints the tokens.
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const WS_URL = __ENV.WS_URL || 'ws://127.0.0.1:3000/v1/realtime';
const HOLD_SECONDS = Number(__ENV.HOLD_SECONDS || 30);
const PING_SECONDS = Number(__ENV.PING_SECONDS || 0);

// Milliseconds of stagger between VUs before they connect.
//
// 0 is a thundering herd: every VU dials in the same instant. That is a real
// scenario - it is what a server restart looks like when every driver's client
// reconnects at once - but it is NOT what a normal shift looks like, where
// drivers come online over minutes. Measuring only the herd would report a
// connection ceiling that is really an accept-backlog limit, so both are run
// and reported separately.
const STAGGER_MS = Number(__ENV.STAGGER_MS || 0);

// The four numbers that decide whether this passes.
const opened = new Counter('ws_opened');
const readied = new Counter('ws_readied');
const refused = new Counter('ws_refused');
const droppedEarly = new Counter('ws_dropped_early');

const readyRate = new Rate('ws_ready_rate');
const timeToReady = new Trend('ws_time_to_ready_ms', true);

// A Counter, not a plain object. `handleSummary` runs in its own context after
// the test, so a module-level object mutated inside a VU is always empty by the
// time the summary is written - the first version of this script reported
// `close_codes: {}` after several hundred real closes.
const closedClean = new Counter('ws_closed_clean');
const closedAbnormal = new Counter('ws_closed_abnormal');

// A handshake that never becomes a socket fires NO socket events at all, so
// none of the counters above sees it. A 500-VU run reported 289 opened, zero
// refused and zero abnormal - the missing 211 were invisible because this
// counter did not exist. A blind spot that reports success is worse than a
// failure that reports itself.
const handshakeFailed = new Counter('ws_handshake_failed');

const tokens = JSON.parse(open(__ENV.FIXTURES || './fixtures.json')).driverTokens;

const VUS = Number(__ENV.VUS || 100);

export const options = {
  // One connection per VU, held for the whole window - which is what
  // "N concurrent connections" means.
  //
  // The first version used `vus` + `duration` and let VUs iterate. That churns:
  // a VU whose hold expires reconnects, so the run opened 242 sockets for 100
  // VUs and the peak concurrency was never actually N. Worse, sockets still
  // holding when the clock ran out were counted as failures. Neither told us
  // anything about capacity.
  scenarios: {
    hold: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: __ENV.MAX_DURATION || '10m',
    },
  },
  thresholds: {
    // A connection that never reaches `ready` is a driver who is offline
    // without being told. Anything below 99% is a failure, not a warning.
    ws_ready_rate: ['rate>0.99'],
    ws_time_to_ready_ms: ['p(95)<2000'],
  },
};

export default function () {
  // One token per VU, wrapping if there are more VUs than fixtures. Reusing a
  // token is fine - the gateway keys the channel on the token's subject and
  // supports several connections for the same user.
  const token = tokens[exec.vu.idInTest % tokens.length];

  if (STAGGER_MS > 0) {
    sleep((exec.vu.idInTest * STAGGER_MS) / 1000);
  }

  const startedAt = Date.now();

  const response = ws.connect(WS_URL, {}, (socket) => {
    let isReady = false;
    // Without this, a single failed socket is counted twice: `ws` fires both
    // `error` and `close`, and the first version incremented `refused` in each.
    // That is how a run reported 84 refusals for a gap of 42.
    let counted = false;

    socket.on('open', () => {
      opened.add(1);
      socket.send(JSON.stringify({ type: 'auth', token }));
    });

    socket.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch (_) {
        return;
      }

      if (frame.type === 'ready' && !isReady) {
        isReady = true;
        readied.add(1);
        readyRate.add(true);
        timeToReady.add(Date.now() - startedAt);

        // Hold the socket for the measured window. This is the point: the
        // server must still have it at the end.
        socket.setTimeout(() => socket.close(1000), HOLD_SECONDS * 1000);

        if (PING_SECONDS > 0) {
          socket.setInterval(() => socket.ping(), PING_SECONDS * 1000);
        }
      }
    });

    socket.on('close', (code) => {
      if (code === 1000) closedClean.add(1);
      else closedAbnormal.add(1);

      if (!isReady && !counted) {
        counted = true;
        // Closed before authenticating: refused, timed out, or the server
        // could not subscribe it (close code 4500).
        readyRate.add(false);
        refused.add(1);
      } else if (isReady && code !== 1000) {
        // Authenticated, then lost. This is the one that matters for a soak:
        // it means the server dropped a driver who had done nothing wrong.
        droppedEarly.add(1);
      }
    });

    socket.on('error', (error) => {
      const message = String((error && error.error && error.error()) || error || '');
      // `close sent` is the normal end of a socket we closed ourselves.
      if (message.indexOf('close sent') !== -1) return;
      if (isReady || counted) return;
      counted = true;
      refused.add(1);
      readyRate.add(false);
    });
  });

  if (!response || response.status !== 101) {
    handshakeFailed.add(1);
    readyRate.add(false);
    // Printed, not just counted: "connection refused" and "i/o timeout" mean
    // different things, and one of them is the generator's fault.
    if (exec.vu.idInTest % 50 === 0) {
      console.warn(`vu ${exec.vu.idInTest}: handshake ${response && response.status} ${response && response.error}`);
    }
  }
  check(response, { 'handshake returned 101': (r) => r && r.status === 101 });
}

export function handleSummary(data) {
  const metric = (name, field) => {
    const m = data.metrics[name];
    if (!m) return 0;
    return field ? (m.values[field] ?? 0) : (m.values.count ?? 0);
  };

  const summary = {
    vus: VUS,
    opened: metric('ws_opened'),
    readied: metric('ws_readied'),
    refused: metric('ws_refused'),
    dropped_after_ready: metric('ws_dropped_early'),
    ready_rate: metric('ws_ready_rate', 'rate'),
    time_to_ready_p50_ms: metric('ws_time_to_ready_ms', 'med'),
    time_to_ready_p95_ms: metric('ws_time_to_ready_ms', 'p(95)'),
    time_to_ready_p99_ms: metric('ws_time_to_ready_ms', 'p(99)'),
    handshake_failed: metric('ws_handshake_failed'),
    closed_clean: metric('ws_closed_clean'),
    closed_abnormal: metric('ws_closed_abnormal'),
  };

  return {
    stdout: '\n' + JSON.stringify(summary, null, 2) + '\n',
    [__ENV.SUMMARY_OUT || 'ws-summary.json']: JSON.stringify(summary, null, 2),
  };
}
