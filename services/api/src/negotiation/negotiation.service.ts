import type { Logger } from 'pino';

import { CapabilityService } from '../capabilities/capability.service.js';
import type { Clock } from '../common/clock.js';
import {
  ConflictProblem,
  InvalidRideTransitionError,
  NotFoundProblem,
  ValidationProblem,
} from '../common/problem.js';
import type { Database, Queryable } from '../db/db.port.js';
import { type IqdAmount, iqd, parseIqdFromDb } from '../money/iqd.js';
import { isUniqueViolationOn } from '../db/db.port.js';
import { RideClaimService } from '../matching/ride-claim.service.js';
import type { PlatformConfigService } from '../platform-config/platform-config.service.js';
import type { RealtimeGateway } from '../realtime/realtime.gateway.js';
import type { RideRepository } from '../rides/ride.repository.js';
import type { RideStateMachine } from '../rides/ride-state-machine.js';
import type { RideRecord } from '../rides/ride.types.js';

/**
 * Fare negotiation.
 *
 * ## The one idea this rests on
 *
 * **A driver's bid IS their acceptance.** It is a binding commitment to carry
 * this trip at this price. The rider selecting a bid does not ask the driver
 * anything; it decides which existing commitment takes effect.
 *
 * That single decision is what keeps the rest of the system intact. Accepting a
 * bid takes the Redis claim on the winning driver's behalf and then runs
 * `REQUESTED -> OFFERED -> ACCEPTED` through `RideStateMachine`, unchanged, with
 * the driver as the actor on the accepting transition — because the driver is
 * genuinely the party who agreed. No new transition rule, and no second path to
 * acquire a driver.
 *
 * ## What actually enforces one-winner here, measured rather than assumed
 *
 * The claim is defence in depth on this path, not the guarantee. That was
 * established by deleting `withClaim` from `acceptBid` and re-running the
 * concurrency tests: **they all still passed.** Two different mechanisms were
 * already covering the two races:
 *
 *   - Several accepts on ONE ride are serialised by
 *     `UPDATE rides ... WHERE id = $1 AND status = $from` in `applyTransition`.
 *     The second UPDATE matches no row and the caller is refused.
 *   - The SAME driver accepted on two different rides at once is caught by the
 *     `rides_one_active_per_driver_uq` partial index, which surfaces here as a
 *     `ConflictProblem` rather than a 500.
 *
 * The claim is kept because it fails fast, because it covers the window before
 * the transaction opens, and because CLAUDE.md §5.1 requires it on any path
 * that assigns a driver. But it is written down here that correctness does not
 * rest on it — the database does. Believing the claim is load-bearing when it
 * is not is how someone later "simplifies" the index away and finds out.
 *
 * The alternative — a rider-initiated `REQUESTED -> ACCEPTED` rule — was
 * considered and rejected. It would mean two ways a ride can gain a driver, and
 * the two would have to agree forever about claims, about
 * `rides_one_active_per_driver_uq`, and about what a `ride_offers` row means.
 * They would not.
 *
 * ## Bids are archived, never edited
 *
 * A driver who bids again writes a new row and the old becomes SUPERSEDED. The
 * sequence of prices each side named is exactly what a fare dispute is argued
 * from, and an UPDATE destroys it. Same reasoning as the append-only ledger
 * (CLAUDE.md §6.3).
 *
 * ## Disabled by default
 *
 * `negotiation_enabled` is seeded false. With it false every method here
 * behaves as though the feature does not exist, and ride creation is untouched.
 */

export interface RideBidRecord {
  id: string;
  rideId: string;
  driverId: string;
  amountIqd: IqdAmount;
  status: 'ACTIVE' | 'SUPERSEDED' | 'WITHDRAWN' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
  etaSeconds: number | null;
  distanceM: number;
  createdAt: Date;
  expiresAt: Date;
}

interface BidRow {
  id: string;
  ride_id: string;
  driver_id: string;
  amount_iqd: string;
  status: RideBidRecord['status'];
  eta_seconds: number | null;
  distance_m: number;
  created_at: Date;
  expires_at: Date;
}

function toRecord(row: BidRow): RideBidRecord {
  return {
    id: row.id,
    rideId: row.ride_id,
    driverId: row.driver_id,
    amountIqd: parseIqdFromDb(row.amount_iqd),
    status: row.status,
    etaSeconds: row.eta_seconds,
    distanceM: row.distance_m,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export class NegotiationService {
  constructor(
    private readonly db: Database,
    private readonly rides: RideRepository,
    private readonly stateMachine: RideStateMachine,
    private readonly claims: RideClaimService,
    private readonly config: PlatformConfigService,
    private readonly capabilities: CapabilityService,
    private readonly clock: Clock,
    private readonly events?: RealtimeGateway,
    private readonly logger?: Logger,
  ) {}

  /** Whether the owner has switched negotiation on. */
  async isEnabled(q: Queryable = this.db): Promise<boolean> {
    return this.config.negotiationEnabled(q);
  }

  /**
   * Refuse everything when the feature is off.
   *
   * 404 rather than 403: a disabled feature should look absent, not forbidden.
   * A 403 tells a caller the endpoint exists and invites them to keep trying.
   */
  private async requireEnabled(q: Queryable = this.db): Promise<void> {
    if (!(await this.isEnabled(q))) throw new NotFoundProblem('Negotiation');
  }

  // -------------------------------------------------------------------------
  // Placing a bid
  // -------------------------------------------------------------------------

  /**
   * Place a bid, superseding this driver's previous one.
   *
   * The band check is not a nicety. Without a floor a driver bids 1 IQD, sorts
   * to the top of the rider's list, and renegotiates in the car with a
   * passenger who has nowhere else to go. The ceiling is symmetric and costs
   * nothing.
   */
  async placeBid(input: {
    rideId: string;
    driverId: string;
    amountIqd: number;
    etaSeconds?: number | null;
    distanceM: number;
  }): Promise<RideBidRecord> {
    await this.requireEnabled();

    // The full capability check, not just "is a driver" - a suspended or
    // unsubscribed driver must not be able to commit to a fare (CLAUDE.md §1.1).
    await this.capabilities.requireDriver(input.driverId);

    return this.db.transaction(async (tx) => {
      const ride = await this.rides.findByIdForUpdate(tx, input.rideId);
      if (!ride) throw new NotFoundProblem('Ride');

      // Only an unassigned ride is open for bids. A ride that has already been
      // matched is not a marketplace any more.
      if (ride.status !== 'REQUESTED') {
        throw new ConflictProblem('This ride is no longer accepting offers.');
      }

      const proposed = ride.proposedFareIqd;
      if (proposed === null) {
        throw new ConflictProblem('This ride was not opened for negotiation.');
      }

      await this.assertWithinBand(tx, input.amountIqd, proposed);

      // Supersede rather than update, so the price history survives.
      const previous = await tx.query<{ id: string }>(
        `UPDATE ride_bids
            SET status = 'SUPERSEDED', responded_at = now()
          WHERE ride_id = $1 AND driver_id = $2 AND status = 'ACTIVE'
        RETURNING id`,
        [input.rideId, input.driverId],
      );

      const windowSeconds = await this.config.negotiationWindowSeconds(tx);
      const expiresAt = new Date(this.clock.nowMs() + windowSeconds * 1_000);

      let inserted;
      try {
        inserted = await tx.query<BidRow>(
          `INSERT INTO ride_bids
             (ride_id, driver_id, amount_iqd, eta_seconds, distance_m, supersedes, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, ride_id, driver_id, amount_iqd, status, eta_seconds,
                     distance_m, created_at, expires_at`,
          [
            input.rideId,
            input.driverId,
            input.amountIqd,
            input.etaSeconds ?? null,
            input.distanceM,
            previous.rows[0]?.id ?? null,
            expiresAt,
          ],
        );
      } catch (error) {
        // The partial unique index is the backstop behind the UPDATE above. If
        // it fires, two requests from the same driver raced and both read no
        // active bid; the loser is told to retry rather than shown a 500.
        if (isUniqueViolationOn(error, 'ride_bids_one_active_per_driver_uq')) {
          throw new ConflictProblem('You already have an offer on this ride.');
        }
        throw error;
      }

      const bid = toRecord(inserted.rows[0]!);

      // The rider is watching a live list. Publishing after COMMIT, never
      // before - a bid the rider can see and the database does not have is the
      // bug `tx.onCommit` exists to prevent.
      if (this.events) {
        const publisher = this.events;
        tx.onCommit(async () => {
          try {
            await publisher.toRider(ride.riderId, {
              type: 'ride.bid',
              payload: {
                rideId: input.rideId,
                bidId: bid.id,
                amountIqd: bid.amountIqd,
                deltaIqd: bid.amountIqd - proposed,
                etaSeconds: bid.etaSeconds,
                expiresAt: bid.expiresAt.toISOString(),
              },
            } as never);
          } catch (error) {
            this.logger?.error(
              { event: 'realtime.bid_publish_failed', ride_id: input.rideId, err: error },
              'could not publish the bid to the rider',
            );
          }
        });
      }

      this.logger?.info(
        {
          event: 'ride.bid_placed',
          ride_id: input.rideId,
          // No amounts and no driver identity beyond the id: CLAUDE.md §9
          // forbids PII in logs, and a price is commercially sensitive.
          superseded: previous.rows.length > 0,
        },
        'driver placed a bid',
      );

      return bid;
    });
  }

  /**
   * The permitted distance from the rider's proposal.
   *
   * Basis points, matching `commission_bps` - one unit for proportions across
   * the system means one way to get them wrong. Rounding is applied to the
   * bounds rather than to the bid, so a driver is never told their own typed
   * figure is invalid because of arithmetic they cannot see.
   */
  private async assertWithinBand(
    q: Queryable,
    amountIqd: number,
    proposedIqd: IqdAmount,
  ): Promise<void> {
    // `iqd()` is the boundary: it rejects a float, a negative, a NaN and
    // anything past MAX_IQD, and brands what survives. Doing the check by hand
    // here would be a second set of money rules to keep in step with §6.
    try {
      iqd(amountIqd);
    } catch {
      throw new ValidationProblem([
        { path: 'amountIqd', message: 'The fare must be a whole number of dinars above zero.' },
      ]);
    }

    const bandBps = await this.config.negotiationBandBps(q);
    const spread = Math.round((proposedIqd * bandBps) / 10_000);
    const floor = Math.max(1, proposedIqd - spread);
    const ceiling = proposedIqd + spread;

    if (amountIqd < floor || amountIqd > ceiling) {
      throw new ValidationProblem([
        {
          path: 'amountIqd',
          message: `The fare must be between ${floor} and ${ceiling} dinars.`,
        },
      ]);
    }
  }

  // -------------------------------------------------------------------------
  // Reading bids
  // -------------------------------------------------------------------------

  /**
   * The rider's own list, cheapest first.
   *
   * Ordered in SQL by `(amount_iqd, created_at, id)` rather than in the client:
   * ties on price are broken by who bid first, which is both fair and stable.
   * An unstable sort would reorder the list under the rider's thumb as they
   * reach for a row — served by `ride_bids_ride_amount_idx`.
   */
  async listBidsForRider(rideId: string, riderId: string): Promise<RideBidRecord[]> {
    await this.requireEnabled();

    const ride = await this.db.query<{ rider_id: string }>(
      `SELECT rider_id FROM rides WHERE id = $1`,
      [rideId],
    );
    // 404 and not 403: a rider is not entitled to learn that someone else's
    // ride exists. Same rule as the offer IDOR guard.
    if (ride.rows[0]?.rider_id !== riderId) throw new NotFoundProblem('Ride');

    const rows = await this.db.query<BidRow>(
      `SELECT id, ride_id, driver_id, amount_iqd, status, eta_seconds,
              distance_m, created_at, expires_at
         FROM ride_bids
        WHERE ride_id = $1 AND status = 'ACTIVE' AND expires_at > now()
        ORDER BY amount_iqd ASC, created_at ASC, id ASC`,
      [rideId],
    );

    return rows.rows.map(toRecord);
  }

  // -------------------------------------------------------------------------
  // Accepting a bid
  // -------------------------------------------------------------------------

  /**
   * The rider selects a bid; the ride is assigned at that fare.
   *
   * Everything below runs inside `withClaim`, so the winning driver holds the
   * §5.1 claim for the whole assignment. Two riders racing for the same driver
   * cannot both succeed, and neither can two of the rider's own retries.
   */
  async acceptBid(rideId: string, bidId: string, riderId: string): Promise<RideRecord> {
    await this.requireEnabled();

    // Read the bid's driver before taking the claim, because the claim is keyed
    // on them. Read-only and outside the transaction; everything is re-checked
    // under FOR UPDATE below, so a bid that changes in between cannot slip
    // through - it fails the re-check.
    const preview = await this.db.query<{ driver_id: string }>(
      `SELECT driver_id FROM ride_bids WHERE id = $1 AND ride_id = $2`,
      [bidId, rideId],
    );
    const driverId = preview.rows[0]?.driver_id;
    if (!driverId) throw new NotFoundProblem('Bid');

    return this.claims.withClaim(rideId, driverId, () =>
      this.db.transaction(async (tx) => {
        const ride = await this.rides.findByIdForUpdate(tx, rideId);
        if (!ride) throw new NotFoundProblem('Ride');
        if (ride.riderId !== riderId) throw new NotFoundProblem('Ride');

        const bidResult = await tx.query<BidRow>(
          `SELECT id, ride_id, driver_id, amount_iqd, status, eta_seconds,
                  distance_m, created_at, expires_at
             FROM ride_bids
            WHERE id = $1 AND ride_id = $2
              FOR UPDATE`,
          [bidId, rideId],
        );
        const row = bidResult.rows[0];
        if (!row) throw new NotFoundProblem('Bid');

        const bid = toRecord(row);
        if (bid.status !== 'ACTIVE') {
          throw new ConflictProblem('That offer is no longer available.');
        }
        // A price quoted several minutes ago is not a price. Compared here
        // rather than trusted from `status`, because a status column needs a
        // sweep to stay true and between two runs of that sweep it is wrong.
        if (bid.expiresAt.getTime() <= this.clock.nowMs()) {
          throw new ConflictProblem('That offer has expired.');
        }

        // ---- REQUESTED -> OFFERED -------------------------------------------
        //
        // A real offer row is written, to this driver, so resync, history and
        // the existing driver-side machinery all see a ride that was offered in
        // the ordinary way. The bid is what makes it instantaneous.
        const offerDecision = this.stateMachine.validate({
          ride,
          to: 'OFFERED',
          actor: { type: 'SYSTEM' },
          metadata: { driverId, bidId, source: 'negotiation' },
        });
        const offered = await this.rides.applyTransition(tx, offerDecision);
        if (!offered) throw new InvalidRideTransitionError(ride.status, 'OFFERED');
        await this.rides.insertEvent(tx, offerDecision);

        await tx.query(
          `INSERT INTO ride_offers (ride_id, driver_id, status, distance_m, expires_at)
           VALUES ($1, $2, 'PENDING', $3, $4)
           ON CONFLICT (ride_id, driver_id) DO UPDATE
             SET status = 'PENDING', expires_at = EXCLUDED.expires_at`,
          [rideId, driverId, bid.distanceM, bid.expiresAt],
        );

        // ---- OFFERED -> ACCEPTED --------------------------------------------
        //
        // The actor is the DRIVER, and that is not a convenience.
        //
        // The state machine's rule for this transition requires the assigned
        // driver, and the driver genuinely is the party who agreed: their bid
        // was a binding commitment at this fare. The rider chose among
        // commitments; they did not make this one. Recording the rider here
        // would put a false actor in an append-only audit table that a fare
        // dispute is read from.
        //
        // `acceptedByRider` in the metadata records who selected it, so the
        // full story is still on the row.
        const acceptDecision = this.stateMachine.validate({
          ride: { ...offered, driverId },
          to: 'ACCEPTED',
          actor: { type: 'DRIVER', id: driverId },
          metadata: { bidId, acceptedByRider: riderId, agreedFareIqd: bid.amountIqd },
        });

        let accepted;
        try {
          accepted = await this.rides.applyTransition(tx, acceptDecision, {
            driverId,
            acceptedAt: this.clock.now(),
            agreedFareIqd: bid.amountIqd,
          });
        } catch (error) {
          // The database backstop behind the Redis claim. If this fires the
          // driver took another ride between the claim and here.
          if (isUniqueViolationOn(error, 'rides_one_active_per_driver_uq')) {
            throw new ConflictProblem('That driver has just taken another ride.');
          }
          throw error;
        }
        if (!accepted) throw new InvalidRideTransitionError(offered.status, 'ACCEPTED');
        await this.rides.insertEvent(tx, acceptDecision);

        // ---- Resolve every other bid ---------------------------------------
        //
        // One UPDATE for the winner and one for everyone else, both inside this
        // transaction. A losing bid left ACTIVE is a driver who can still be
        // shown as bidding on a ride that already has a driver.
        await tx.query(
          `UPDATE ride_bids SET status = 'ACCEPTED', responded_at = now() WHERE id = $1`,
          [bidId],
        );
        await tx.query(
          `UPDATE ride_bids
              SET status = 'REJECTED', responded_at = now()
            WHERE ride_id = $1 AND id <> $2 AND status = 'ACTIVE'`,
          [rideId, bidId],
        );
        await tx.query(
          `UPDATE ride_offers
              SET status = 'ACCEPTED', responded_at = now()
            WHERE ride_id = $1 AND driver_id = $2`,
          [rideId, driverId],
        );

        if (this.events) {
          const publisher = this.events;
          const losers = await tx.query<{ driver_id: string }>(
            `SELECT DISTINCT driver_id FROM ride_bids
              WHERE ride_id = $1 AND driver_id <> $2 AND status = 'REJECTED'`,
            [rideId, driverId],
          );

          tx.onCommit(async () => {
            try {
              await publisher.toDriver(driverId, {
                type: 'ride.bid_accepted',
                payload: { rideId, bidId, agreedFareIqd: bid.amountIqd },
              } as never);

              // Telling the losers is not a courtesy: a driver holding a stale
              // "waiting" screen will keep driving toward a pickup they did not
              // win.
              for (const loser of losers.rows) {
                await publisher.toDriver(loser.driver_id, {
                  type: 'ride.bid_rejected',
                  payload: { rideId },
                } as never);
              }
            } catch (error) {
              this.logger?.error(
                { event: 'realtime.bid_outcome_publish_failed', ride_id: rideId, err: error },
                'could not publish the bid outcome',
              );
            }
          });
        }

        this.logger?.info(
          { event: 'ride.bid_accepted', ride_id: rideId },
          'rider accepted a bid; ride assigned',
        );

        return accepted;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

  /**
   * Expire bids whose window has closed.
   *
   * Run from the offer sweep worker. Returns the number expired, so the caller
   * can log a number rather than a guess.
   */
  async expireStaleBids(): Promise<number> {
    const result = await this.db.query(
      `UPDATE ride_bids
          SET status = 'EXPIRED', responded_at = now()
        WHERE status = 'ACTIVE' AND expires_at <= now()`,
    );
    return result.rowCount;
  }
}
