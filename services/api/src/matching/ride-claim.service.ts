import type { Logger } from '../common/logger.js';
import { RideAlreadyClaimedError } from '../common/problem.js';
import { RedisKeys, type RedisPort } from '../redis/redis.port.js';

/**
 * CLAUDE.md §5.1 - "Two drivers must never accept the same ride."
 *
 * The whole mechanism is one Redis command:
 *
 *     SET ride:{rideId}:claim {driverId} NX PX 30000
 *
 * Redis executes commands one at a time, so of N concurrent callers exactly one
 * observes the key as absent and creates it. There is no window between the
 * check and the write for a second caller to enter, because there is no check -
 * the atomicity is the command's, not ours.
 *
 * CLAUDE.md §5.1 also names the two implementations that are forbidden, and it
 * is worth recording why, because both look correct:
 *
 *   - **DB read-then-write.** `SELECT driver_id ... ; UPDATE ... ` has a gap
 *     between the two statements. Two transactions at READ COMMITTED both read
 *     NULL and both update. It fails only under load - which is to say, only in
 *     production, and only during the busiest hour.
 *
 *   - **Application-level mutex.** A mutex is per-process. Run two API
 *     instances - which a 500-user target requires - and there are two mutexes
 *     guarding nothing.
 *
 * The TTL matters as much as the NX. A claim without expiry wedges the ride
 * permanently if the winner's process dies between claiming and committing; the
 * rider then waits forever for a driver who is not coming.
 */

export interface ClaimResult {
  acquired: boolean;
  /** Who currently holds it. Present when `acquired` is false and it is still held. */
  heldBy: string | null;
}

export class RideClaimService {
  constructor(
    private readonly redis: RedisPort,
    private readonly claimTtlMs: number,
    private readonly logger?: Logger,
  ) {
    if (!Number.isInteger(claimTtlMs) || claimTtlMs <= 0) {
      throw new Error(`claimTtlMs must be a positive integer, got ${claimTtlMs}`);
    }
  }

  /**
   * Try to claim a ride for a driver. Exactly one concurrent caller gets
   * `acquired: true`.
   *
   * Re-claiming a ride you already hold succeeds and is treated as acquired -
   * the driver app retries on a dropped response (CLAUDE.md §5.3 buffers and
   * resends), and punishing a retry with 409 would make a network blip look
   * like losing the race.
   */
  async claim(rideId: string, driverId: string): Promise<ClaimResult> {
    const key = RedisKeys.rideClaim(rideId);

    const acquired = await this.redis.setIfAbsent(key, driverId, this.claimTtlMs);
    if (acquired) return { acquired: true, heldBy: driverId };

    const heldBy = await this.redis.get(key);

    // Same driver retrying. Not a loss.
    if (heldBy === driverId) return { acquired: true, heldBy: driverId };

    // The holder's claim expired between our SET and our GET, so the ride is
    // free again. One more attempt, then give up rather than spin - a loop here
    // under contention would burn CPU on the busiest path in the system.
    if (heldBy === null) {
      const retried = await this.redis.setIfAbsent(key, driverId, this.claimTtlMs);
      if (retried) return { acquired: true, heldBy: driverId };
      return { acquired: false, heldBy: await this.redis.get(key) };
    }

    return { acquired: false, heldBy };
  }

  /** {@link claim}, but throws the 409 the API contract specifies. */
  async claimOrThrow(rideId: string, driverId: string): Promise<void> {
    const result = await this.claim(rideId, driverId);
    if (!result.acquired) {
      this.logger?.info(
        { ride_id: rideId, event: 'ride.claim_lost' },
        'driver lost the claim race',
      );
      throw new RideAlreadyClaimedError();
    }
  }

  /**
   * Release a claim this driver holds.
   *
   * Compare-and-delete, never a plain DEL. The dangerous interleaving is:
   * driver A's claim expires, driver B claims the ride legitimately, and only
   * then does A's release arrive. A plain DEL would drop B's live claim and let
   * a third driver in - reintroducing the exact double-dispatch this class
   * exists to prevent.
   */
  async release(rideId: string, driverId: string): Promise<boolean> {
    return this.redis.compareAndDelete(RedisKeys.rideClaim(rideId), driverId);
  }

  async currentHolder(rideId: string): Promise<string | null> {
    return this.redis.get(RedisKeys.rideClaim(rideId));
  }

  async remainingMs(rideId: string): Promise<number> {
    return this.redis.pttl(RedisKeys.rideClaim(rideId));
  }

  /**
   * Run `work` while holding the claim, releasing it if `work` fails.
   *
   * This is the shape every accept path must use. Without the rollback, a
   * driver who wins the claim and then hits a database error leaves the ride
   * claimed-but-unassigned for the full TTL: no other driver can take it, and
   * the rider waits 30 seconds for nothing.
   *
   * On SUCCESS the claim is deliberately left in place. It expires on its own,
   * and until it does it keeps a duplicate accept from a retry off the ride.
   */
  async withClaim<T>(
    rideId: string,
    driverId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    await this.claimOrThrow(rideId, driverId);

    try {
      return await work();
    } catch (error) {
      const released = await this.release(rideId, driverId).catch(() => false);
      this.logger?.warn(
        { ride_id: rideId, event: 'ride.claim_rolled_back', released },
        'released claim after the accept transaction failed',
      );
      throw error;
    }
  }
}
