/**
 * Fixtures for the k6 load test.
 *
 * `test/load/matching.load.js` needs K6_DRIVER_TOKENS, K6_RIDER_TOKENS and
 * K6_RACE_RIDE_ID, and its header said to get them from `pnpm seed`. `pnpm
 * seed` creates two drivers and mints nothing, so the load test could never
 * actually be started. This closes that gap.
 *
 * Creates N drivers and M riders with deterministic ids, mints one access
 * token each, and sets up a single ride with a PENDING offer to EVERY driver
 * so the claim race has something real to race for.
 *
 * ## Why offers matter here
 *
 * `acceptRide` refuses a driver who holds no PENDING offer on the ride (D-14).
 * Without offers, every racer gets 404, the race looks perfectly clean, and it
 * proves nothing at all. The offers are artificial — production offers at most
 * MATCH_MAX_DRIVERS_PER_RIDE drivers — but the point is to put maximum
 * contention on the Redis claim, which is exactly what §5.1 promises to hold.
 *
 * Development only. Refuses to run against NODE_ENV=production.
 *
 *   node dist/../scripts/load-fixtures.mjs        (after `pnpm build`)
 */

import { randomUUID } from 'node:crypto';

import { SystemClock } from '../dist/common/clock.js';
import { PgDatabase } from '../dist/db/pg-database.js';
import { TokenService } from '../dist/auth/token.service.js';

const DRIVERS = Number(process.env['LOAD_DRIVERS'] ?? 40);
const RIDERS = Number(process.env['LOAD_RIDERS'] ?? 20);

const SECRET =
  process.env['JWT_SECRET'] ?? 'load-test-secret-key-at-least-32-chars';

if (process.env['NODE_ENV'] === 'production') {
  process.stderr.write('Refusing to create load fixtures in production.\n');
  process.exit(1);
}

const connectionString =
  process.env['DATABASE_MIGRATION_URL'] ?? process.env['DATABASE_URL'];

if (!connectionString) {
  process.stderr.write('DATABASE_URL must be set.\n');
  process.exit(1);
}

/**
 * Deterministic ids, so re-running replaces rather than accumulates.
 *
 * `c` for drivers and `b` for riders because a UUID is hex - the obvious `d`
 * and `r` are not both valid, and Postgres rejects the whole insert.
 */
function idFor(kind, index) {
  const prefix = kind === 'driver' ? 'c' : 'b';
  return `00000000-0000-4000-8000-${prefix}${String(index).padStart(11, '0')}`;
}

const db = new PgDatabase({ connectionString, maxConnections: 10 });
const tokens = new TokenService(SECRET, new SystemClock(), 3600, 86_400);

const driverIds = Array.from({ length: DRIVERS }, (_, i) => idFor('driver', i));
const riderIds = Array.from({ length: RIDERS }, (_, i) => idFor('rider', i));

// Phone numbers stay inside the reserved test block. A load fixture is exactly
// where somebody's real mobile ends up committed.
//
// Four trailing digits, not three. Drivers and riders share this counter, and
// the three-digit form gave the pair only 1000 slots between them - past that
// it produced an eleven-digit number and every INSERT failed the E.164 CHECK
// with an error that named the constraint rather than the cause. The WebSocket
// load test needs 1000 drivers on its own.
const phone = (n) => `+964770001${String(n).padStart(4, '0')}`;

let n = 0;
for (const id of driverIds) {
  await db.query(
    `INSERT INTO users (id, role, phone_e164, display_name)
     VALUES ($1, 'DRIVER', $2, $3) ON CONFLICT (id) DO NOTHING`,
    [id, phone(n), `سائق حمل ${n}`],
  );
  await db.query(
    `INSERT INTO drivers (user_id, availability, vehicle_plate, vehicle_model, vehicle_color)
     VALUES ($1, 'ONLINE', $2, 'Corolla', 'أبيض')
     ON CONFLICT (user_id) DO UPDATE SET availability = 'ONLINE'`,
    [id, String(10_000 + n)],
  );
  n += 1;
}

for (const id of riderIds) {
  await db.query(
    `INSERT INTO users (id, role, phone_e164, display_name)
     VALUES ($1, 'RIDER', $2, $3) ON CONFLICT (id) DO NOTHING`,
    [id, phone(n), `راكب حمل ${n}`],
  );
  await db.query(`INSERT INTO riders (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
  n += 1;
}

// One ride, offered to every driver, for the claim race.
//
// OFFERED, not REQUESTED. The state machine only allows OFFERED -> ACCEPTED
// (CLAUDE.md 4), so a REQUESTED fixture makes every accept fail - and it fails
// as 409, which the load script counts as a normal "lost the race". The result
// is a race with a hundred tidy losses, no winner, and no information.
//
// A FRESH rider every run, not one of the pooled ones. `rides_one_active_per
// _rider_uq` allows a rider only one active ride, so re-running would collide
// with last run's ride - and the alternative, rewriting the old ride's status
// in SQL, would be bypassing RideStateMachine (CLAUDE.md 12.4) in order to set
// up a test of RideStateMachine.
const raceRiderId = randomUUID();
await db.query(
  `INSERT INTO users (id, role, phone_e164, display_name)
   VALUES ($1, 'RIDER', $2, 'راكب السباق')`,
  [raceRiderId, `+9647${String(Date.now()).slice(-9)}`],
);
await db.query(`INSERT INTO riders (user_id) VALUES ($1)`, [raceRiderId]);

const ride = await db.query(
  `INSERT INTO rides
     (rider_id, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
      estimated_fare_iqd, estimated_distance_m, estimated_duration_s)
   VALUES ($1, 'OFFERED', 33.3061, 44.4213, 33.2989, 44.4361, 5000, 1500, 300)
   RETURNING id`,
  [raceRiderId],
);
const rideId = ride.rows[0].id;

for (const id of driverIds) {
  await db.query(
    `INSERT INTO ride_offers (ride_id, driver_id, status, distance_m, expires_at)
     VALUES ($1, $2, 'PENDING', 500, now() + interval '1 hour')`,
    [rideId, id],
  );
}

const driverTokens = [];
for (const id of driverIds) {
  driverTokens.push((await tokens.issuePair(db, id, 'DRIVER')).accessToken);
}

const riderTokens = [];
for (const id of riderIds) {
  riderTokens.push((await tokens.issuePair(db, id, 'RIDER')).accessToken);
}

await db.close();

// Written to a file rather than only printed: the token list is far past what
// a Windows environment variable will hold on a command line.
const out = {
  raceRideId: rideId,
  driverTokens,
  riderTokens,
  drivers: DRIVERS,
  riders: RIDERS,
  generatedFor: randomUUID(),
};

process.stdout.write(JSON.stringify(out));
