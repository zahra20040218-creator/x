import type { Clock } from '../common/clock.js';
import type { Logger } from '../common/logger.js';
import {
  ConflictProblem,
  InvalidRideTransitionError,
  NotFoundProblem,
} from '../common/problem.js';
import type { Database, Queryable, Transaction } from '../db/db.port.js';
import { isUniqueViolationOn } from '../db/db.port.js';
import { FareCalculator, type LatLng } from '../fare/fare-calculator.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { RideClaimService } from '../matching/ride-claim.service.js';
import { iqd, type IqdAmount } from '../money/iqd.js';
import {
  CashProvider,
  PaymentProviderRegistry,
} from '../payments/payment-provider.js';
import { PlatformConfigService } from '../platform-config/platform-config.service.js';
import { RideStateMachine } from './ride-state-machine.js';
import { RideRepository } from './ride.repository.js';
import type { RideEventPublisher } from '../realtime/ride-event-publisher.js';
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
    /**
     * Optional so every existing construction site keeps working unchanged.
     * Absent means no realtime delivery - which is exactly what the system did
     * before this existed, so its absence cannot break anything.
     */
    private readonly events?: RideEventPublisher,
    /**
     * Optional, and defaulted to a cash-only registry.
     *
     * Optional for the same reason `events` is: every existing construction
     * site keeps working unchanged. The default is not a stub - it is a real
     * `CashProvider` over the same ledger, so settlement behaves identically
     * whether or not a caller supplies one.
     */
    private readonly payments: PaymentProviderRegistry = new PaymentProviderRegistry([
      new CashProvider(ledger),
    ]),
  ) {}

  /**
   * Record a transition and tell both parties about it.
   *
   * The publish is scheduled on COMMIT, never inside the transaction. A client
   * told a ride is IN_PROGRESS by a transaction that then rolls back has no way
   * to discover it was wrong - it would simply hold a state the server does not
   * agree with until the next poll.
   *
   * Failures are swallowed: a rider not hearing about a status change is worse
   * than the poll fallback, but it is not worth rolling back a committed ride
   * transition for.
   */
  private notifyTransition(
    tx: Transaction,
    ride: { id: string; riderId: string; driverId: string | null },
    to: RideStatus,
  ): void {
    if (!this.events) return;

    const event = {
      type: 'ride.status_changed' as const,
      payload: { rideId: ride.id, status: to, at: new Date(this.clock.nowMs()).toISOString() },
    };
    const { riderId, driverId } = ride;

    tx.onCommit(async () => {
      // LOGGED, not swallowed. A silent catch here is how a realtime channel
      // ends up carrying nothing while every test passes - which is the exact
      // bug this method was written to fix.
      try {
        await this.events?.toRider(riderId, event);
        if (driverId) await this.events?.toDriver(driverId, event);
      } catch (error) {
        this.logger?.error(
          { event: 'realtime.publish_failed', ride_id: ride.id, err: error },
          'could not publish a status change; clients fall back to polling',
        );
      }
    });
  }

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
    /**
     * What the rider offers to pay. Ignored unless negotiation is switched on.
     *
     * Without this the bid tables, the service and three documented endpoints
     * had nothing to bid against: `placeBid` requires a ride carrying a
     * proposal, and no caller could ever set one. The feature was unreachable
     * through the API in the most literal sense.
     */
    proposedFareIqd?: number | null;
  }): Promise<RideRecord> {
    return this.db.transaction(async (tx) => {
      const tariff = await this.config.tariff(tx);
      const commissionBps = await this.config.commissionBps(tx);
      const quote = this.fare.quoteForTrip(tariff, input.pickup, input.dropoff);

      // The proposal, bounded against the meter.
      //
      // Dropped silently when negotiation is off rather than rejected: a rider
      // on a build that sends the field must still be able to request a ride
      // the ordinary way, and 422 for a field the server simply does not use
      // would strand them.
      //
      // The band is symmetric and enforced HERE, at creation, because it is the
      // only point where the metered estimate and the rider's number exist
      // together. A rider anchoring at 500 IQD on a 5,250 trip is not
      // negotiating, and a driver holding out for ten times the meter is not
      // either.
      const proposedFareIqd = await this.boundedProposal(tx, input.proposedFareIqd, quote.totalIqd);

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
          proposedFareIqd: proposedFareIqd,
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
          metadata: {
            estimatedFareIqd: quote.totalIqd,
            ...(proposedFareIqd !== null ? { proposedFareIqd } : {}),
          },
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
      this.notifyTransition(tx, updated, 'OFFERED');

      // The offer itself, to the driver who was chosen. This is the event the
      // driver app was polling for every 5 seconds against a 15-second expiry.
      if (this.events) {
        const publisher = this.events;
        tx.onCommit(async () => {
          try {
            await publisher.toDriver(driverId, {
              type: 'ride.offer',
              payload: {
                rideId,
                expiresAt: expiresAt.toISOString(),
                distanceM: options.distanceM ?? 0,
                // Lets a client measure its own end-to-end matching latency
                // without correlating two separate requests.
                requestedAt: updated.requestedAt.toISOString(),
              },
            });
          } catch (error) {
            // The driver still has the polling path, but this is the difference
            // between a 5-second delay and an instant offer - it is worth an
            // error line, not a silent catch.
            this.logger?.error(
              { event: 'realtime.offer_publish_failed', ride_id: rideId, err: error },
              'could not publish the ride offer to the driver',
            );
          }
        });
      }

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

      // A negotiated price is a PRICE, not a floor.
      //
      // When rider and driver agreed a fare through bidding, that number is the
      // contract and settlement is exactly it - no meter recompute, no
      // higher-of. Running `settle()` over an agreed fare would take the larger
      // of the bid and the meter, so a driver who bid 4,000 on a trip the meter
      // prices at 5,250 would see the rider billed 5,250. That does not merely
      // ignore the negotiation, it inverts it: bidding low would raise the
      // fare, and the whole feature would be a lie told to both sides.
      //
      // This was live: settlement read `estimatedFareIqd` and never consulted
      // `agreed_fare_iqd`, which the repository has selected and mapped since
      // 0012. The column reached the domain object and stopped there. Nothing
      // caught it because negotiation is not yet reachable through the API - so
      // the defect was dormant, not absent, and would have shipped with the
      // feature.
      //
      // D-004 is not weakened. It governs the ESTIMATE path, where the quote is
      // a price the rider accepted and a short trip must not refund it. An
      // agreed fare is that same principle applied to a number both parties
      // chose explicitly, which is why it does not need a floor.
      const tariff = await this.config.tariff(tx);
      const finalFareIqd =
        ride.agreedFareIqd ??
        this.fare.settle(tariff, ride.estimatedFareIqd, actualDistanceM ?? null, null);

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

      // Through the §7 abstraction, not around it.
      //
      // This used to inline the INSERT with `'CASH'` as a hardcoded SQL literal
      // and call the ledger directly - a line-for-line duplicate of
      // `CashProvider.charge`. The consequence was not the duplication: it was
      // that `PaymentProviderRegistry` was registered in DI and injected into
      // nothing, so the seam §7 exists to prove had never carried a single real
      // payment. Its promise - "adding ZainCash means implementing three
      // methods" - was untested, and an untested seam is a guess.
      //
      // The provider is chosen from the ride's own `paymentMethod` rather than
      // assumed, so the day a second one exists this line does not change.
      const payment = await this.payments.get(ride.paymentMethod).charge(
        tx,
        rideId,
        finalFareIqd,
        {
          rideId,
          driverId,
          riderId: ride.riderId,
          commissionBps: ride.commissionBpsSnapshot,
          commissionIqd,
          confirmedAt: now,
        },
      );

      const ledgerTransactionId = payment.ledgerTransactionId;

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

  /**
   * The rider's proposal, clamped to the configured band around the meter.
   *
   * Returns null when negotiation is off, when no proposal was sent, or when
   * the number is not a usable amount. Null means "an ordinary metered ride",
   * which is the v1 default and the only shape that exists today.
   *
   * Clamped rather than rejected. A rider who typed 3,000 on a 5,250 trip meant
   * "I want it cheaper", and answering with a validation error teaches them
   * nothing about what IS allowed; clamping to the floor makes the boundary
   * visible in the number they get back. The band is read from config so an
   * owner can widen or close it without a deploy (CLAUDE.md §6.5's reasoning,
   * applied to the same kind of knob).
   */
  private async boundedProposal(
    q: Queryable,
    proposed: number | null | undefined,
    meteredIqd: IqdAmount,
  ): Promise<IqdAmount | null> {
    if (proposed === null || proposed === undefined) return null;
    if (!(await this.config.negotiationEnabled(q))) return null;

    // Through `iqd()` and not a cast: this arrives from JSON and a fractional
    // amount must be refused rather than rounded (CLAUDE.md §6.1).
    const amount = iqd(proposed);
    if (amount <= 0) return null;

    const bandBps = await this.config.negotiationBandBps(q);
    const spread = Math.round((meteredIqd * bandBps) / 10_000);
    const floor = Math.max(1, meteredIqd - spread);
    const ceiling = meteredIqd + spread;

    return iqd(Math.min(ceiling, Math.max(floor, amount)));
  }

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
