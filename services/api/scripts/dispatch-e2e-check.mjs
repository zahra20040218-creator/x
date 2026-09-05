/**
 * End-to-end check: does a rider's ride request reach a driver's socket?
 *
 * Not a unit test. This drives the real API process, the real worker, real
 * PostgreSQL and real Redis, and measures the wall-clock time from `POST
 * /rides` returning to `ride.offer` arriving on a driver's WebSocket.
 *
 * Before today the answer was no on two counts: nothing dispatched a new ride,
 * and nothing published to the socket.
 *
 * ## Prerequisites
 *
 *   pnpm build
 *   node scripts/load-fixtures.mjs      # drivers, riders, tokens
 *   node dist/main.js                   # the API
 *   node dist/worker.js                 # the worker - dispatch happens HERE
 *   JWT_SECRET=<same as the API> node scripts/dispatch-e2e-check.mjs
 *
 * The test suite truncates every table, so run the fixtures after it, not
 * before. A missing driver row is a missing fixture, not a failure of the
 * thing being checked.
 *
 * Measured 2026-08-24 on this machine: 66 ms, 45 ms, 36 ms across three runs,
 * against the CLAUDE.md 3 target of 3 seconds.
 */

import WebSocket from 'ws';

import { SystemClock } from '../dist/common/clock.js';
import { PgDatabase } from '../dist/db/pg-database.js';
import { TokenService } from '../dist/auth/token.service.js';

const BASE = 'http://127.0.0.1:3000/v1';
const WS_URL = 'ws://127.0.0.1:3000/v1/realtime';
const SECRET = process.env.JWT_SECRET;

const db = new PgDatabase({
  connectionString: 'postgres://rideapp:rideapp@127.0.0.1:5433/rideapp_test',
  maxConnections: 4,
});
const tokens = new TokenService(SECRET, new SystemClock(), 3600, 86400);

const step = (n, text) => console.log(`\n[${n}] ${text}`);

const driverRow = (await db.query(`SELECT user_id FROM drivers ORDER BY user_id LIMIT 1`)).rows[0];
const riderRow = (await db.query(`SELECT user_id FROM riders ORDER BY user_id LIMIT 1`)).rows[0];
const adminRow = (await db.query(`SELECT id FROM users WHERE role='ADMIN' ORDER BY id LIMIT 1`)).rows[0];

const driverId = driverRow.user_id;
const riderId = riderRow.user_id;

// The rider must not already hold an active ride - rides_one_active_per_rider_uq.
await db.query(
  `UPDATE rides SET status='CANCELLED_BY_RIDER'
    WHERE rider_id=$1 AND status IN ('REQUESTED','OFFERED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')`,
  [riderId],
);

const driverToken = (await tokens.issuePair(db, driverId, 'DRIVER')).accessToken;
const riderToken = (await tokens.issuePair(db, riderId, 'RIDER')).accessToken;
const adminToken = (await tokens.issuePair(db, adminRow.id, 'ADMIN')).accessToken;

const call = async (path, options = {}) => {
  const response = await fetch(`${BASE}${path}`, options);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const auth = (token, extra = {}) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
  ...extra,
});

// Leftovers from earlier runs and the load test sit in the geo set, so
// matching would pick one of them instead of the driver on this socket.
step(0, 'Clearing stale driver positions so this run has one candidate');
{
  const { IoRedisAdapter } = await import('../dist/redis/ioredis-adapter.js');
  const redis = IoRedisAdapter.fromUrl('redis://127.0.0.1:6380');
  await new Promise((r) => setTimeout(r, 300));
  await redis.del?.('drivers:online').catch(() => undefined);
  await redis.close?.().catch(() => undefined);
  console.log('    geo set cleared');
}

step(1, 'Satisfying the document policy for this driver');
for (const type of ['DRIVING_LICENCE', 'VEHICLE_REGISTRATION']) {
  const r = await call(`/admin/drivers/${driverId}/documents/${type}`, {
    method: 'PUT',
    headers: auth(adminToken),
    body: JSON.stringify({ status: 'VERIFIED', reference: 'E2E', expiresAt: '2030-01-01' }),
  });
  console.log(`    ${type}: HTTP ${r.status}`);
}

step(2, 'Driver goes ONLINE (this is what puts them in the Redis geo set)');
const online = await call('/driver/availability', {
  method: 'PUT',
  headers: auth(driverToken),
  body: JSON.stringify({
    availability: 'ONLINE',
    position: { lat: 33.3061, lng: 44.4213 },
  }),
});
console.log(`    HTTP ${online.status}`);
if (online.status !== 200) {
  console.log('   ', JSON.stringify(online.body));
  process.exit(1);
}

step(3, 'Driver connects to the realtime socket and authenticates');
const socket = new WebSocket(WS_URL);
const offers = [];
let ready = false;

await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});
socket.on('message', (data) => {
  const event = JSON.parse(data.toString('utf8'));
  if (event.type === 'ready') {
    ready = true;
    return;
  }
  offers.push({ at: Date.now(), event });
});
socket.send(JSON.stringify({ type: 'auth', token: driverToken }));
await new Promise((r) => setTimeout(r, 400));
console.log(`    authenticated: ${ready}`);

step(4, 'Rider requests a ride');
const requestedAt = Date.now();
const created = await call('/rides', {
  method: 'POST',
  headers: auth(riderToken, { 'Idempotency-Key': crypto.randomUUID() }),
  body: JSON.stringify({
    pickup: { lat: 33.3061, lng: 44.4213 },
    dropoff: { lat: 33.2989, lng: 44.4361 },
  }),
});
console.log(`    HTTP ${created.status}  ride ${created.body?.id}  status ${created.body?.status}`);

step(5, 'Waiting for ride.offer on the driver socket');
const rideId = created.body?.id;
const deadline = Date.now() + 15_000;
while (!offers.some((o) => o.event.type === 'ride.offer') && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 25));
}

const offer = offers.find((o) => o.event.type === 'ride.offer');
let latency = null;
if (!offer) {
  console.log('    NOTHING ARRIVED within 15s');
} else {
  latency = offer.at - requestedAt;
  console.log(`    +${latency} ms  ride.offer  ${JSON.stringify(offer.event.payload)}`);
}

step(6, 'Binding the event to the ride and to the driver');
//
// These are what make this a proof rather than a coincidence. A run where the
// offer went to a DIFFERENT driver - a leftover in the geo set, or a
// non-deterministic `LIMIT 1` - looks identical from the socket's side unless
// the ids are checked against the database.
const persisted = await db.query(
  `SELECT driver_id, status FROM ride_offers WHERE ride_id = $1`,
  [rideId],
);
const rideRow = await db.query(`SELECT status FROM rides WHERE id = $1`, [rideId]);

const checks = [
  ['offer event names THIS ride', offer?.event.payload?.rideId === rideId],
  ['exactly one offer persisted', persisted.rows.length === 1],
  ['persisted to the driver on this socket', persisted.rows[0]?.driver_id === driverId],
  ['ride reached OFFERED', rideRow.rows[0]?.status === 'OFFERED'],
  ['offer row exists alongside the event', persisted.rows.length === 1 && offer != null],
  ['latency under the 3000 ms target', latency !== null && latency < 3000],
];

let allPassed = true;
for (const [label, ok] of checks) {
  console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) allPassed = false;
}

console.log(
  `\n    ${allPassed ? 'END-TO-END PASS' : 'END-TO-END FAIL'}` +
    (latency === null ? '' : `  -  matching latency ${latency} ms`),
);

socket.close();
await db.close();
process.exit(allPassed ? 0 : 1);
