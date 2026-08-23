import { describe, expect, it } from 'vitest';

import { FakeClock } from '../../src/common/clock.js';
import { InMemoryRedis } from '../../src/redis/in-memory-redis.js';
import { FakeDatabase } from '../fakes/fake-database.js';
import {
  RealInfraUnavailableError,
  assertRealDatabase,
  assertRealRedis,
  isRealInfraRequested,
  realDatabaseUrl,
  realRedisUrl,
} from '../support/real-infra.js';

/**
 * The gate on the real-infrastructure harness.
 *
 * These assertions run **whether or not** real infrastructure is present, and
 * that is the point. The thing being tested is not PostgreSQL; it is the
 * harness's refusal to pretend.
 *
 * The audit finding this protects against (D-2 / D-15) is not "the fakes are
 * imperfect" — it is "someone will eventually report a green run as proof that
 * the concurrency guarantees hold against real services, when the run silently
 * used the fakes". A harness that skips quietly, or falls back quietly, makes
 * that mistake inevitable. So: it throws, and here is the proof that it throws.
 */
describe('real-infrastructure harness', () => {
  describe('fails closed', () => {
    it('refuses to invent a database URL', () => {
      const saved = process.env['TEST_DATABASE_URL'];
      delete process.env['TEST_DATABASE_URL'];
      try {
        expect(() => realDatabaseUrl()).toThrow(RealInfraUnavailableError);
        // The message has to be actionable at 2am, not just correct.
        expect(() => realDatabaseUrl()).toThrow(/docker compose/);
      } finally {
        if (saved !== undefined) process.env['TEST_DATABASE_URL'] = saved;
      }
    });

    it('refuses to invent a Redis URL', () => {
      const saved = process.env['TEST_REDIS_URL'];
      delete process.env['TEST_REDIS_URL'];
      try {
        expect(() => realRedisUrl()).toThrow(RealInfraUnavailableError);
      } finally {
        if (saved !== undefined) process.env['TEST_REDIS_URL'] = saved;
      }
    });
  });

  describe('cannot be fooled by a fake', () => {
    it('rejects FakeDatabase where a real one is required', () => {
      expect(() => assertRealDatabase(new FakeDatabase())).toThrow(/NOT against real/);
      expect(() => assertRealDatabase(new FakeDatabase())).toThrow(/FakeDatabase/);
    });

    it('rejects InMemoryRedis where a real one is required', () => {
      expect(() => assertRealRedis(new InMemoryRedis(new FakeClock()))).toThrow(
        /NOT against real/,
      );
    });
  });

  /**
   * Reports the truth about THIS run, in the run's own output.
   *
   * Deliberately not a `skip`: a skipped test is invisible in a summary line,
   * and "0 skipped" was previously being cited as evidence that everything had
   * run. This always executes and always says which mode it was in.
   */
  it('states plainly which services this run touched', () => {
    const real = isRealInfraRequested();
    const hasDb = Boolean(process.env['TEST_DATABASE_URL']);
    const hasRedis = Boolean(process.env['TEST_REDIS_URL']);

    // Partial is allowed and NAMED, never averaged into "real infrastructure".
    // The two services are genuinely separable here: PostgreSQL runs from a
    // portable build with no administrator rights, while Redis has no official
    // Windows build at all. A run may honestly have one and not the other, and
    // saying which is the whole job of this test.
    const line = `postgres=${hasDb ? 'REAL' : 'FAKE'} redis=${hasRedis ? 'REAL' : 'FAKE'}`;

    // eslint-disable-next-line no-console -- the whole point of this test
    console.warn(
      `\n[REAL_INFRA=${real ? 'on' : 'off'}] ${line}\n` +
        (hasDb ? '' : '  D-15 (Postgres transaction isolation) remains OPEN.\n') +
        (hasRedis ? '' : '  D-2 (real Redis atomic claim) remains OPEN.\n') +
        '  Report only the services marked REAL as verified.\n',
    );

    // Demanding real infrastructure and configuring none of it is a mistake,
    // not a mode.
    expect(real ? hasDb || hasRedis : true).toBe(true);
  });
});
