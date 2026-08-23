import { Reflector } from '@nestjs/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeClock } from '../common/clock.js';
import type { RedisPort } from '../redis/redis.port.js';
import {
  DEFAULT_RATE_LIMIT,
  LocalWindowLimiter,
  NoRateLimit,
  RateLimit,
  RateLimitExceededError,
  RateLimitGuard,
  UNAVAILABLE_POLICY,
  localLimitFor,
  type RateLimitRule,
} from './rate-limit.js';

/**
 * Rate limiting under Redis failure — Phase 5.
 *
 * The property under test is NOT "the limiter counts". It is: **a
 * security-critical endpoint must not become unlimited because Redis went
 * away**, while an operational endpoint must not start failing for the same
 * reason. Those two requirements pull in opposite directions, which is why the
 * policy is per-tier and why each tier is asserted separately here.
 */

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type RedisMode = 'up' | 'refusing' | 'hanging';

/**
 * Only `increment` is real; every other member throws if touched, so a test
 * that accidentally depends on some other Redis call fails loudly instead of
 * silently passing against an empty stub.
 */
class ControllableRedis {
  mode: RedisMode = 'up';
  calls = 0;
  private readonly counts = new Map<string, number>();

  async increment(key: string, _ttlMs: number): Promise<number> {
    this.calls++;
    if (this.mode === 'refusing') throw new Error('ECONNREFUSED');
    if (this.mode === 'hanging') {
      // Never settles. This is the ioredis-offline-queue shape: the command is
      // accepted and simply never answered.
      return new Promise<number>(() => {});
    }
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }

  asPort(): RedisPort {
    return this as unknown as RedisPort;
  }
}

interface LogLine {
  event?: string;
  decision?: string;
  tier?: string;
  localLimit?: number;
}

class RecordingLogger {
  readonly lines: LogLine[] = [];

  private capture = (payload: unknown): void => {
    this.lines.push((payload ?? {}) as LogLine);
  };

  warn = this.capture;
  info = this.capture;
  error = this.capture;
  debug = this.capture;
  fatal = this.capture;
  trace = this.capture;

  eventsNamed(event: string): LogLine[] {
    return this.lines.filter((line) => line.event === event);
  }
}

/** A handler carrying the decorator metadata the guard reads. */
function handlerWith(rule?: RateLimitRule, exempt = false): () => void {
  const handler = (): void => {};
  if (rule) RateLimit(rule)({}, 'h', { value: handler });
  if (exempt) NoRateLimit()({}, 'h', { value: handler });
  return handler;
}

function contextFor(handler: () => void, ip = '10.0.0.1', userId?: string): never {
  const request = {
    method: 'POST',
    path: '/v1/test',
    route: { path: '/v1/test' },
    ip,
    socket: { remoteAddress: ip },
    ...(userId === undefined ? {} : { user: { id: userId } }),
  };

  return {
    getHandler: () => handler,
    getClass: () => class Anon {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

function guardFor(
  redis: ControllableRedis,
  clock: FakeClock,
  logger: RecordingLogger,
  localDivisor = 4,
  redisTimeoutMs = 20,
): RateLimitGuard {
  return new RateLimitGuard(
    redis.asPort(),
    clock,
    new Reflector(),
    logger as never,
    { localDivisor, redisTimeoutMs, localMaxKeys: 5 },
  );
}

/** Drive the guard n times, returning how many were permitted. */
async function hitTimes(
  guard: RateLimitGuard,
  handler: () => void,
  n: number,
  ip = '10.0.0.1',
): Promise<{ allowed: number; rejected: number }> {
  let allowed = 0;
  let rejected = 0;
  for (let i = 0; i < n; i++) {
    try {
      await guard.canActivate(contextFor(handler, ip));
      allowed++;
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitExceededError);
      rejected++;
    }
  }
  return { allowed, rejected };
}

const CRITICAL: RateLimitRule = { limit: 10, windowSeconds: 60, by: 'ip', tier: 'CRITICAL' };
const OPERATIONAL: RateLimitRule = {
  limit: 120,
  windowSeconds: 60,
  by: 'user',
  tier: 'OPERATIONAL',
};

// ---------------------------------------------------------------------------

describe('tier policy table', () => {
  it('degrades the tiers that matter and only fails open on operational ones', () => {
    expect(UNAVAILABLE_POLICY.CRITICAL).toBe('degrade');
    expect(UNAVAILABLE_POLICY.STANDARD).toBe('degrade');
    expect(UNAVAILABLE_POLICY.OPERATIONAL).toBe('allow');
  });

  it('defaults an unclassified route to STANDARD, not OPERATIONAL', () => {
    // An undeclared route is one nobody has classified. Defaulting it to the
    // fail-open tier would mean "forgot to think about it" silently produces
    // the weakest behaviour.
    expect(DEFAULT_RATE_LIMIT.tier).toBe('STANDARD');
    expect(UNAVAILABLE_POLICY[DEFAULT_RATE_LIMIT.tier]).toBe('degrade');
  });
});

describe('localLimitFor', () => {
  it('divides the Redis limit by the instance count', () => {
    expect(localLimitFor({ ...CRITICAL, limit: 100 }, 4)).toBe(25);
  });

  it('never returns zero, which would lock everyone out during an outage', () => {
    expect(localLimitFor({ ...CRITICAL, limit: 1 }, 64)).toBe(1);
    expect(localLimitFor({ ...CRITICAL, limit: 3 }, 4)).toBe(1);
  });

  it('rounds up, so the fallback is never stricter than intended by rounding', () => {
    expect(localLimitFor({ ...CRITICAL, limit: 10 }, 4)).toBe(3);
  });
});

describe('LocalWindowLimiter', () => {
  it('counts within a window', () => {
    const limiter = new LocalWindowLimiter(100);
    expect(limiter.hit('a', 1)).toBe(1);
    expect(limiter.hit('a', 1)).toBe(2);
    expect(limiter.hit('b', 1)).toBe(1);
  });

  it('drops everything when the window rolls over', () => {
    const limiter = new LocalWindowLimiter(100);
    limiter.hit('a', 1);
    limiter.hit('a', 1);
    expect(limiter.size).toBe(1);

    expect(limiter.hit('a', 2)).toBe(1);
    expect(limiter.size).toBe(1);
  });

  it('bounds memory within a window and reports saturation', () => {
    const limiter = new LocalWindowLimiter(3);
    expect(limiter.hit('a', 1)).toBe(1);
    expect(limiter.hit('b', 1)).toBe(1);
    expect(limiter.hit('c', 1)).toBe(1);

    // A fourth distinct identity cannot be accounted for.
    expect(limiter.hit('d', 1)).toBeNull();
    expect(limiter.size).toBe(3);

    // A key already being tracked still counts - saturation must not reset
    // the counters of identities we are already limiting.
    expect(limiter.hit('a', 1)).toBe(2);
  });

  it('recovers capacity on the next window', () => {
    const limiter = new LocalWindowLimiter(2);
    limiter.hit('a', 1);
    limiter.hit('b', 1);
    expect(limiter.hit('c', 1)).toBeNull();

    expect(limiter.hit('c', 2)).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('RateLimitGuard — Redis AVAILABLE', () => {
  let redis: ControllableRedis;
  let clock: FakeClock;
  let logger: RecordingLogger;
  let guard: RateLimitGuard;

  beforeEach(() => {
    redis = new ControllableRedis();
    clock = new FakeClock();
    logger = new RecordingLogger();
    guard = guardFor(redis, clock, logger);
  });

  it('permits up to the limit and rejects beyond it', async () => {
    const handler = handlerWith(CRITICAL);
    const { allowed, rejected } = await hitTimes(guard, handler, 12);

    expect(allowed).toBe(10);
    expect(rejected).toBe(2);
  });

  it('does not consult the in-process fallback at all', async () => {
    const handler = handlerWith(CRITICAL);
    await hitTimes(guard, handler, 12);

    expect(logger.eventsNamed('ratelimit.unavailable')).toHaveLength(0);
    expect(logger.eventsNamed('ratelimit.exceeded')).toHaveLength(2);
  });

  it('exempts a route marked @NoRateLimit even past the limit', async () => {
    const handler = handlerWith(CRITICAL, true);
    const { allowed, rejected } = await hitTimes(guard, handler, 50);

    expect(allowed).toBe(50);
    expect(rejected).toBe(0);
    // Exempt means it never even asks Redis - a health probe must not depend
    // on Redis being up.
    expect(redis.calls).toBe(0);
  });
});

describe('RateLimitGuard — Redis UNAVAILABLE', () => {
  let redis: ControllableRedis;
  let clock: FakeClock;
  let logger: RecordingLogger;
  let guard: RateLimitGuard;

  beforeEach(() => {
    redis = new ControllableRedis();
    clock = new FakeClock();
    logger = new RecordingLogger();
    guard = guardFor(redis, clock, logger);
    redis.mode = 'refusing';
  });

  // THE point of this phase.
  it('a CRITICAL endpoint does NOT become unlimited', async () => {
    const handler = handlerWith(CRITICAL);
    const { allowed, rejected } = await hitTimes(guard, handler, 30);

    // ceil(10 / 4) = 3 per instance.
    expect(allowed).toBe(3);
    expect(rejected).toBe(27);
  });

  it('an OPERATIONAL endpoint keeps working, because blocking it breaks a ride', async () => {
    const handler = handlerWith(OPERATIONAL);
    const { allowed, rejected } = await hitTimes(guard, handler, 500);

    expect(allowed).toBe(500);
    expect(rejected).toBe(0);
  });

  it('records the degraded decision so an outage is visible in logs', async () => {
    const handler = handlerWith(CRITICAL);
    await hitTimes(guard, handler, 5);

    const events = logger.eventsNamed('ratelimit.unavailable');
    expect(events).toHaveLength(5);
    expect(events.map((e) => e.decision)).toEqual([
      'degraded',
      'degraded',
      'degraded',
      'rejected',
      'rejected',
    ]);
    expect(events[0]?.localLimit).toBe(3);
  });

  it('keys the fallback separately per identity', async () => {
    const handler = handlerWith(CRITICAL);

    const a = await hitTimes(guard, handler, 3, '10.0.0.1');
    const b = await hitTimes(guard, handler, 3, '10.0.0.2');

    expect(a.allowed).toBe(3);
    expect(b.allowed).toBe(3);
  });

  it('refuses rather than waves through once the fallback table saturates', async () => {
    const handler = handlerWith(CRITICAL);

    // localMaxKeys is 5 in these tests.
    for (let i = 0; i < 5; i++) {
      await hitTimes(guard, handler, 1, `10.0.1.${i}`);
    }

    const overflow = await hitTimes(guard, handler, 1, '10.0.9.9');
    expect(overflow.rejected).toBe(1);
    expect(logger.eventsNamed('ratelimit.local_saturated')).toHaveLength(1);
  });

  it('gives the fallback a fresh budget when the window rolls over', async () => {
    const handler = handlerWith(CRITICAL);
    expect((await hitTimes(guard, handler, 5)).allowed).toBe(3);

    clock.advance(60_000);
    expect((await hitTimes(guard, handler, 5)).allowed).toBe(3);
  });

  it('surfaces a limiter fault as 429 or success, never as a 500', async () => {
    const handler = handlerWith(CRITICAL);
    for (let i = 0; i < 10; i++) {
      await guard.canActivate(contextFor(handler)).catch((error: unknown) => {
        expect(error).toBeInstanceOf(RateLimitExceededError);
      });
    }
  });
});

describe('RateLimitGuard — Redis HANGING', () => {
  it('does not wait on a Redis that never answers', async () => {
    const redis = new ControllableRedis();
    const logger = new RecordingLogger();
    const guard = guardFor(redis, new FakeClock(), logger, 4, 20);
    redis.mode = 'hanging';

    const handler = handlerWith(OPERATIONAL);

    const startedAt = process.hrtime.bigint();
    await guard.canActivate(contextFor(handler));
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    // Without the timeout this call would never return at all. The assertion
    // is generous because CI machines are slow; the property is "bounded",
    // not "fast".
    expect(elapsedMs).toBeLessThan(2_000);
    expect(logger.eventsNamed('ratelimit.unavailable')).toHaveLength(1);
  });

  it('still applies the tier policy to a hung Redis, not just a refused one', async () => {
    const redis = new ControllableRedis();
    const logger = new RecordingLogger();
    const guard = guardFor(redis, new FakeClock(), logger, 4, 20);
    redis.mode = 'hanging';

    const handler = handlerWith(CRITICAL);
    const { allowed, rejected } = await hitTimes(guard, handler, 6);

    expect(allowed).toBe(3);
    expect(rejected).toBe(3);
  });
});

describe('RateLimitGuard — Redis RECONNECTING', () => {
  it('returns to Redis as soon as it answers again', async () => {
    const redis = new ControllableRedis();
    const clock = new FakeClock();
    const logger = new RecordingLogger();
    const guard = guardFor(redis, clock, logger);
    const handler = handlerWith(CRITICAL);

    // Outage: the fallback budget is spent.
    redis.mode = 'refusing';
    expect((await hitTimes(guard, handler, 5)).allowed).toBe(3);

    // Redis comes back inside the SAME window.
    redis.mode = 'up';
    const recovered = await hitTimes(guard, handler, 10);

    // Redis has its own count, which the outage never incremented, so the
    // caller gets the full Redis budget back. The fallback counters are simply
    // ignored - they are not merged into Redis, because inventing counts for
    // requests Redis never saw would be worse than undercounting an outage.
    expect(recovered.allowed).toBe(10);
    expect(logger.eventsNamed('ratelimit.unavailable')).toHaveLength(5);
  });

  it('flaps cleanly between Redis and the fallback', async () => {
    const redis = new ControllableRedis();
    const logger = new RecordingLogger();
    const guard = guardFor(redis, new FakeClock(), logger);
    const handler = handlerWith(CRITICAL);

    for (const mode of ['up', 'refusing', 'up', 'refusing', 'up'] as const) {
      redis.mode = mode;
      await hitTimes(guard, handler, 1);
    }

    // Three Redis hits and two fallback hits; nothing threw unexpectedly.
    expect(logger.eventsNamed('ratelimit.unavailable')).toHaveLength(2);
  });
});
