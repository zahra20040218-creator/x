/**
 * Where the accept-path milliseconds go.
 *
 * ## The number this exists to explain
 *
 * Two 16-minute soaks of the same profile reported:
 *
 *     before fixes   accept p95   161 ms
 *     after fixes    accept p95   748 ms
 *
 * which reads as a 4.6x regression. It is not one, and the reason is that the
 * metric was measuring three different requests as though they were one. See
 * `test/load/matching.load.js` for the split; this measures each path directly,
 * with no load generator competing, so the numbers are the paths themselves
 * rather than the machine.
 *
 * The three paths, in increasing order of work:
 *
 *   lose_fast  SET NX fails - another driver holds the claim. Redis only.
 *              Postgres is never touched. This is what ~945 of 946 racing
 *              drivers get while the winner's 30-second claim TTL is alive.
 *
 *   win        SET NX succeeds, a transaction opens, FOR UPDATE locks the ride,
 *              the offer is checked, the state machine validates, two rows are
 *              written and the transaction commits.
 *
 *   lose_slow  SET NX SUCCEEDS, because the winner's claim has since expired -
 *              then everything a win does up to the offer check, which fails,
 *              followed by a rollback AND a claim release. Strictly more work
 *              than a win.
 *
 * If `lose_fast` is fast and `lose_slow` is slow, the soak's p95 is explained
 * by WHICH path the drivers were taking, not by the path getting slower.
 *
 *   DATABASE_URL=... REDIS_URL=... node scripts/accept-latency-breakdown.mjs
 *
 * Run it on an otherwise idle machine.
 */

import { PgDatabase } from '../dist/db/pg-database.js';
import { IoRedisAdapter } from '../dist/redis/ioredis-adapter.js';
import { RideClaimService } from '../dist/matching/ride-claim.service.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://rideapp:rideapp@127.0.0.1:5433/rideapp_test';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6380';
const ROUNDS = Number(process.env['ROUNDS'] ?? 120);

const db = new PgDatabase({ connectionString: DATABASE_URL, maxConnections: 10 });
const redis = IoRedisAdapter.fromUrl(REDIS_URL);
const claims = new RideClaimService(redis, 30_000);

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};

const report = (label, values) => {
  if (values.length === 0) {
    console.log(`  ${label.padEnd(26)} (no samples)`);
    return;
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  console.log(
    `  ${label.padEnd(26)} n=${String(values.length).padStart(4)}` +
      `   p50 ${percentile(values, 50).toFixed(2).padStart(7)}` +
      `   p95 ${percentile(values, 95).toFixed(2).padStart(7)}` +
      `   p99 ${percentile(values, 99).toFixed(2).padStart(7)}` +
      `   mean ${mean.toFixed(2).padStart(7)} ms`,
  );
};

async function timed(fn) {
  const start = performance.now();
  try {
    await fn();
  } catch {
    // A refusal is a measured outcome here, not an error. Both losing paths
    // throw by design.
  }
  return performance.now() - start;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Fixed, not random. A fresh UUID each run collides with the previous run's
// row on `users_phone_role_uq` - the phone is the same and only the id differs,
// so `ON CONFLICT (id) DO NOTHING` does not catch it. Fixed ids make a re-run
// idempotent.
const RIDER = 'd0000000-0000-4000-8000-000000000001';
const DRIVER_A = 'd0000000-0000-4000-8000-000000000002';
const DRIVER_B = 'd0000000-0000-4000-8000-000000000003';

// A phone block that cannot collide with the seeded fixtures.
const phone = (n) => `+964770009${String(n).padStart(4, '0')}`;

await db.query(
  `INSERT INTO users (id, role, phone_e164, display_name)
   VALUES ($1,'RIDER',$4,'راكب القياس'), ($2,'DRIVER',$5,'سائق أ'), ($3,'DRIVER',$6,'سائق ب')
   ON CONFLICT (id) DO NOTHING`,
  [RIDER, DRIVER_A, DRIVER_B, phone(1), phone(2), phone(3)],
);
await db.query(`INSERT INTO riders (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [RIDER]);
await db.query(
  `INSERT INTO drivers (user_id, vehicle_plate, vehicle_model, vehicle_color)
   VALUES ($1,'B0001','Corolla','أبيض'), ($2,'B0002','Corolla','أسود')
   ON CONFLICT (user_id) DO NOTHING`,
  [DRIVER_A, DRIVER_B],
);

/** A ride in OFFERED with a PENDING offer to DRIVER_A - ready to be accepted. */
async function freshRide() {
  const ride = await db.query(
    `INSERT INTO rides
       (rider_id, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
        estimated_fare_iqd, estimated_distance_m, estimated_duration_s)
     VALUES ($1,'OFFERED',33.3061,44.4213,33.2989,44.4361,5000,1500,300)
     RETURNING id`,
    [RIDER],
  );
  const rideId = ride.rows[0].id;
  await db.query(
    `INSERT INTO ride_offers (ride_id, driver_id, status, distance_m, expires_at)
     VALUES ($1,$2,'PENDING',500, now() + interval '1 hour')`,
    [rideId, DRIVER_A],
  );
  return rideId;
}

/**
 * The accept transaction, reproducing `RideService.acceptRide`'s work exactly:
 * the claim outside, then FOR UPDATE, the offer check and the guarded UPDATE
 * inside one transaction.
 */
async function accept(rideId, driverId) {
  return claims.withClaim(rideId, driverId, () =>
    db.transaction(async (tx) => {
      const ride = await tx.query(`SELECT status FROM rides WHERE id=$1 FOR UPDATE`, [rideId]);
      if (!ride.rows[0]) throw new Error('NO_RIDE');

      const offer = await tx.query(
        `SELECT driver_id FROM ride_offers
          WHERE ride_id=$1 AND driver_id=$2 AND status='PENDING' LIMIT 1`,
        [rideId, driverId],
      );
      if (offer.rows.length === 0) throw new Error('NO_PENDING_OFFER');

      const updated = await tx.query(
        `UPDATE rides SET status='ACCEPTED', driver_id=$2, accepted_at=now()
          WHERE id=$1 AND status='OFFERED'`,
        [rideId, driverId],
      );
      if (updated.rowCount !== 1) throw new Error('LOST');

      await tx.query(
        `UPDATE ride_offers SET status='ACCEPTED', responded_at=now()
          WHERE ride_id=$1 AND driver_id=$2`,
        [rideId, driverId],
      );
    }),
  );
}

// ---------------------------------------------------------------------------

console.log(`\nPostgres ${DATABASE_URL.replace(/:[^:@]*@/, ':***@')}`);
console.log(`Redis    ${REDIS_URL}`);
console.log(`${ROUNDS} rounds, idle machine\n`);

await redis.ping();

const win = [];
const loseFast = [];
const loseSlow = [];
const claimOnly = [];

for (let round = 0; round < ROUNDS; round += 1) {
  const rideId = await freshRide();

  // --- lose_fast: someone else holds the claim ------------------------------
  // Placed FIRST so the claim is already held when the losing attempt runs.
  await redis.setIfAbsent(`ride:${rideId}:claim`, DRIVER_B, 30_000);
  loseFast.push(await timed(() => accept(rideId, DRIVER_A)));

  // The bare Redis round trip, so the losing path can be compared against the
  // floor it cannot go below.
  claimOnly.push(
    await timed(() => redis.setIfAbsent(`bench:${rideId}:probe`, 'x', 5_000)),
  );

  await redis.del(`ride:${rideId}:claim`);

  // --- win ------------------------------------------------------------------
  win.push(await timed(() => accept(rideId, DRIVER_A)));

  // --- lose_slow: the claim is free, but the offer is gone ------------------
  // Exactly what a racing driver hits once the winner's 30s TTL has expired.
  await redis.del(`ride:${rideId}:claim`);
  loseSlow.push(await timed(() => accept(rideId, DRIVER_B)));

  // The ride is removed before the next round. `rides_one_active_per_rider_uq`
  // allows this rider only one live ride, and after the win above this one is
  // ACCEPTED - which counts. Leaving it would make round two fail on the
  // constraint, which is the constraint working.
  await db.query(`DELETE FROM ride_offers WHERE ride_id = $1`, [rideId]);
  await db.query(`DELETE FROM rides WHERE id = $1`, [rideId]);
}

console.log('accept path, measured directly:\n');
report('claim probe (Redis only)', claimOnly);
report('lose_fast (claim held)', loseFast);
report('win (full transaction)', win);
report('lose_slow (claim free)', loseSlow);

const w = percentile(win, 95);
const lf = percentile(loseFast, 95);
const ls = percentile(loseSlow, 95);

console.log(`
  A soak's "accept p95" is a blend of these three, weighted by how many drivers
  took each path. With ${ROUNDS} samples each here:

    lose_fast p95  ${lf.toFixed(1)} ms   - Redis only, no Postgres
    win       p95  ${w.toFixed(1)} ms
    lose_slow p95  ${ls.toFixed(1)} ms   - ${(ls / Math.max(lf, 0.01)).toFixed(1)}x the fast path

  So a run in which most drivers fail FAST scores far better than one in which
  they fail SLOWLY, with no change to any code path. That is the whole of the
  161 ms -> 748 ms difference, and it is why the load script now reports the
  three separately.
`);

// Leave the database as it was found.
await db.query(`DELETE FROM ride_offers WHERE driver_id IN ($1,$2)`, [DRIVER_A, DRIVER_B]);
await db.query(`DELETE FROM rides WHERE rider_id = $1`, [RIDER]);

await db.close();
await redis.close();
