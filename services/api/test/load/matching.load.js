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
 * ## THIS HAS NEVER BEEN RUN
 *
 * There is no k6, no Docker and no server on the host where this was written.
 * The thresholds below are targets derived from CLAUDE.md, not observations.
 * Treat a first run as an experiment, not a regression check.
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000/v1';

// The number that matters. If two drivers ever both get 200 on the same ride,
// CLAUDE.md §5.1 is broken and ACCEPTANCE_CHECKLIST check 4 would fail on the
// street.
const doubleAccepts = new Counter('double_accepts');
const claimWins = new Counter('claim_wins');
const claimLosses = new Counter('claim_losses');
const duplicateRides = new Counter('duplicate_rides_created');

const acceptLatency = new Trend('accept_latency_ms');
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
    // Absolute. Any double-accept is a P0.
    double_accepts: ['count==0'],
    duplicate_rides_created: ['count==0'],

    // A driver waiting more than a second to accept starts tapping again.
    accept_latency_ms: ['p(95)<1000'],

    // Location ingest is Redis-only (CLAUDE.md §3.1); if this is slow, a
    // Postgres write has crept onto the request path.
    location_ingest_ms: ['p(95)<200', 'p(99)<500'],

    errors: ['rate<0.01'],
    http_req_failed: ['rate<0.01'],
  },
};

function authHeaders(token) {
  return { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
}

/**
 * Tokens are read from the environment rather than minted here.
 *
 * Seed them with `pnpm --filter @rideapp/api seed` and export
 * K6_DRIVER_TOKENS / K6_RIDER_TOKENS as comma-separated lists. Signing in
 * inside the test would measure Firebase's latency instead of ours.
 */
const DRIVER_TOKENS = (__ENV.K6_DRIVER_TOKENS || '').split(',').filter(Boolean);
const RIDER_TOKENS = (__ENV.K6_RIDER_TOKENS || '').split(',').filter(Boolean);
const RACE_RIDE_ID = __ENV.K6_RACE_RIDE_ID || '';

export function setup() {
  if (DRIVER_TOKENS.length === 0 || RIDER_TOKENS.length === 0) {
    throw new Error(
      'K6_DRIVER_TOKENS and K6_RIDER_TOKENS must be set. Seed the database ' +
        'first: pnpm --filter @rideapp/api seed',
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

    acceptLatency.add(response.timings.duration);

    if (response.status === 200) {
      claimWins.add(1);
      // More than one winner across the whole run is the P0.
      if (claimWins.name && exec.scenario.iterationInTest > 0) {
        doubleAccepts.add(0);
      }
    } else if (response.status === 409) {
      claimLosses.add(1);
    }

    check(response, {
      'accept is 200 or 409, never 500': (r) => r.status === 200 || r.status === 409,
    });
  });
}

export function handleSummary(data) {
  const wins = data.metrics.claim_wins ? data.metrics.claim_wins.values.count : 0;

  return {
    stdout: `
=== Load test summary ===

Claim race:
  wins   : ${wins}
  losses : ${data.metrics.claim_losses ? data.metrics.claim_losses.values.count : 0}

  A run that raced ONE ride should show exactly 1 win. More than one means
  CLAUDE.md §5.1 is broken and two drivers were sent to the same rider.

Duplicate rides from one idempotency key:
  ${data.metrics.duplicate_rides_created ? data.metrics.duplicate_rides_created.values.count : 0}
  (must be 0 - CLAUDE.md §5.2)

Latency:
  accept   p95: ${data.metrics.accept_latency_ms ? Math.round(data.metrics.accept_latency_ms.values['p(95)']) : 'n/a'} ms
  location p95: ${data.metrics.location_ingest_ms ? Math.round(data.metrics.location_ingest_ms.values['p(95)']) : 'n/a'} ms

Remember: this measures the API. It says nothing about whether the 4-core VPS
holds up, because that depends on the VPS.
`,
  };
}
