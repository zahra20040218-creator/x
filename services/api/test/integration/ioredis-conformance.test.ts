import { Redis } from 'ioredis';
import { describe, it } from 'vitest';

import { IoRedisAdapter } from '../../src/redis/ioredis-adapter.js';
import { runRedisConformance } from '../../src/redis/redis.conformance.js';

/**
 * The other half of the conformance argument.
 *
 * `src/redis/in-memory-redis.test.ts` runs this same suite against the fake on
 * every `pnpm test`. This file runs the IDENTICAL assertions against a real
 * Redis. If the two ever disagree, every unit test that relies on the fake
 * stops being evidence about production - so the disagreement has to fail a
 * build, which is what this file makes happen.
 *
 * It SKIPS rather than fails when TEST_REDIS_URL is unset, so that `make test`
 * stays green on a laptop with no Docker. CI sets the variable, which makes it
 * a hard gate there.
 *
 * If you are reading this because you are deciding whether to trust the unit
 * tests: check that CI actually sets TEST_REDIS_URL. If it does not, the fake
 * is unverified and the concurrency guarantees are only as good as the fake.
 */

const REDIS_URL = process.env['TEST_REDIS_URL'];

if (!REDIS_URL) {
  describe.skip('RedisPort conformance: real Redis (TEST_REDIS_URL not set)', () => {
    it('skipped', () => undefined);
  });
} else {
  runRedisConformance('IoRedisAdapter (real Redis)', async () => {
    const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });

    // A dedicated database, flushed per test, so a run cannot see another
    // test's keys or a developer's local data.
    await client.select(15);
    await client.flushdb();

    const adapter = new IoRedisAdapter(client);

    return {
      redis: adapter,
      // The real thing has no injectable clock, so "advance" means wait.
      advance: async (ms: number) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
      cleanup: async () => {
        await client.flushdb().catch(() => undefined);
        await adapter.close();
      },
    };
  });
}
