import type { Clock } from '../common/clock.js';
import type { Logger } from '../common/logger.js';
import {
  ConflictProblem,
  InvalidRideTransitionError,
  NotFoundProblem,
} from '../common/problem.js';
import type { Database, Queryable } from '../db/db.port.js';
import { isUniqueViolationOn } from '../db/db.port.js';
import { FareCalculator, type LatLng } from '../fare/fare-calculator.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { RideClaimService } from '../matching/ride-claim.service.js';
import { PlatformConfigService } from '../platform-config/platform-config.service.js';
import { RideStateMachine } from './ride-state-machine.js';
import { RideRepository } from './ride.repository.js';
import type { Actor, RideRecord, RideStatus } from './ride.types.js';

/**
 * Ride orchestration.
 *
 * This is where the separately-tested pieces are composed, and composition is
 * where the remaining risk lives. Each rule below exists because the obvious
 * implementation gets it wrong:
 *
 *  - **The state machine decides, the repository writes.** Nothing here sets
 *    `status` (CLAUDE.md §12.4). `validate()` throws before any write happens.
 *
 *  - **Settlement is one transaction.** The status change, the fare, the
 *    payment row and the balanced ledger entries commit together or not at all
 *    (CLAUDE.md §4). A partial commit here means money that does not reconcile.
 *
 *  - **Side effects run after COMMIT.** Releasing the Redis claim or publishing
 *    a realtime event before the commit means telling a rider about a ride that
 *    may still roll back. `tx.onCommit` exists for exactly this.
 *
 *  - **Commission is snapshotted at creation.** An admin changing the rate
 *    mid-trip must not alter the terms a driver already accepted, so settlement
 *    reads `ride.commissionBpsSnapshot`, never the live config.
 */
export class RideService {
  constructor(
    private readonly db: Database,
    private readonly rides: RideRepository,
    private readonly stateMachine: RideStateMachine,
    private readonly claims: RideClaimService,
    private readonly ledger: LedgerService,
    private readonly fare: FareCalculator,
    private readonly config: PlatformConfigService,
    private readonly clock: Clock,
    private readonly logger?: Logger,
  ) {}

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  /**
   * Create a ride. Called from inside the idempotency wrapper, so a retry never
   * reaches here twice for the same key (CLAUDE.md §5.2).
   */
  async createRide(input: {
    riderId: string;
    pickup: LatLng;
    pickupAddress?: string | null;
    dropoff: LatLng;
    dropoffAddress?: string | null;
  }): Promise<RideRecord> {
    return this.db.transaction(async (tx) => {
      const tariff = await this.config.tariff(tx);
      const commissionBps = await this.config.commissionBps(tx);
      const quote = this.fare.quoteForTrip(tariff, input.pickup, input.dropoff);

      try {
        const ride = await this.rides.create(tx, {
          riderId: input.riderId,
          pickupLat: input.pickup.lat,
          pickupLng: input.pickup.lng,
          pickupAddress: input.pickupAddress ?? null,
          dropoffLat: input.dropoff.lat,
          dropoffLng: input.dropoff.lng,
          dropoffAddress: input.dropoffAddress ?? null,
          estimatedFareIqd: quote.totalIqd,
          estimatedDistanceM: quote.distanceM,
          estimatedDurationS: quote.durationS,
          // Frozen here on purpose - see the class comment.
          commissionBpsSnapshot: commissionBps,
        });

        await this.rides.insertEvent(tx, {
          rideId: ride.id,
          from: 'REQUESTED',
          to: 'REQUESTED',
          actorType: 'RIDER',
          actorId: input.riderId,
          description: 'Ride requested.',
          metadata: { estimatedFareIqd: quote.totalIqd },
        });

        this.logger?.info(
          { event: 'ride.created', ride_id: ride.id, fare_iqd: quote.totalIqd },
          'ride created',
        );

        return ride;
      } catch (error) {
        // The partial unique index rides_one_active_per_rider_uq. A rider with a
        // live ride gets a clear 409 rather than a raw constraint error.
        if (isUniqueViolationOn(error, 'rides_one_active_per_rider_uq')) {
          throw new ConflictProblem(
            'You already have a ride in progress. Complete or cancel it first.',
          );
        }
        throw error;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Fetch a ride the caller is allowed to see.
   *
   * Returns 404 for "does not exist" AND for "exists but is not yours"
   * (DECISIONS.md D-007): distinguishing them would confirm which ride ids are
   * real, which is an enumeration oracle over other people's trips.
   */
  async getRideFor(rideId: string, actor: Actor): Promise<RideRecord> {
    const ride = await this.rides.findById(this.db, rideId);
    if (!ride) throw new NotFoundProblem('Ride');

    if (actor.type === 'ADMIN') return ride;

    const isRider = actor.type === 'RIDER' && ride.riderId === actor.id;
    const isAssignedDriver = actor.type === 'DRIVER' && ride.driverId === actor.id;
    if (isRider || isAssignedDriver) return ride;

    // A driver holding a LIVE offer can read it too - they have to see the
    // pickup and fare to decide whether to accept, and at that point the ride
    // has no assigned driver yet. Scoped to a PENDING offer for this driver
    // specifically, so a declined or superseded offer stops granting access.
    if (actor.type === 'DRIVER' && actor.id) {
      const offer = await this.db.query(
        `SELECT 1 FROM ride_offers
          WHERE ride_id = $1 AND driver_id = $2 AND status = 'PENDING' LIMIT 1`,
        [rideId, actor.id],
      );
      if (offer.rowCount > 0) return ride;
    }

    throw new NotFoundProblem('Ride');
  }

  async listMyRides(
    actor: Actor,
    options: { limit?: number; after?: string; status?: RideStatus } = {},
  ): Promise<RideRecord[]> {
    if (!actor.id) throw new NotFoundProblem('Ride');

    // Clamp AFTER reading, and build the query explicitly rather than spreading
    // `options` over it - a spread would put the caller's unclamped `limit`
    // back on top and let a client ask for 100,000 rides.
    const query = {
      limit: Math.min(Math.max(options.limit ?? 20, 1), 50),
      ...(options.after !== undefined ? { after: options.after } : {}),
      ...(options.status !== undefined ? { status: options.status } : {}),
    };

    return actor.type === 'DRIVER'
      ? this.rides.listForDriver(this.db, actor.id, query)
      : this.rides.listForRider(this.db, actor.id, query);
  }

  // -------------------------------------------------------------------------
  // Offer
  // -------------------------------------------------------------------------

  /**
   * Offer a ride to one driver: `REQUESTED -> OFFERED`.
   *
   * Performed by the matching worker as SYSTEM, never by a user. A driver
   * cannot offer themselves a ride, which is what stops a driver cherry-picking
   * a ride they were not selected for.
   *
   * The state machine has no `REQUESTED -> ACCEPTED` rule, so this step is not
   * optional: without it `acceptRide` is unreachable.
   */
  async offerRideTo(
    rideId: string,
    driverId: string,
    options: { distanceM?: number; timeoutSeconds?: number } = {},
  ): Promise<RideRecord> {
    return this.db.transaction(async (tx) => {
      const ride = await this.rides.findByIdForUpdate(tx, rideId);
      if (!ride) throw new NotFoundProblem('Ride');

      const timeoutSeconds =
        options.timeoutSeconds ?? (await this.config.read(tx)).offer_timeout_seconds;
      const expiresAt = new Date(this.clock.nowMs() + timeoutSeconds * 1_000);

      const decision = this.stateMachine.validate({
        ride,
        to: 'OFFERED',
        actor: { type: 'SYSTEM' },
        metadata: { driverId, expiresAt: expiresAt.toISOString() },
      });

      const updated = await this.rides.applyTransition(tx, decision);
      if (!updated) throw new InvalidRideTransitionError(ride.status, 'OFFERED');

      await this.rides.insertEvent(tx, decision);

      await tx.query(
        // ON CONFLICT so that re-offering after an expiry reuses the row rather
        // than failing on ride_offers_ride_driver_uq.
        `INSERT INTO ride_offers (ride_id, driver_id, status, distance_m, expires_at)
         VALUES ($1, $2, 'PENDING', $3, $4)
         ON CONFLICT (ride_id, driver_id)
         DO UPDATE SET status = 'PENDING', expires_at = $4, responded_at = NULL`,
        [rideId, driverId, options.distanceM ?? 0, expiresAt],
      );

      return updated;
    });
  }

  /**
   * The offer lapsed or was declined.
   *
   * `OFFERED -> EXPIRED` and then straight back to `REQUESTED` (another
   * candidate remains) or `NO_DRIVERS_FOUND` (none do), in ONE transaction.
   * CLAUDE.md §4 requires the EXPIRED transition to be recorded, but a ride
   * resting in EXPIRED is invisible to matching and the rider waits forever.
   * See DECISIONS.md D-009.
   */
  async expireOffer(
    rideId: string,
    options: { candidatesRemain: boolean; reason?: string } = { candidatesRemain: true },
  ): Promise<RideRecord> {
    return this.db.transaction(async (tx) => {
      const ride = await this.rides.findByIdForUpdate(tx, rideId);
      if (!ride) throw new NotFoundProblem('Ride');

      const system: Actor = { type: 'SYSTEM' };

      const toExpired = this.stateMachine.validate({
        ride,
        to: 'EXPIRED',
        actor: system,
        metadata: { reason: options.reason ?? 'offer timed out' },
      });
      const expired = await this.rides.applyTransition(tx, toExpired);
      if (!expired) throw new InvalidRideTransitionError(ride.status, 'EXPIRED');
      await this.rides.insertEvent(tx, toExpired);

      await tx.query(
        `UPDATE ride_offers SET status = 'TIMED_OUT', responded_at = now()
          WHERE ride_id = $1 AND status = 'PENDING'`,
        [rideId],
      );

      const next: RideStatus = options.candidatesRemain ? 'REQUESTED' : 'NO_DRIVERS_FOUND';
      const toNext = this.stateMachine.validate({ ride: expired, to: next, actor: system });
      const settled = await this.rides.applyTransition(tx, toNext);
      if (!settled) throw new InvalidRideTransitionError('EXPIRED', next);
      await this.rides.insertEvent(tx, toNext);

      return settled;
    });
  }

  /** No candidate was available at all: `REQUESTED -> NO_DRIVERS_FOUND`. */
  async markNoDriversFound(rideId: string): Promise<RideRecord> {
    return this.simpleTransition(rideId, 'NO_DRIVERS_FOUND', { type: 'SYSTEM' }, () => ({}));
  }

  // -------------------------------------------------------------------------
  // Accept - CLAUDE.md §5.1
  // -------------------------------------------------------------------------

  /**
   * A driver accepts an offer.
   *
   * The Redis claim decides the winner BEFORE the transaction opens. Doing it
   * the other way round - transaction first, claim inside - would hold a
   * database connection for the duration of a Redis round trip on the hottest
   * path in the system, and under transaction pooling that is how a 25-slot
   * pool becomes the bottleneck at 500 users.
   *
   * `withClaim` releases the claim if the transaction throws, so a database
   * failure does not leave the ride claimed-but-unassigned for the full TTL.
   */
  async acceptRide(rideId: string, driverId: string): Promise<RideRecord> {
    return this.claims.withClaim(rideId, driverId, async () =>
      this.db.transaction(async (tx) => {
        const ride = await this.rides.findByIdForUpdate(tx, rideId);
        if (!ride) throw new NotFoundProblem('Ride');

        // D-14. The offer must actually belong to this driver.
        //
        // Without this check, `accept` authorised nobody: the state machine
        // call below deliberately presents the CALLER as the offered driver so
        // that `mustBeAssignedDriver` passes, and `ride.driver_id` is still
        // null in OFFERED - so every driver looked like the offeree. Any driver
        // holding a ride id could take a ride offered to someone else, and the
        // obvious way to obtain one is to be offered a ride and decline it:
        // decline, wait for it to be re-offered, then accept and take it from
        // the driver who was actually dispatched.
        //
        // Checked inside the same transaction and the same `FOR UPDATE` as the
        // status read, so it cannot race with the offer moving on. Served by
        // the existing ride_offers index on (ride_id, status).
        //
        // 404, not 403: a driver who was not offered this ride is not entitled
        // to learn that it exists (same rule as rider IDOR).
        const offer = await tx.query<{ driver_id: string }>(
          `SELECT driver_id FROM ride_offers
            WHERE ride_id = $1 AND driver_id = $2 AND status = 'PENDING'
            LIMIT 1`,
          [rideId, driverId],
        );
        if (offer.rows.length === 0) throw new NotFoundProblem('Offer');

        const decision = this.stateMachine.validate({
          // The driver is not yet assigned in the database, but they hold the
          // claim AND the pending offer checked above, so they ARE the offered
          // driver. Presenting them as such is what lets the machine's
          // `mustBeAssignedDriver` rule authorise this one transition without a
          // special case in the rule table.
          ride: { ...ride, driverId },
          to: 'ACCEPTED',
          actor: { type: 'DRIVER', id: driverId },
        });

        const now = this.clock.now();

        let updated: RideRecord | null;
        try {
          updated = await this.rides.applyTransition(tx, decision, {
            driverId,
            acceptedAt: now,
          });
        } catch (error) {
          // The database-level backstop behind the Redis claim. If this fires,
          // the claim was bypassed somehow and the index saved us.
          if (isUniqueViolationOn(error, 'rides_one_active_per_driver_uq')) {
            throw new ConflictProblem('You already have a ride in progress.');
          }
          throw error;
        }

        if (!updated) {
          // Zero rows matched: the ride left OFFERED between our read and our
          // write. Never treat this as success.
          throw new InvalidRideTransitionError(ride.status, 'ACCEPTED');
        }

        await this.rides.insertEvent(tx, decision);
        await this.markOfferAccepted(tx, rideId, driverId);
        await tx.query(
          `UPDATE drivers SET availability = 'ON_TRIP', updated_at = now() WHERE user_id = $1`,
          [driverId],
        );

        this.logger?.info({ event: 'ride.accepted', ride_id: rideId }, 'ride accepted');
        return updated;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Simple driver transitions
  // -------------------------------------------------------------------------

  async markArrived(rideId: string, actor: Actor): Promise<RideRecord> {
    return this.simpleTransition(rideId, 'DRIVER_ARRIVED', actor, (now) => ({
      driverArrivedAt: now,
    }));
  }

  async startRide(rideId: string, actor: Actor): Promise<RideRecord> {
    return this.simpleTransition(rideId, 'IN_PROGRESS', actor, (now) => ({ startedAt: now }));
  }

  private async simpleTransition(
    rideId: string,
    to: RideStatus,
    actor: Actor,
    effects: (now: Date) => Record<string, unknown>,
  ): Promise<RideRecord> {
    return this.db.transaction(async (tx) => {
      const ride = await this.rides.findByIdForUpdate(tx, rideId);
      if (!ride) throw new NotFoundProblem('Ride');

      const decision = this.stateMachine.validate({ ride, to, actor });
      const updated = await this.rides.applyTransition(
        tx,
        decision,
        effects(this.clock.now()),
      );
      if (!updated) throw new InvalidRideTransitionError(ride.status, to);

      await this.rides.insertEvent(tx, decision);
      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  /**
   * Cancel. The target state is derived from the caller's role, so a rider
   * cannot cause a `CANCELLED_BY_DRIVER` and skew the driver's stats.
   */
  async cancelRide(rideId: string, actor: Actor, reason?: string): Promise<RideRecord> {
    return this.db.transaction(async (tx) => {
      const ride = await this.rides.findByIdForUpdate(tx, rideId);
      if (!ride) throw new NotFoundProblem('Ride');

      const to = this.cancellationTargetFor(ride, actor);
      const decision = this.stateMachine.validate({ ride, to, actor, metadata: { reason } });

      const updated = await this.rides.applyTransition(tx, decision, {
        cancelledAt: this.clock.now(),
        cancellationReason: reason ?? null,
      });
      if (!updated) throw new InvalidRideTransitionError(ride.status, to);

      await this.rides.insertEvent(tx, decision);
      await this.releaseDriver(tx, ride.driverId);

      // Only after COMMIT: releasing the claim before it would let another
      // driver take a ride whose cancellation might still roll back.
      if (ride.driverId) {
        const driverId = ride.driverId;
        tx.onCommit(async () => {
          await this.claims.release(rideId, driverId);
        });
      }

      return updated;
    });
  }

  private cancellationTargetFor(ride: RideRecord, actor: Actor): RideStatus {
    if (actor.type === 'RIDER') return 'CANCELLED_BY_RIDER';
    if (actor.type === 'DRIVER') return 'CANCELLED_BY_DRIVER';
    // Admin aborting a trip already under way is its own state, admin-only.
    if (actor.type === 'ADMIN') {
      return ride.status === 'IN_PROGRESS' ? 'CANCELLED_IN_TRIP' : 'CANCELLED_BY_RIDER';
    }
    return 'CANCELLED_BY_RIDER';
  }

  // -------------------------------------------------------------------------
  // Completion - the atomic settlement (CLAUDE.md §4, §6.2)
  // -------------------------------------------------------------------------

  async completeRide(
    rideId: string,
    actor: Actor,
    actualDistanceM?: number | null,
  ): Promise<{ ride: RideRecord; ledgerTransactionId: string }> {
    return this.db.transaction(async (tx) => {
      const ride = await this.rides.findByIdForUpdate(tx, rideId);
      if (!ride) throw new NotFoundProblem('Ride');

      // Completing an already-completed ride returns the same result and writes
      // nothing, so a retried request cannot settle the fare twice.
      if (ride.status === 'COMPLETED') {
        const existing = await tx.query<{ transaction_id: string }>(
          'SELECT transaction_id FROM ledger_entries WHERE ride_id = $1 LIMIT 1',
          [rideId],
        );
        return { ride, ledgerTransactionId: existing.rows[0]?.transaction_id ?? '' };
      }

      const decision = this.stateMachine.validate({ ride, to: 'COMPLETED', actor });

      // The schema's rides_driver_required_after_accept constraint makes this
      // unreachable, but settlement is the money path: an assertion that fails
      // loudly beats a non-null assertion that writes a ledger row against
      // `null` and only surfaces as an unbalanced account weeks later.
      if (!ride.driverId) {
        throw new ConflictProblem(
          `Ride ${rideId} is ${ride.status} with no assigned driver; refusing to settle.`,
        );
      }
      const driverId = ride.driverId;

      const tariff = await this.config.tariff(tx);
      const finalFareIqd = this.fare.settle(
        tariff,
        ride.estimatedFareIqd,
        actualDistanceM ?? null,
        null,
      );

      // The SNAPSHOT, not the live rate. See the class comment.
      const { commissionIqd } = this.fare.splitCommission(
        finalFareIqd,
        ride.commissionBpsSnapshot,
      );

      const now = this.clock.now();
      const updated = await this.rides.applyTransition(tx, decision, {
        completedAt: now,
        finalFareIqd,
        commissionIqd,
        actualDistanceM: actualDistanceM ?? null,
      });
      if (!updated) throw new InvalidRideTransitionError(ride.status, 'COMPLETED');

      await this.rides.insertEvent(tx, decision);

      await tx.query(
        `INSERT INTO payments (ride_id, provider, status, amount_iqd, confirmed_by, confirmed_at)
         VALUES ($1, 'CASH', 'CONFIRMED', $2, $3, $4)`,
        [rideId, finalFareIqd, driverId, now],
      );

      const ledgerTransactionId = await this.ledger.recordRideSettlement(tx, {
        rideId,
        driverId,
        fareIqd: finalFareIqd,
        commissionIqd,
      });

      await this.releaseDriver(tx, driverId);

      tx.onCommit(async () => {
        await this.claims.release(rideId, driverId);
      });

      this.logger?.info(
        {
          event: 'ride.completed',
          ride_id: rideId,
          fare_iqd: finalFareIqd,
          commission_iqd: commissionIqd,
        },
        'ride completed and settled',
      );

      return { ride: updated, ledgerTransactionId };
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async releaseDriver(q: Queryable, driverId: string | null): Promise<void> {
    if (!driverId) return;
    await q.query(
      // Guarded on ON_TRIP so this cannot resurrect a driver who went OFFLINE.
      `UPDATE drivers SET availability = 'ONLINE', updated_at = now()
        WHERE user_id = $1 AND availability = 'ON_TRIP'`,
      [driverId],
    );
  }

  private async markOfferAccepted(
    q: Queryable,
    rideId: string,
    driverId: string,
  ): Promise<void> {
    await q.query(
      `UPDATE ride_offers
          SET status = CASE WHEN driver_id = $2 THEN 'ACCEPTED'::offer_status
                            ELSE 'SUPERSEDED'::offer_status END,
              responded_at = now()
        WHERE ride_id = $1 AND status = 'PENDING'`,
      [rideId, driverId],
    );
  }
}
