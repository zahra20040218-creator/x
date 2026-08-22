import { beforeEach, describe, expect, it } from 'vitest';

import { FakeClock } from '../common/clock.js';
import { RideAlreadyClaimedError } from '../common/problem.js';
import { InMemoryRedis } from '../redis/in-memory-redis.js';
import { RedisKeys } from '../redis/redis.port.js';
import { RideClaimService } from './ride-claim.service.js';

const RIDE = '11111111-1111-4111-8111-111111111111';
const DRIVER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DRIVER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DRIVER_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const TTL_MS = 30_000;

describe('RideClaimService', () => {
  let clock: FakeClock;
  let redis: InMemoryRedis;
  let claims: RideClaimService;

  beforeEach(() => {
    clock = new FakeClock();
    redis = new InMemoryRedis(clock);
    claims = new RideClaimService(redis, TTL_MS);
  });

  describe('construction', () => {
    it('refuses a TTL that would leave a claim without expiry', () => {
      expect(() => new RideClaimService(redis, 0)).toThrow(/positive integer/);
      expect(() => new RideClaimService(redis, -1)).toThrow(/positive integer/);
      expect(() => new RideClaimService(redis, 1.5)).toThrow(/positive integer/);
    });
  });

  // -------------------------------------------------------------------------
  // The scenario from ACCEPTANCE_CHECKLIST.md check 4.
  // -------------------------------------------------------------------------

  describe('the concurrent case', () => {
    it('gives the ride to exactly one of two simultaneous drivers', async () => {
      const [a, b] = await Promise.all([
        claims.claim(RIDE, DRIVER_A),
        claims.claim(RIDE, DRIVER_B),
      ]);

      expect([a.acquired, b.acquired].filter(Boolean)).toHaveLength(1);
      const winner = a.acquired ? DRIVER_A : DRIVER_B;
      expect(await claims.currentHolder(RIDE)).toBe(winner);
    });

    it('gives the ride to exactly one of three simultaneous drivers', async () => {
      const results = await Promise.all([
        claims.claim(RIDE, DRIVER_A),
        claims.claim(RIDE, DRIVER_B),
        claims.claim(RIDE, DRIVER_C),
      ]);

      expect(results.filter((r) => r.acquired)).toHaveLength(1);
      // The two losers are told who actually has it, so the app can say
      // "no longer available" rather than a bare error.
      for (const loser of results.filter((r) => !r.acquired)) {
        expect(loser.heldBy).not.toBeNull();
      }
    });

    it('gives the ride to exactly one of fifty simultaneous drivers', async () => {
      const drivers = Array.from({ length: 50 }, (_, i) => `driver-${i}`);
      const results = await Promise.all(drivers.map((d) => claims.claim(RIDE, d)));

      const winners = results.filter((r) => r.acquired);
      expect(winners).toHaveLength(1);
      expect(new Set(results.map((r) => r.heldBy)).size).toBe(1);
    });

    it('holds under repeated rounds on distinct rides', async () => {
      for (let round = 0; round < 25; round++) {
        const rideId = `ride-${round}`;
        const results = await Promise.all([
          claims.claim(rideId, DRIVER_A),
          claims.claim(rideId, DRIVER_B),
          claims.claim(rideId, DRIVER_C),
        ]);
        expect(results.filter((r) => r.acquired)).toHaveLength(1);
      }
    });

    it('claims on different rides do not interfere', async () => {
      expect((await claims.claim('ride-1', DRIVER_A)).acquired).toBe(true);
      expect((await claims.claim('ride-2', DRIVER_B)).acquired).toBe(true);
      expect(await claims.currentHolder('ride-1')).toBe(DRIVER_A);
      expect(await claims.currentHolder('ride-2')).toBe(DRIVER_B);
    });
  });

  describe('sequential claims', () => {
    it('lets the first driver in and keeps the second out', async () => {
      expect((await claims.claim(RIDE, DRIVER_A)).acquired).toBe(true);

      const second = await claims.claim(RIDE, DRIVER_B);
      expect(second.acquired).toBe(false);
      expect(second.heldBy).toBe(DRIVER_A);
    });

    // A dropped response on a Baghdad mobile network is routine (CLAUDE.md
    // §5.2 reasoning). A retry from the driver who already won must not be
    // reported as losing the race.
    it('treats a retry by the current holder as success', async () => {
      await claims.claim(RIDE, DRIVER_A);

      const retry = await claims.claim(RIDE, DRIVER_A);
      expect(retry.acquired).toBe(true);
      expect(retry.heldBy).toBe(DRIVER_A);
    });
  });

  describe('expiry', () => {
    it('frees the ride once the TTL lapses', async () => {
      await claims.claim(RIDE, DRIVER_A);
      expect((await claims.claim(RIDE, DRIVER_B)).acquired).toBe(false);

      clock.advance(TTL_MS + 1);

      expect(await claims.currentHolder(RIDE)).toBeNull();
      expect((await claims.claim(RIDE, DRIVER_B)).acquired).toBe(true);
    });

    it('keeps the claim for the whole TTL and not a moment less', async () => {
      await claims.claim(RIDE, DRIVER_A);

      clock.advance(TTL_MS - 1);
      expect((await claims.claim(RIDE, DRIVER_B)).acquired).toBe(false);

      clock.advance(1);
      expect((await claims.claim(RIDE, DRIVER_B)).acquired).toBe(true);
    });

    it('reports the remaining time, and -2 once gone', async () => {
      expect(await claims.remainingMs(RIDE)).toBe(-2);

      await claims.claim(RIDE, DRIVER_A);
      expect(await claims.remainingMs(RIDE)).toBe(TTL_MS);

      clock.advance(10_000);
      expect(await claims.remainingMs(RIDE)).toBe(TTL_MS - 10_000);

      clock.advance(TTL_MS);
      expect(await claims.remainingMs(RIDE)).toBe(-2);
    });

    // A claim that never expires wedges the ride if the winner's process dies.
    it('always sets an expiry', async () => {
      await claims.claim(RIDE, DRIVER_A);
      expect(await redis.pttl(RedisKeys.rideClaim(RIDE))).toBeGreaterThan(0);
    });
  });

  describe('release', () => {
    it('lets the next driver in', async () => {
      await claims.claim(RIDE, DRIVER_A);
      expect(await claims.release(RIDE, DRIVER_A)).toBe(true);
      expect((await claims.claim(RIDE, DRIVER_B)).acquired).toBe(true);
    });

    it('refuses to release a claim held by someone else', async () => {
      await claims.claim(RIDE, DRIVER_A);
      expect(await claims.release(RIDE, DRIVER_B)).toBe(false);
      expect(await claims.currentHolder(RIDE)).toBe(DRIVER_A);
    });

    // The interleaving that makes compare-and-delete necessary: A expires, B
    // claims legitimately, and only THEN does A's late release arrive.
    it('does not delete a claim the previous holder no longer owns', async () => {
      await claims.claim(RIDE, DRIVER_A);
      clock.advance(TTL_MS + 1);
      await claims.claim(RIDE, DRIVER_B);

      expect(await claims.release(RIDE, DRIVER_A)).toBe(false);
      expect(await claims.currentHolder(RIDE)).toBe(DRIVER_B);
    });

    it('is false when there is nothing to release', async () => {
      expect(await claims.release(RIDE, DRIVER_A)).toBe(false);
    });
  });

  describe('claimOrThrow', () => {
    it('is silent for the winner and 409 for the loser', async () => {
      await expect(claims.claimOrThrow(RIDE, DRIVER_A)).resolves.toBeUndefined();

      await expect(claims.claimOrThrow(RIDE, DRIVER_B)).rejects.toThrow(RideAlreadyClaimedError);

      try {
        await claims.claimOrThrow(RIDE, DRIVER_C);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as RideAlreadyClaimedError).status).toBe(409);
        expect((error as RideAlreadyClaimedError).toBody().type).toMatch(/ride-already-claimed$/);
      }
    });
  });

  describe('withClaim', () => {
    it('runs the work and keeps the claim on success', async () => {
      const result = await claims.withClaim(RIDE, DRIVER_A, async () => 'assigned');

      expect(result).toBe('assigned');
      // Held deliberately: it blocks a duplicate accept from a retry until it
      // expires on its own.
      expect(await claims.currentHolder(RIDE)).toBe(DRIVER_A);
    });

    // Without this rollback a DB failure would leave the ride claimed but
    // unassigned for the full TTL - nobody can take it, and the rider waits.
    it('releases the claim when the work throws, so another driver can take the ride', async () => {
      await expect(
        claims.withClaim(RIDE, DRIVER_A, async () => {
          throw new Error('database write failed');
        }),
      ).rejects.toThrow('database write failed');

      expect(await claims.currentHolder(RIDE)).toBeNull();
      expect((await claims.claim(RIDE, DRIVER_B)).acquired).toBe(true);
    });

    it('does not run the work at all when the claim is lost', async () => {
      await claims.claim(RIDE, DRIVER_A);

      let ran = false;
      await expect(
        claims.withClaim(RIDE, DRIVER_B, async () => {
          ran = true;
          return 'nope';
        }),
      ).rejects.toThrow(RideAlreadyClaimedError);

      expect(ran).toBe(false);
      expect(await claims.currentHolder(RIDE)).toBe(DRIVER_A);
    });

    it('propagates the original error, not the rollback outcome', async () => {
      class DbError extends Error {}
      await expect(
        claims.withClaim(RIDE, DRIVER_A, async () => {
          throw new DbError('constraint violation');
        }),
      ).rejects.toBeInstanceOf(DbError);
    });

    it('still surfaces the original error if the rollback itself fails', async () => {
      const brokenRedis = new InMemoryRedis(clock);
      const broken = new RideClaimService(brokenRedis, TTL_MS);
      await broken.claim(RIDE, DRIVER_A);
      // Simulate Redis becoming unreachable after the claim was taken.
      await brokenRedis.close();

      await expect(
        broken.withClaim(RIDE, DRIVER_A, async () => {
          throw new Error('original failure');
        }),
      ).rejects.toThrow(/original failure|closed/);
    });

    it('serialises concurrent accepts so only one body runs', async () => {
      const ran: string[] = [];

      const attempts = [DRIVER_A, DRIVER_B, DRIVER_C].map((driver) =>
        claims
          .withClaim(RIDE, driver, async () => {
            ran.push(driver);
            return driver;
          })
          .catch(() => null),
      );

      const results = await Promise.all(attempts);

      expect(ran).toHaveLength(1);
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });
});
