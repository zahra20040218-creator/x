/* eslint-disable */
/**
 * Load test — CLAUDE.md §3: "500 concurrent users on a 4-core VPS".
 *
 * Run with k6 (https://k6.io), NOT with vitest:
 *
 *   k6 run --vus 500 --duration 5m services/api/test/load/matching.load.js
 *
 * It is a .js file on purpose: k6 runs its own JS runtime, not Node, so it
 * cannot import the TypeScript above it or use anything from node_modules.
 *
 * ## What this measures, and what it does not
 *
 * It measures the two paths that fall over first under contention: the atomic
 * claim (CLAUDE.md §5.1) and location ingest (§3.1). It does NOT measure the
 * thing the 500-user target is really about — whether a 25-slot PgBouncer pool
 * survives — because that depends on the VPS, and running this against a
 * laptop tells you nothing about the VPS.
 *
 * ## What the numbers from a laptop run mean
 *
 * First run: 2026-08-24, k6 v0.54.0, against the API, PostgreSQL 17.11 and
 * Redis 8.0.5 all on one Windows laptop. The load generator competes with the
 * server for the same cores, so the latencies are a PESSIMISTIC floor and not
 * a measurement of the 4-core VPS the target is written against. What a run
 * here does prove is the shape: that the atomic claim holds under contention,
 * that idempotency holds under retry, and that nothing 500s.
 *
 * Fixtures come from `scripts/load-fixtures.mjs`, which mints the tokens and
 * builds the race ride. Without it there is nothing to run against.
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000/v1';

// The number that matters. If two drivers ever both get 200 on the same ride,
// CLAUDE.md §5.1 is broken and ACCEPTANCE_CHECKLIST check 4 would fail on the
// street.
const claimWins = new Counter('claim_wins');

/**
 * Any 5xx. This is the real failure signal.
 *
 * `http_req_failed` cannot be it: this script generates 4xx deliberately and in
 * bulk. Every losing driver in the claim race gets a 409 - that is the feature
 * working - and a rider who already holds an active ride gets a 409 from the
 * `rides_one_active_per_rider_uq` index, which is also the feature working. A
 * blanket `http_req_failed: rate<0.01` therefore fails a completely healthy
 * run, and would have to be ignored, which is how a threshold stops being read
 * at all.
 */
const serverErrors = new Counter('server_errors');
const claimLosses = new Counter('claim_losses');
const duplicateRides = new Counter('duplicate_rides_created');

/**
 * Accept latency, split three ways, because one number was measuring three
 * different things and reporting the worst of them.
 *
 * A claim race of 20 VUs x 50 iterations produces ~1000 accepts of which
 * exactly ONE wins. `accept_latency_ms` averaged all of them, so its p95 was
 * always the tail of the LOSING path - and the two losing paths are not even
 * the same shape:
 *
 *   win     - claim acquired, transaction commits, ride assigned. One sample.
 *   lose_fast - the claim key is held by the winner, so `SET NX` fails and the
 *             request returns 409 without touching Postgres.
 *   lose_slow - the winner's claim has since expired (30s TTL), so `SET NX`
 *             SUCCEEDS, the request opens a transaction, takes a FOR UPDATE
 *             row lock, finds no pending offer, rolls back and releases the
 *             claim. Strictly more work than a win that fails at the end.
 *
 * Reporting them together made a healthy system look slower than a broken one:
 * a degraded run where Redis was timing out returned `lose_fast` for almost
 * everything and scored 161 ms, while a healthy run does the real work and
 * scores 748 ms. The number went up because the system started working.
 */
const acceptLatency = new Trend('accept_latency_ms');
const acceptWin = new Trend('accept_win_ms');
const acceptLoseFast = new Trend('accept_lose_fast_ms');
const acceptLoseSlow = new Trend('accept_lose_slow_ms');
const locationLatency = new Trend('location_ingest_ms');
const errorRate = new Rate('errors');

export const options = {
  scenarios: {
    // Drivers reporting position every 5s — the steady background load that
    // everything else has to survive.
    location_ingest: {
      executor: 'constant-vus',
      vus: Number(__ENV.DRIVERS || 400),
      duration: __ENV.DURATION || '5m',
      exec: 'reportLocation',
    },
    // Riders requesting rides.
    ride_requests: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RIDES_PER_MINUTE || 120),
      timeUnit: '1m',
      duration: __ENV.DURATION || '5m',
      preAllocatedVUs: 100,
      exec: 'requestRide',
    },
    // The contention case: many drivers hitting accept on the SAME ride.
    claim_race: {
      executor: 'per-vu-iterations',
      vus: Number(__ENV.RACERS || 20),
      iterations: 50,
      exec: 'raceForRide',
      startTime: '30s',
    },
  },

  thresholds: {
    // Exactly one driver may ever win the race ride. This is the assertion the
    // whole file exists for, and it is expressed as the aggregate because k6
    // gives a VU no view of any other VU: `claim_wins` is summed across every
    // VU at the end of the run, so two winners anywhere makes it 2.
    //
    // It replaces a `double_accepts: ['count==0']` threshold fed by
    // `doubleAccepts.add(0)` - a counter that could only ever be zero, so the
    // check could not fail and proved nothing.
    claim_wins: ['count==1'],
    duplicate_rides_created: ['count==0'],

    // A 500 under load is the thing that ends a pilot. Expected 4xx are not.
    server_errors: ['count==0'],

    // A driver waiting more than a second to accept starts tapping again.
    accept_latency_ms: ['p(95)<1000'],

    // Location ingest is Redis-only (CLAUDE.md §3.1); if this is slow, a
    // Postgres write has crept onto the request path.
    location_ingest_ms: ['p(95)<200', 'p(99)<500'],

    // Scoped to what it can actually mean: `errors` counts a non-202 from
    // location ingest and a non-409 4xx from ride creation, so 409s are already
    // excluded. `http_req_failed` is deliberately absent - see `server_errors`.
    errors: ['rate<0.02'],
  },
};

function authHeaders(token) {
  return { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
}

/**
 * Tokens come from `scripts/load-fixtures.mjs`, not from a sign-in inside the
 * test - signing in here would measure Firebase's latency instead of ours.
 *
 * Set FIXTURES to the file that script wrote. The comma-separated environment
 * variables still work and take precedence, but they stop scaling: a JWT is
 * about 300 characters and Windows caps an environment variable at 32 KB, so
 * anything past ~100 drivers silently truncates the list. The file has no such
 * limit, and the same file feeds `realtime.load.js`.
 */
function fromFixtures() {
  if (!__ENV.FIXTURES) return {};
  try {
    return JSON.parse(open(__ENV.FIXTURES));
  } catch (error) {
    throw new Error(`could not read FIXTURES at ${__ENV.FIXTURES}: ${error}`);
  }
}
const FIXTURES = fromFixtures();

const DRIVER_TOKENS = (__ENV.K6_DRIVER_TOKENS || '').split(',').filter(Boolean).length
  ? (__ENV.K6_DRIVER_TOKENS || '').split(',').filter(Boolean)
  : (FIXTURES.driverTokens || []);
const RIDER_TOKENS = (__ENV.K6_RIDER_TOKENS || '').split(',').filter(Boolean).length
  ? (__ENV.K6_RIDER_TOKENS || '').split(',').filter(Boolean)
  : (FIXTURES.riderTokens || []);
const RACE_RIDE_ID = __ENV.K6_RACE_RIDE_ID || FIXTURES.raceRideId || '';

export function setup() {
  if (DRIVER_TOKENS.length === 0 || RIDER_TOKENS.length === 0) {
    throw new Error(
      'No tokens. Either set FIXTURES to the file written by ' +
        'scripts/load-fixtures.mjs, or export K6_DRIVER_TOKENS and ' +
        'K6_RIDER_TOKENS as comma-separated lists.',
    );
  }
  return {};
}

/** Baghdad, roughly within the city. */
function randomBaghdadPoint() {
  return {
    lat: 33.27 + Math.random() * 0.12,
    lng: 44.33 + Math.random() * 0.14,
  };
}

export function reportLocation() {
  const token = DRIVER_TOKENS[exec.vu.idInTest % DRIVER_TOKENS.length];
  const point = randomBaghdadPoint();

  const response = http.post(
    `${BASE_URL}/driver/location`,
    JSON.stringify({
      samples: [{ ...point, recordedAt: new Date().toISOString() }],
    }),
    authHeaders(token),
  );

  locationLatency.add(response.timings.duration);
  errorRate.add(response.status !== 202);
  if (response.status >= 500) serverErrors.add(1);

  check(response, { 'location accepted (202)': (r) => r.status === 202 });

  // Matches the app's 5s sampling interval.
  sleep(5);
}

export function requestRide() {
  const token = RIDER_TOKENS[exec.scenario.iterationInTest % RIDER_TOKENS.length];
  const key = `${exec.vu.idInTest}-${exec.scenario.iterationInTest}-${Date.now()}`;

  const body = JSON.stringify({
    pickup: randomBaghdadPoint(),
    dropoff: randomBaghdadPoint(),
  });

  const first = http.post(`${BASE_URL}/rides`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
  });

  // Immediately retry with the SAME key, simulating a dropped response. This
  // is CLAUDE.md §5.2 under load: the retry must return the ORIGINAL ride.
  const retry = http.post(`${BASE_URL}/rides`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
  });

  if (first.status === 201 && retry.status === 201) {
    const firstId = first.json('id');
    const retryId = retry.json('id');
    if (firstId !== retryId) {
      // Two rides from one intent - three drivers dispatched for one rider.
      duplicateRides.add(1);
    }
  }

  errorRate.add(first.status >= 400 && first.status !== 409);
  if (first.status >= 500 || retry.status >= 500) serverErrors.add(1);

  check(first, {
    'ride created or conflicted': (r) => r.status === 201 || r.status === 409,
  });

  sleep(1);
}

/**
 * ACCEPTANCE_CHECKLIST.md check 4, automated and under load.
 *
 * Every VU hammers accept on ONE ride id. Exactly one may get 200.
 */
export function raceForRide() {
  if (!RACE_RIDE_ID) return;

  group('claim race', () => {
    const token = DRIVER_TOKENS[exec.vu.idInTest % DRIVER_TOKENS.length];
    const response = http.post(
      `${BASE_URL}/rides/${RACE_RIDE_ID}/accept`,
      null,
      authHeaders(token),
    );

    const elapsed = response.timings.duration;
    acceptLatency.add(elapsed);
    if (response.status >= 500) serverErrors.add(1);

    if (response.status === 200) {
      // Summed across all VUs; the threshold above requires the total to be 1.
      claimWins.add(1);
      acceptWin.add(elapsed);
    } else if (response.status === 409) {
      claimLosses.add(1);
      // `ride-already-claimed` means the claim key was held and the request
      // never reached Postgres. Anything else - a transition conflict, an
      // active-ride conflict - means it did. Read from the problem `type`
      // rather than inferred from the timing, so the split does not depend on
      // the thing being measured.
      const problem = response.body || '';
      if (problem.indexOf('ride-already-claimed') !== -1) {
        acceptLoseFast.add(elapsed);
      } else {
        acceptLoseSlow.add(elapsed);
      }
    } else if (response.status === 404) {
      // The offer is gone: the claim had expired, so this request DID open a
      // transaction before being refused.
      acceptLoseSlow.add(elapsed);
    }

    check(response, {
      'accept is 200 or 409, never 500': (r) => r.status === 200 || r.status === 409,
    });
  });
}

/**
 * The run summary.
 *
 * Replaces k6's own table, so it has to carry the things a FAILING run needs:
 * the error rate, the HTTP failure rate, and which thresholds broke. The first
 * version printed only latency and the race result, which meant a run with a
 * red `errors` threshold gave no way to see what had gone wrong.
 */
export function handleSummary(data) {
  const m = data.metrics;
  const num = (name, field, digits = 0) => {
    const metric = m[name];
    if (!metric || metric.values[field] === undefined) return 'n/a';
    const value = metric.values[field];
    return digits === 0 ? String(Math.round(value)) : value.toFixed(digits);
  };
  const count = (name) => (m[name] ? m[name].values.count : 0);

  const wins = count('claim_wins');
  const raceNote =
    wins === 1
      ? 'exactly one winner, as required'
      : wins === 0
        ? 'NO winner. Either the race ride was already accepted by an earlier\n' +
          '           run - it is consumed once won, so regenerate fixtures - or\n' +
          '           it is not in OFFERED state.'
        : 'MORE THAN ONE WINNER. CLAUDE.md 5.1 is broken: two drivers were\n' +
          '           sent to the same rider.';

  const broken = Object.entries(data.metrics)
    .filter(([, metric]) => metric.thresholds &&
      Object.values(metric.thresholds).some((t) => t.ok === false))
    .map(([name]) => name);

  return {
    stdout: `
=== Load test summary ===

Claim race (CLAUDE.md 5.1)
  wins   : ${wins}
  losses : ${count('claim_losses')}
  verdict: ${raceNote}

Idempotency (CLAUDE.md 5.2)
  duplicate rides from one key : ${count('duplicate_rides_created')}   (must be 0)

Throughput and failures
  requests            : ${count('http_reqs')}
  server errors (5xx) : ${count('server_errors')}   (threshold == 0)
  script errors       : ${num('errors', 'rate', 4)}   (threshold < 0.02)
  checks passed       : ${num('checks', 'rate', 4)}

  Note: a large 4xx count is EXPECTED here and is not in any threshold. Every
  losing driver in the race gets a 409, and so does a rider who already holds
  an active ride. Both are the system working.

Latency
  http_req_duration p50 : ${num('http_req_duration', 'med')} ms
  http_req_duration p95 : ${num('http_req_duration', 'p(95)')} ms
  http_req_duration max : ${num('http_req_duration', 'max')} ms
  accept  (all)     p95 : ${num('accept_latency_ms', 'p(95)')} ms
  accept  win       p95 : ${num('accept_win_ms', 'p(95)')} ms
  accept  lose fast p95 : ${num('accept_lose_fast_ms', 'p(95)')} ms
  accept  lose slow p95 : ${num('accept_lose_slow_ms', 'p(95)')} ms
  location ingest   p95 : ${num('location_ingest_ms', 'p(95)')} ms   (threshold < 200)
  location ingest   p99 : ${num('location_ingest_ms', 'p(99)')} ms   (threshold < 500)

Thresholds broken: ${broken.length === 0 ? 'none' : broken.join(', ')}

These numbers came from a machine running k6, the API, PostgreSQL and Redis at
once. The load generator competes with the server for the same cores, so treat
the latencies as a pessimistic floor - they are NOT a measurement of the 4-core
VPS the 500-user target is written against.
`,
  };
}
