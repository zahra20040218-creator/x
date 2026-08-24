import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RideAlreadyClaimedError } from '../../src/common/problem.js';
import { RideClaimService } from '../../src/matching/ride-claim.service.js';
import { assertRealRedis, createRealRedis, isRealInfraRequested, type RealRedis } from '../support/real-infra.js';

/**
 * CLAUDE.md §5.1 against a real Redis server.
 *
 * This is the test D-2 existed for. Every other proof that two drivers cannot
 * accept the same ride ran against my own in-memory fake — a fake that had
 * already diverged from real Redis once in this project, when `del` failed to
 * remove hash keys and left an offline driver visible to matching.
 *
 * The conformance suite proves the fake and the real server agree on each
 * primitive. This proves the thing the primitives exist for: that
 * `SET ride:{id}:claim {driverId} NX PX 30000` actually serialises a stampede
 * of drivers on a server that is not mine.
 */

const RUN = isRealInfraRequested();
const describeReal = RUN ? describe : describe.skip;

describeReal('atomic ride claim on real Redis', () => {
  let redis: RealRedis;
  let claims: RideClaimService;

  beforeAll(() => {
    redis = createRealRedis();
    assertRealRedis(redis.adapter);
    claims = new RideClaimService(redis.adapter, 30_000);
  });

  afterAll(async () => {
    await redis.close();
  });

  beforeEach(async () => {
    await redis.flush();
  });

  it('gives the ride to exactly one of twenty simultaneous drivers', async () => {
    const rideId = 'ride-real-1';
    const drivers = Array.from({ length: 20 }, (_, i) => `driver-${i}`);

    const results = await Promise.allSettled(
      drivers.map((driverId) =>
        claims.withClaim(rideId, driverId, () => Promise.resolve(driverId)),
      ),
    );

    const winners = results.filter((r) => r.status === 'fulfilled');
    expect(winners).toHaveLength(1);

    for (const loser of results.filter((r) => r.status === 'rejected')) {
      expect(loser.reason).toBeInstanceOf(RideAlreadyClaimedError);
    }
  });

  /**
   * Repeated, because a race that passes once has not been shown to be safe —
   * it has been shown to be lucky. Twenty rounds of fifty.
   *
   * The work HOLDS the claim while the other drivers are still arriving. That
   * is not padding: `withClaim` releases as soon as the work returns, so with
   * instantaneous work the winner releases before the stragglers even attempt,
   * and a second driver then acquires it perfectly legitimately.
   *
   * An earlier version of this test used `Promise.resolve()` and saw two
   * winners on real Redis. That looked like the P0 this file exists for, and
   * it was not — it was the test asserting a promise the claim never made.
   * The claim guarantees mutual exclusion DURING the critical section; in
   * production that section is a database transaction, which takes time.
   */
  it('never lets two drivers into the critical section at once', async () => {
    for (let round = 0; round < 20; round++) {
      const rideId = `ride-real-round-${round}`;
      const drivers = Array.from({ length: 50 }, (_, i) => `driver-${i}`);

      let inside = 0;
      let maxInside = 0;

      const results = await Promise.allSettled(
        drivers.map((driverId) =>
          claims.withClaim(rideId, driverId, async () => {
            inside += 1;
            maxInside = Math.max(maxInside, inside);
            // Stand in for the transaction the real caller runs here.
            await new Promise((resolve) => setTimeout(resolve, 40));
            inside -= 1;
            return driverId;
          }),
        ),
      );

      // The invariant that matters: never two at once.
      expect(maxInside).toBe(1);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    }
  });

  it('releases the claim when the work throws, so the next driver can take it', async () => {
    const rideId = 'ride-real-2';

    await expect(
      claims.withClaim(rideId, 'driver-a', () => Promise.reject(new Error('db died'))),
    ).rejects.toThrow('db died');

    // Not merely absent from Redis - actually usable by someone else.
    expect(await claims.currentHolder(rideId)).toBeNull();
    await expect(
      claims.withClaim(rideId, 'driver-b', () => Promise.resolve('ok')),
    ).resolves.toBe('ok');
  });

  it('does not let a different driver release a claim they do not hold', async () => {
    const rideId = 'ride-real-3';
    await claims.withClaim(rideId, 'driver-a', async () => {
      // Inside the critical section: someone else tries to steal the lock.
      expect(await claims.release(rideId, 'driver-b')).toBe(false);
      expect(await claims.currentHolder(rideId)).toBe('driver-a');
    });
  });

  it('holds the claim for its TTL rather than expiring immediately', async () => {
    const rideId = 'ride-real-4';
    const shortLived = new RideClaimService(redis.adapter, 30_000);

    await shortLived.withClaim(rideId, 'driver-a', async () => {
      // A second attempt during the critical section must fail, which is the
      // entire point - PX without NX would silently overwrite.
      await expect(
        shortLived.withClaim(rideId, 'driver-b', () => Promise.resolve('stolen')),
      ).rejects.toBeInstanceOf(RideAlreadyClaimedError);
    });
  });
});
