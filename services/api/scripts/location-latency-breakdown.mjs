/**
 * Where the location-ingest milliseconds actually go.
 *
 * `LOAD_TESTING.md` records location ingest at p95 270-324 ms against a target
 * of under 200 ms, and leaves the cause open. Guessing at it is how you end up
 * optimising the wrong thing, so this times each stage of `recordBatch`
 * separately against the real Redis rather than reasoning about the code.
 *
 * It deliberately does NOT go through HTTP. The k6 figure includes the network,
 * the JSON body, Zod validation, the auth guard and the rate limiter, and any
 * of those could be the cost. Timing the service directly says how much of the
 * budget is Redis, and the difference is everything else.
 *
 *   DATABASE_URL=... REDIS_URL=... node scripts/location-latency-breakdown.mjs
 *
 * Run it on an otherwise idle machine. A soak running in the background makes
 * every number here meaningless.
 */

import { IoRedisAdapter } from '../dist/redis/ioredis-adapter.js';
import { RedisKeys } from '../dist/redis/redis-keys.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6380';
const ROUNDS = Number(process.env['ROUNDS'] ?? 200);
const BATCH = Number(process.env['BATCH'] ?? 5);

const redis = IoRedisAdapter.fromUrl(REDIS_URL);

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

const report = (label, values) => {
  const total = values.reduce((sum, v) => sum + v, 0);
  console.log(
    `  ${label.padEnd(34)} p50 ${percentile(values, 50).toFixed(2).padStart(7)} ms` +
      `   p95 ${percentile(values, 95).toFixed(2).padStart(7)} ms` +
      `   p99 ${percentile(values, 99).toFixed(2).padStart(7)} ms` +
      `   mean ${(total / values.length).toFixed(2).padStart(7)} ms`,
  );
};

/** One timed call. `performance.now()` is sub-millisecond; Date.now() is not. */
async function timed(fn) {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

const driverId = 'bench-driver-0000-0000-000000000000';
const position = { lat: 33.3061, lng: 44.4213, recordedAt: new Date() };

const samples = Array.from({ length: BATCH }, (_, i) => ({
  driverId,
  lat: 33.3061 + i * 0.0001,
  lng: 44.4213,
  accuracyM: 12,
  headingDeg: 90,
  speedMps: 8,
  recordedAt: new Date(Date.now() + i * 1000).toISOString(),
}));

console.log(`\nRedis ${REDIS_URL}   ${ROUNDS} rounds   batch of ${BATCH}\n`);

// Warm the connection so the first round's TCP setup is not counted as latency.
await redis.ping();

const stages = {
  'ping (one round trip, baseline)': [],
  [`rPush x${BATCH} (sequential, as shipped)`]: [],
  [`rPush x${BATCH} (one varargs call)`]: []
    ,
  'geoAdd': [],
  'zAdd': [],
  'hSet x6 (sequential, as shipped)': [],
};

for (let round = 0; round < ROUNDS; round += 1) {
  const key = RedisKeys.driverLocation(driverId);

  stages['ping (one round trip, baseline)'].push(await timed(() => redis.ping()));

  stages[`rPush x${BATCH} (sequential, as shipped)`].push(
    await timed(async () => {
      for (const sample of samples) {
        await redis.rPush(RedisKeys.locationFlushBuffer, JSON.stringify(sample));
      }
    }),
  );

  stages[`rPush x${BATCH} (one varargs call)`].push(
    await timed(() =>
      redis.rPush(RedisKeys.locationFlushBuffer, ...samples.map((s) => JSON.stringify(s))),
    ),
  );

  stages['geoAdd'].push(
    await timed(() => redis.geoAdd(RedisKeys.driversOnline, driverId, position)),
  );

  stages['zAdd'].push(
    await timed(() => redis.zAdd(RedisKeys.driversHeartbeat, driverId, Date.now())),
  );

  stages['hSet x6 (sequential, as shipped)'].push(
    await timed(async () => {
      await redis.hSet(key, 'lat', String(position.lat));
      await redis.hSet(key, 'lng', String(position.lng));
      await redis.hSet(key, 'recordedAt', position.recordedAt.toISOString());
      await redis.hSet(key, 'accuracyM', '12');
      await redis.hSet(key, 'headingDeg', '90');
      await redis.hSet(key, 'speedMps', '8');
    }),
  );

  // Keep the buffer from growing without bound across rounds.
  await redis.lPopCount(RedisKeys.locationFlushBuffer, BATCH * 2);
}

for (const [label, values] of Object.entries(stages)) report(label, values);

const shipped =
  percentile(stages[`rPush x${BATCH} (sequential, as shipped)`], 95) +
  percentile(stages['geoAdd'], 95) +
  percentile(stages['zAdd'], 95) +
  percentile(stages['hSet x6 (sequential, as shipped)'], 95);

const collapsed =
  percentile(stages[`rPush x${BATCH} (one varargs call)`], 95) +
  percentile(stages['geoAdd'], 95) +
  percentile(stages['zAdd'], 95) +
  percentile(stages['ping (one round trip, baseline)'], 95);

console.log(
  `\n  Redis time in recordBatch, as shipped   p95 ~${shipped.toFixed(2)} ms` +
    ` (${BATCH + 8} sequential round trips)`,
);
console.log(
  `  With the two loops collapsed            p95 ~${collapsed.toFixed(2)} ms` +
    ` (4 round trips)`,
);
console.log(
  `\n  Anything the HTTP p95 has above this figure is NOT Redis - it is the\n` +
    `  network, the body parse, validation, the guard or the rate limiter.\n`,
);

await redis.close();
