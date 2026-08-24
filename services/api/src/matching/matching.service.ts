import type { DriverComplianceService } from '../compliance/driver-compliance.service.js';
import type { Clock } from '../common/clock.js';
import type { Logger } from '../common/logger.js';
import type { Database } from '../db/db.port.js';
import { PlatformConfigService } from '../platform-config/platform-config.service.js';
import { RedisKeys, type RedisPort } from '../redis/redis.port.js';
import { RideRepository } from '../rides/ride.repository.js';
import { RideService } from '../rides/ride.service.js';
import { DriverPresenceService } from './driver-presence.service.js';

/**
 * The offer loop. CLAUDE.md §2: "Matching: nearest available driver, offer with
 * timeout, atomic claim."
 *
 * One ride is offered to ONE driver at a time, with a deadline. Broadcasting to
 * several at once would get a ride accepted faster and is what most first
 * implementations do - it is also how two drivers end up racing for the same
 * rider, and it makes the atomic claim the only thing standing between the
 * platform and a street argument. Sequential offers keep the claim as a
 * backstop rather than as the primary mechanism.
 *
 * Eligibility is decided in two places on purpose:
 *
 *   - **Redis** answers "who is near, and how near" (CLAUDE.md §3.1). Fast, and
 *     the only structure that knows where drivers are.
 *   - **Postgres** answers "who is allowed to drive" - not suspended, not
 *     already on a trip. That is durable state and must not live in a cache
 *     that can be flushed.
 *
 * Getting this the other way round is the classic bug: a suspended driver stays
 * in the geo set and keeps receiving offers.
 */

export interface DispatchResult {
  outcome: 'OFFERED' | 'NO_DRIVERS_FOUND' | 'NOT_DISPATCHABLE';
  driverId?: string;
  distanceM?: number;
  candidatesConsidered: number;
}

export class MatchingService {
  constructor(
    private readonly db: Database,
    private readonly rides: RideRepository,
    private readonly rideService: RideService,
    private readonly presence: DriverPresenceService,
    private readonly config: PlatformConfigService,
    private readonly redis: RedisPort,
    private readonly clock: Clock,
    private readonly maxDriversPerRide = 8,
    private readonly logger?: Logger,
    /**
     * Optional so every existing construction site keeps working and behaves
     * exactly as before. Absent means no document policy, which is also what an
     * empty policy means.
     */
    private readonly compliance?: DriverComplianceService,
  ) {}

  /**
   * Offer the ride to the nearest eligible driver who has not already been
   * offered it, or conclude that nobody is available.
   */
  async dispatch(rideId: string): Promise<DispatchResult> {
    const ride = await this.rides.findById(this.db, rideId);
    if (!ride) return { outcome: 'NOT_DISPATCHABLE', candidatesConsidered: 0 };

    // Only a ride waiting for a driver is dispatchable. Anything else means
    // another worker got there first, or the rider cancelled.
    if (ride.status !== 'REQUESTED') {
      return { outcome: 'NOT_DISPATCHABLE', candidatesConsidered: 0 };
    }

    const config = await this.config.read(this.db);

    const alreadyOffered = new Set(
      await this.redis.zRangeByScore(RedisKeys.rideOfferedDrivers(rideId), 0, Infinity),
    );

    // Ask for more than we need: some candidates will be filtered out by the
    // eligibility query, and a second Redis round trip costs more than a few
    // extra members.
    const nearby = await this.presence.findNearby(
      { lat: ride.pickupLat, lng: ride.pickupLng },
      config.search_radius_meters,
      this.maxDriversPerRide + alreadyOffered.size,
    );

    const fresh = nearby.filter((candidate) => !alreadyOffered.has(candidate.driverId));

    if (fresh.length === 0) {
      return this.concludeNoDrivers(rideId, nearby.length);
    }

    const eligible = await this.filterEligible(fresh.map((c) => c.driverId));
    // `nearby` is already nearest-first, so the first survivor is the nearest.
    const chosen = fresh.find((c) => eligible.has(c.driverId));

    if (!chosen) {
      return this.concludeNoDrivers(rideId, nearby.length);
    }

    await this.rideService.offerRideTo(rideId, chosen.driverId, {
      distanceM: chosen.distanceM,
      timeoutSeconds: config.offer_timeout_seconds,
    });

    // Remember the offer so the next round does not pick the same driver again.
    await this.redis.zAdd(
      RedisKeys.rideOfferedDrivers(rideId),
      chosen.driverId,
      this.clock.nowMs(),
    );
    await this.redis.hSet(
      RedisKeys.driverCurrentOffer(chosen.driverId),
      'rideId',
      rideId,
    );

    this.logger?.info(
      {
        event: 'ride.offered',
        ride_id: rideId,
        distance_m: chosen.distanceM,
        candidates: nearby.length,
      },
      'ride offered to nearest eligible driver',
    );

    return {
      outcome: 'OFFERED',
      driverId: chosen.driverId,
      distanceM: chosen.distanceM,
      candidatesConsidered: nearby.length,
    };
  }

  /**
   * An offer lapsed or was declined: move on to the next candidate.
   *
   * `candidatesRemain` is computed BEFORE expiring, because the expiry itself
   * returns the ride to REQUESTED and the decision of where it goes next has to
   * be made in the same breath (see DECISIONS.md D-009).
   */
  async handleOfferOutcome(
    rideId: string,
    reason: 'timeout' | 'declined',
  ): Promise<DispatchResult> {
    const ride = await this.rides.findById(this.db, rideId);
    if (!ride || ride.status !== 'OFFERED') {
      return { outcome: 'NOT_DISPATCHABLE', candidatesConsidered: 0 };
    }

    // NOT `ride.driverId` - a ride in OFFERED has no driver assigned yet
    // (driver_id is set on accept). Reading it here would always be null, and
    // the offeree's outstanding-offer key would never be cleared on this path;
    // it only got cleared incidentally by clearOfferState when the pool ran
    // out. The offeree is on the PENDING offer row.
    const offeree = await this.db.query<{ driver_id: string }>(
      `SELECT driver_id FROM ride_offers WHERE ride_id = $1 AND status = 'PENDING' LIMIT 1`,
      [rideId],
    );
    const offeredDriverId = offeree.rows[0]?.driver_id;
    if (offeredDriverId) {
      await this.redis.del(RedisKeys.driverCurrentOffer(offeredDriverId));
    }

    const candidatesRemain = await this.hasFurtherCandidates(rideId, ride.pickupLat, ride.pickupLng);

    await this.rideService.expireOffer(rideId, {
      candidatesRemain,
      reason: reason === 'declined' ? 'driver declined' : 'offer timed out',
    });

    if (!candidatesRemain) {
      await this.clearOfferState(rideId);
      return { outcome: 'NO_DRIVERS_FOUND', candidatesConsidered: 0 };
    }

    // Back in REQUESTED; hand straight to the next candidate.
    return this.dispatch(rideId);
  }

  /** Tidy the per-ride matching state once the ride leaves the pool. */
  async clearOfferState(rideId: string): Promise<void> {
    const offered = await this.redis.zRangeByScore(
      RedisKeys.rideOfferedDrivers(rideId),
      0,
      Infinity,
    );
    for (const driverId of offered) {
      await this.redis.del(RedisKeys.driverCurrentOffer(driverId));
    }
    await this.redis.del(RedisKeys.rideOfferedDrivers(rideId));
  }

  /** The driver's outstanding offer, for the polling fallback in the contract. */
  async currentOfferFor(driverId: string): Promise<string | null> {
    return this.redis.hGet(RedisKeys.driverCurrentOffer(driverId), 'rideId');
  }

  /**
   * Sweep offers whose deadline passed.
   *
   * A driver who force-quits the app never declines and never accepts, so
   * without this the ride sits in OFFERED until someone notices. Runs from the
   * scheduled job.
   */
  async sweepExpiredOffers(limit = 50): Promise<string[]> {
    const result = await this.db.query<{ ride_id: string }>(
      // Served by ride_offers_pending_expires_idx (CLAUDE.md §3.4).
      `SELECT DISTINCT ride_id FROM ride_offers
        WHERE status = 'PENDING' AND expires_at < $1
        LIMIT $2`,
      [this.clock.now(), limit],
    );

    const swept: string[] = [];
    for (const row of result.rows) {
      try {
        await this.handleOfferOutcome(row.ride_id, 'timeout');
        swept.push(row.ride_id);
      } catch (error) {
        // One wedged ride must not stop the sweep for every other ride.
        this.logger?.warn(
          { event: 'offer.sweep_failed', ride_id: row.ride_id, err: error },
          'failed to expire an offer',
        );
      }
    }
    return swept;
  }

  // -------------------------------------------------------------------------

  private async concludeNoDrivers(
    rideId: string,
    candidatesConsidered: number,
  ): Promise<DispatchResult> {
    await this.rideService.markNoDriversFound(rideId);
    await this.clearOfferState(rideId);

    this.logger?.info(
      { event: 'ride.no_drivers_found', ride_id: rideId, candidates: candidatesConsidered },
      'no eligible driver available',
    );

    return { outcome: 'NO_DRIVERS_FOUND', candidatesConsidered };
  }

  private async hasFurtherCandidates(
    rideId: string,
    lat: number,
    lng: number,
  ): Promise<boolean> {
    const config = await this.config.read(this.db);
    const alreadyOffered = new Set(
      await this.redis.zRangeByScore(RedisKeys.rideOfferedDrivers(rideId), 0, Infinity),
    );

    const nearby = await this.presence.findNearby(
      { lat, lng },
      config.search_radius_meters,
      this.maxDriversPerRide + alreadyOffered.size,
    );

    const fresh = nearby.filter((c) => !alreadyOffered.has(c.driverId));
    if (fresh.length === 0) return false;

    const eligible = await this.filterEligible(fresh.map((c) => c.driverId));
    return fresh.some((c) => eligible.has(c.driverId));
  }

  /**
   * Durable eligibility, from Postgres.
   *
   * Suspension and current-trip status are not in Redis on purpose: a cache
   * flush must not silently make a suspended driver matchable again. Document
   * compliance is here for the same reason, and for one more: a licence lapses
   * on a date, so a driver who was compliant when they went online this morning
   * may not be this evening. Checking only at the point of going online would
   * miss exactly that.
   */
  private async filterEligible(driverIds: string[]): Promise<Set<string>> {
    if (driverIds.length === 0) return new Set();

    const result = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM drivers
        WHERE user_id = ANY($1::uuid[])
          AND availability = 'ONLINE'
          AND is_suspended = FALSE`,
      [driverIds as never],
    );

    const eligible = new Set(result.rows.map((r) => r.user_id));
    if (!this.compliance || eligible.size === 0) return eligible;

    // Costs nothing when no document policy is configured - filterCompliant
    // returns the input set without querying.
    return this.compliance.filterCompliant(this.db, [...eligible]);
  }
}
