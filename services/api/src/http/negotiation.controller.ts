import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.service.js';
import { NotFoundProblem } from '../common/problem.js';
import { DATABASE, type Database } from '../db/db.port.js';
import { NegotiationService, type RideBidRecord } from '../negotiation/negotiation.service.js';
import { RideRepository } from '../rides/ride.repository.js';
import { CurrentUser, Roles } from './auth.guard.js';
import { presentRide } from './presenters.js';
import { RateLimit } from './rate-limit.js';
import { PlaceBidSchema, UuidSchema } from './schemas.js';
import { zodBody } from './zod.pipe.js';

/**
 * Fare negotiation: a rider proposes, drivers bid, the rider picks one.
 *
 * ## Why this file did not exist
 *
 * `NegotiationService` was written, tested and registered in NO module, and
 * exposed by no controller. Meanwhile `docs/api-contract.yaml` has documented
 * all three of these paths since migration 0012. The repository therefore had a
 * published contract promising endpoints that returned 404, and 600 lines of
 * unreachable service behind them - dead code, which CLAUDE.md §12.7 forbids,
 * with the added hazard that its integration tests self-skipped so nothing
 * reported the gap.
 *
 * Two honest options existed: delete it, or connect it. Connecting it is right
 * because the feature is IN scope (§2 SCOPE EXPANSION, 2026-08-25) and because
 * `negotiation_enabled` ships FALSE - so wiring it changes nothing for anyone
 * until an owner turns it on, and every method here answers 501 until then via
 * `requireEnabled`.
 *
 * ## Where the authorisation lives
 *
 * In the service, not here. `placeBid` calls `capabilities.requireDriver`
 * itself, and `listBidsForRider`/`acceptBid` check ride ownership against the
 * database. This controller must not re-derive any of that: two places deciding
 * who may bid is how they come to disagree.
 *
 * ## §5.1 still governs who gets the ride
 *
 * Accepting a bid takes the same Redis claim as ordinary dispatch. Bidding
 * changes how a driver is CHOSEN, never how the ride is claimed.
 */
@Controller()
export class NegotiationController {
  constructor(
    private readonly negotiation: NegotiationService,
    private readonly rides: RideRepository,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  /**
   * The bids on the rider's own ride, with what they proposed.
   *
   * Rider-scoped. A driver seeing the other bids would turn an auction into a
   * race to undercut, which is a different product and not the one specified.
   */
  @Get('rides/:rideId/bids')
  @Roles('RIDER')
  async listBids(
    @CurrentUser() user: AuthenticatedUser,
    @Param('rideId') rideId: string,
  ) {
    const id = UuidSchema.parse(rideId);
    const bids = await this.negotiation.listBidsForRider(id, user.id);

    // The proposal is returned alongside, because a list of bids with nothing
    // to compare them against is not a decision the rider can make.
    const ride = await this.rides.findById(this.db, id);
    if (!ride) throw new NotFoundProblem('Ride');

    return {
      proposedFareIqd: ride.proposedFareIqd,
      bids: bids.map(presentBid),
    };
  }

  /**
   * A driver's offer on a ride that is open for bids.
   *
   * 201 rather than 200: this creates a bid. A repeat from the same driver
   * supersedes their previous one in the service rather than stacking, so the
   * rider never sees one driver twice.
   */
  @Post('rides/:rideId/bids')
  @Roles('DRIVER')
  // Bidding is cheap for a driver and expensive for the rider's screen. This
  // bounds a client that re-bids on every keystroke.
  @RateLimit({ limit: 60, windowSeconds: 60, by: 'user', tier: 'STANDARD' })
  @HttpCode(201)
  async placeBid(
    @CurrentUser() user: AuthenticatedUser,
    @Param('rideId') rideId: string,
    @Body(zodBody(PlaceBidSchema))
    body: { amountIqd: number; etaSeconds?: number; distanceM?: number },
  ) {
    const bid = await this.negotiation.placeBid({
      rideId: UuidSchema.parse(rideId),
      driverId: user.id,
      amountIqd: body.amountIqd,
      etaSeconds: body.etaSeconds ?? null,
      // Zero when the client does not measure it. The service stores it for
      // ranking; a missing distance must not refuse an otherwise valid bid.
      distanceM: body.distanceM ?? 0,
    });

    return presentBid(bid);
  }

  /**
   * The rider picks a bid, and the ride is assigned to that driver.
   *
   * Returns the RIDE, not the bid: the rider's next screen is the trip, and the
   * accepted bid's amount is already on the ride as `agreedFareIqd`.
   */
  @Post('rides/:rideId/bids/:bidId/accept')
  @Roles('RIDER')
  @HttpCode(200)
  async acceptBid(
    @CurrentUser() user: AuthenticatedUser,
    @Param('rideId') rideId: string,
    @Param('bidId') bidId: string,
  ) {
    const ride = await this.negotiation.acceptBid(
      UuidSchema.parse(rideId),
      UuidSchema.parse(bidId),
      user.id,
    );
    return presentRide(ride);
  }

}

/** Dates as ISO strings; amounts as plain integers. */
function presentBid(bid: RideBidRecord) {
  return {
    id: bid.id,
    rideId: bid.rideId,
    driverId: bid.driverId,
    amountIqd: bid.amountIqd,
    status: bid.status,
    etaSeconds: bid.etaSeconds,
    distanceM: bid.distanceM,
    createdAt: bid.createdAt.toISOString(),
    expiresAt: bid.expiresAt.toISOString(),
  };
}
