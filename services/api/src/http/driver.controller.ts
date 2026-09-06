import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import type { AuthenticatedUser } from '../auth/auth.service.js';
import { ConflictProblem, DriverNotCompliantProblem, NotFoundProblem,
  DriverModeUnavailableProblem,
} from '../common/problem.js';
import { DATABASE, type Database } from '../db/db.port.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { DriverPresenceService } from '../matching/driver-presence.service.js';
import { MatchingService } from '../matching/matching.service.js';
import { RideService } from '../rides/ride.service.js';
import type { Actor } from '../rides/ride.types.js';
import { CurrentActor, CurrentUser, Roles } from './auth.guard.js';
import { RateLimit } from './rate-limit.js';
import { presentLedgerEntry, presentRide } from './presenters.js';
import {
  CompleteRideSchema as CompleteBodySchema,
  PaginationSchema,
  ReportLocationSchema,
  SetAvailabilitySchema,
  StartCheckoutSchema,
  UuidSchema,
} from './schemas.js';
import { QueueRegistry } from '../queue/queues.js';
import { requireUuid } from './rides.controller.js';
import { decodeKeysetCursor, nextKeysetCursor } from './cursor.js';
import { DriverComplianceService } from '../compliance/driver-compliance.service.js';
import { CapabilityService } from '../capabilities/capability.service.js';
import { GatewayPaymentService } from '../payments/gateway-payment.service.js';
import { SubscriptionService } from '../subscriptions/subscription.service.js';
import { zodBody, zodParam } from './zod.pipe.js';

/** Driver-side endpoints. Every path is in `docs/api-contract.yaml`. */
@Controller()
@Roles('DRIVER')
export class DriverController {
  constructor(
    private readonly rides: RideService,
    private readonly matching: MatchingService,
    private readonly presence: DriverPresenceService,
    private readonly ledger: LedgerService,
    private readonly compliance: DriverComplianceService,
    private readonly capabilities: CapabilityService,
    private readonly subscriptions: SubscriptionService,
    private readonly gateway: GatewayPaymentService,
    private readonly queues: QueueRegistry,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  @Put('driver/availability')
  @HttpCode(200)
  async setAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(SetAvailabilitySchema)) body: SetAvailabilityBody,
  ) {
    if (body.availability === 'OFFLINE') {
      // A driver mid-trip cannot vanish: the rider is in their car.
      const active = await this.db.query(
        `SELECT 1 FROM rides
          WHERE driver_id = $1 AND status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')
          LIMIT 1`,
        [user.id],
      );
      if (active.rowCount > 0) {
        throw new ConflictProblem('Finish or cancel your current ride before going offline.');
      }

      await this.presence.goOffline(user.id);
      await this.db.query(
        `UPDATE drivers SET availability = 'OFFLINE', updated_at = now() WHERE user_id = $1`,
        [user.id],
      );

      // D-13. Going offline releases any offer this driver is holding.
      //
      // Without this, a driver could go offline - which deletes their Redis
      // presence - and still accept the offer afterwards, leaving the rider
      // with an assigned driver whose location is not in Redis at all
      // (CLAUDE.md §3.1 makes Redis the source of truth for location). The
      // rider's tracking screen would simply stay empty.
      //
      // It also costs the rider real time: the offer would otherwise sit with
      // an absent driver for the full timeout before the next candidate is
      // tried.
      //
      // Treated as a decline rather than a new outcome type, because that is
      // exactly what it is - the driver is not taking this ride - and it
      // reuses the dispatch path that is already tested. Ordered AFTER
      // goOffline so the re-dispatch cannot pick this driver again.
      const outstanding = await this.matching.currentOfferFor(user.id);
      if (outstanding) {
        await this.matching.handleOfferOutcome(outstanding, 'declined');
      }
    } else {
      // Checked BEFORE presence is written. Going online first and refusing
      // afterwards would leave the driver in the Redis geo set - matchable, and
      // holding a slot no dispatch can use.
      //
      // The full capability check, not documents alone (CLAUDE.md §1.1). With
      // rider and driver in one app, "may this account drive" has six
      // conditions - banned, driver row, approval, suspension, documents,
      // subscription - and this endpoint is where a client that flipped its own
      // mode arrives. Checking only documents here was correct while the driver
      // app was a separate binary that only approved drivers were given; it is
      // not correct now.
      //
      // DOCUMENTS_INCOMPLETE keeps its existing 422 shape so the driver app's
      // current handling still works; everything else is a 403.
      const capability = await this.capabilities.evaluate(user.id, this.db);
      if (!capability.driver.allowed) {
        if (capability.driver.blockers.includes('DOCUMENTS_INCOMPLETE')) {
          throw new DriverNotCompliantProblem(
            capability.driver.missingDocuments,
            capability.driver.expiredDocuments,
            capability.driver.rejectedDocuments,
          );
        }
        throw new DriverModeUnavailableProblem(
          capability.driver.blockers,
          capability.driver.suspendedReason,
        );
      }

      await this.presence.goOnline(user.id, { ...body.position!, recordedAt: new Date() });
      await this.db.query(
        `UPDATE drivers SET availability = 'ONLINE', updated_at = now()
          WHERE user_id = $1 AND availability <> 'ON_TRIP'`,
        [user.id],
      );
    }

    return this.driverState(user.id);
  }

  /**
   * CLAUDE.md §3.1 - Redis only, never Postgres on the request path.
   *
   * 202 rather than 200: the caller must not wait on durability, and the
   * driver app retries from its own buffer if this never lands.
   */
  @Post('driver/location')
  // The highest-volume endpoint in the system. The app samples every 5s and
  // flushes every 15s, so ~4/minute is normal - but a driver reconnecting
  // after a long dead zone flushes a large backlog in several batches, and
  // throttling that would discard exactly the data CLAUDE.md 5.3 preserves.
  // Set well above the honest ceiling; this is an abuse guard, not a shaper.
  @RateLimit({ limit: 120, windowSeconds: 60, by: 'user', tier: 'OPERATIONAL' })
  @HttpCode(202)
  async reportLocation(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(ReportLocationSchema)) body: ReportLocationBody,
  ) {
    const accepted = await this.presence.recordBatch(
      user.id,
      body.samples.map((sample) => ({
        lat: sample.lat,
        lng: sample.lng,
        accuracyM: sample.accuracyM,
        headingDeg: sample.headingDeg,
        speedMps: sample.speedMps,
        recordedAt: sample.recordedAt,
      })),
    );

    return { accepted, rejected: body.samples.length - accepted };
  }

  /**
   * Polling fallback for when push delivery failed. The driver app must not
   * depend solely on FCM arriving.
   */
  @Get('driver/offers/current')
  // The driver app polls this every few seconds while online.
  @RateLimit({ limit: 60, windowSeconds: 60, by: 'user', tier: 'OPERATIONAL' })
  async currentOffer(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) response: Response,
  ) {
    const rideId = await this.matching.currentOfferFor(user.id);
    if (!rideId) {
      response.status(204);
      return undefined;
    }

    const offer = await this.db.query<{
      id: string; distance_m: number; expires_at: Date;
    }>(
      `SELECT id, distance_m, expires_at FROM ride_offers
        WHERE ride_id = $1 AND driver_id = $2 AND status = 'PENDING'`,
      [rideId, user.id],
    );
    const row = offer.rows[0];
    if (!row) {
      response.status(204);
      return undefined;
    }

    const ride = await this.rides.getRideFor(rideId, actor);

    return {
      offerId: row.id,
      rideId,
      pickup: { lat: ride.pickupLat, lng: ride.pickupLng },
      pickupAddress: ride.pickupAddress,
      dropoff: { lat: ride.dropoffLat, lng: ride.dropoffLng },
      dropoffAddress: ride.dropoffAddress,
      estimatedFareIqd: ride.estimatedFareIqd,
      distanceM: row.distance_m,
      expiresAt: row.expires_at.toISOString(),
    };
  }

  /**
   * CLAUDE.md §5.1 - exactly one concurrent caller can succeed.
   *
   * ## The capability check, and where it deliberately stops
   *
   * §1.1 says the server checks on every driver-scoped call. That was true of
   * two: going online, and placing a bid. Accepting a ride - the moment a
   * driver takes on new work and a rider starts waiting for them - was not
   * checked at all, so a client that had gone online before a suspension, or
   * one that never called `PUT /driver/availability` in the first place, could
   * accept. Going online is not a gate a determined client has to pass through.
   *
   * The check does NOT extend to `arrived`, `start` or `complete`, and that is
   * a decision rather than an omission. Those are transitions on work already
   * accepted, with a rider in the car. Refusing `complete` because a
   * subscription lapsed mid-trip would strand the rider AND block settlement,
   * so the platform would lose the fare to enforce a rule about the next fare.
   * The gate belongs where new work is taken on, not on the way out of work
   * already underway.
   *
   * Checked BEFORE the Redis claim. Claiming first and refusing after would
   * burn the claim on a driver who may not have it, and every other candidate
   * would get 409 for a ride nobody won.
   */
  @Post('rides/:rideId/accept')
  // A driver racing for a ride may legitimately tap more than once. The Redis
  // claim decides the winner; this only stops a scripted flood.
  @RateLimit({ limit: 60, windowSeconds: 60, by: 'user', tier: 'STANDARD' })
  @HttpCode(200)
  async accept(@CurrentUser() user: AuthenticatedUser, @Param('rideId') rideId: string) {
    await this.capabilities.requireDriver(user.id);
    const ride = await this.rides.acceptRide(requireUuid(rideId), user.id);
    return presentRide(ride);
  }

  @Post('rides/:rideId/decline')
  @HttpCode(204)
  async decline(@CurrentUser() user: AuthenticatedUser, @Param('rideId') rideId: string) {
    const id = requireUuid(rideId);

    // A driver may only decline an offer that is actually theirs.
    const offered = await this.matching.currentOfferFor(user.id);
    if (offered !== id) throw new NotFoundProblem('Offer');

    await this.matching.handleOfferOutcome(id, 'declined');
  }

  @Post('rides/:rideId/arrived')
  @HttpCode(200)
  async arrived(@CurrentActor() actor: Actor, @Param('rideId') rideId: string) {
    return presentRide(await this.rides.markArrived(requireUuid(rideId), actor));
  }

  @Post('rides/:rideId/start')
  @HttpCode(200)
  async start(@CurrentActor() actor: Actor, @Param('rideId') rideId: string) {
    return presentRide(await this.rides.startRide(requireUuid(rideId), actor));
  }

  @Post('rides/:rideId/complete')
  // CRITICAL, not STANDARD: completion settles the fare and writes
  // ledger entries. Anything that moves money degrades rather than
  // fails open when Redis is unreachable.
  @RateLimit({ limit: 60, windowSeconds: 60, by: 'user', tier: 'CRITICAL' })
  @HttpCode(200)
  async complete(
    @CurrentActor() actor: Actor,
    @Param('rideId') rideId: string,
    @Body(zodBody(CompleteBodySchema)) body: { actualDistanceM?: number },
  ) {
    const id = requireUuid(rideId);
    const { ride, ledgerTransactionId } = await this.rides.completeRide(
      id,
      actor,
      body.actualDistanceM ?? null,
    );

    const payment = await this.db.query<{
      id: string; status: string; amount_iqd: string; confirmed_at: Date | null;
    }>(`SELECT id, status, amount_iqd, confirmed_at FROM payments WHERE ride_id = $1`, [id]);
    const row = payment.rows[0];

    return {
      ride: presentRide(ride),
      payment: row
        ? {
            id: row.id,
            provider: 'CASH',
            status: row.status,
            amountIqd: Number(row.amount_iqd),
            confirmedAt: row.confirmed_at?.toISOString() ?? null,
          }
        : null,
      ledgerTransactionId,
    };
  }

  /** CLAUDE.md §6.4 - derived from the ledger, never a stored counter. */
  @Get('driver/wallet')
  async wallet(@CurrentUser() user: AuthenticatedUser) {
    return {
      driverId: user.id,
      balanceIqd: await this.ledger.balanceFor(this.db, user.id),
    };
  }

  @Get('driver/wallet/entries')
  async walletEntries(
    @CurrentUser() user: AuthenticatedUser,
    @Query(zodBody(PaginationSchema)) query: { limit: number; cursor?: string },
  ) {
    const entries = await this.ledger.entriesFor(this.db, user.id, {
      limit: query.limit,
      ...(query.cursor ? { after: decodeKeysetCursor(query.cursor) } : {}),
    });

    return {
      items: entries.map(presentLedgerEntry),
      // The id of the last row, not its timestamp: see http/cursor.ts for the
      // three ways the timestamp version lost a driver's entries.
      nextCursor: nextKeysetCursor(entries, query.limit),
    };
  }

  private async driverState(driverId: string) {
    const result = await this.db.query<{
      availability: string; is_suspended: boolean;
      vehicle_plate: string; vehicle_model: string; vehicle_color: string;
    }>(
      `SELECT availability, is_suspended, vehicle_plate, vehicle_model, vehicle_color
         FROM drivers WHERE user_id = $1`,
      [driverId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundProblem('Driver');

    return {
      availability: row.availability,
      isSuspended: row.is_suspended,
      vehicle: {
        plate: row.vehicle_plate,
        model: row.vehicle_model,
        color: row.vehicle_color,
      },
    };
  }

  /**
   * The plans a driver may buy.
   *
   * Readable whether or not `subscription_required` is on. A driver should be
   * able to see what a subscription costs before it gates anything, and hiding
   * the price until the moment it blocks them is how a gate reads as a
   * punishment rather than a term.
   */
  @Get('driver/subscription/plans')
  async listPlans(@CurrentUser() _user: AuthenticatedUser) {
    return { plans: await this.subscriptions.listPlans(this.db) };
  }

  /**
   * Start paying for a subscription through the live rail.
   *
   * Returns immediately with a reference and NO link. Creating the link is a
   * foreign HTTP round trip and CLAUDE.md §3.2 keeps it off the request path;
   * a job does it and the app learns the URL by polling the reference below.
   *
   * That looks like an extra step and it is the difference between a slow
   * provider costing one driver a few seconds and a slow provider holding a
   * connection-pool slot per waiting driver on a 4-core VPS (§3.3).
   */
  @Post('driver/subscription/checkout')
  @RateLimit({ limit: 10, windowSeconds: 3_600, by: 'user', tier: 'CRITICAL' })
  @HttpCode(201)
  async startCheckout(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(StartCheckoutSchema)) body: { planCode: string },
  ) {
    const checkout = await this.gateway.openCheckout({
      userId: user.id,
      planCode: body.planCode,
    });

    await this.queues.enqueueGatewayCheckout({
      reference: checkout.reference,
      amountIqd: checkout.amountIqd,
      description: `ALY subscription ${checkout.planCode ?? ''}`.trim(),
    });

    return presentCheckout(checkout);
  }

  /**
   * Where a checkout got to.
   *
   * Reads ALY's own row, never the provider. Letting a driver's refresh button
   * generate outbound traffic to a third party is how a stuck screen becomes a
   * rate-limit ban on the whole platform.
   */
  @Get('driver/subscription/checkout/:reference')
  async getCheckout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('reference', zodParam(UuidSchema)) reference: string,
  ) {
    const found = await this.gateway.findForUser(user.id, reference);
    // 404 for someone else's reference as well as for one that does not exist -
    // the same rule that stops a rider enumerating other riders' rides.
    if (!found) throw new NotFoundProblem('Checkout');
    return presentCheckout(found);
  }

  /**
   * The caller's own live period, or null.
   *
   * Scoped to the authenticated user and not to a path parameter: there is no
   * driver id to pass, so there is no id to tamper with. `@Roles('DRIVER')` on
   * the class is what keeps a rider out.
   */
  @Get('driver/subscription')
  async getMySubscription(@CurrentUser() user: AuthenticatedUser) {
    return await this.subscriptions.currentFor(this.db, user.id);
  }
}

interface SetAvailabilityBody {
  availability: 'ONLINE' | 'OFFLINE';
  position?: { lat: number; lng: number } | undefined;
}

interface ReportLocationBody {
  samples: Array<{
    lat: number;
    lng: number;
    accuracyM?: number | undefined;
    headingDeg?: number | undefined;
    speedMps?: number | undefined;
    recordedAt: Date;
  }>;
}

/** Dates as ISO strings; money as a plain integer. */
function presentCheckout(c: {
  reference: string;
  status: string;
  amountIqd: number;
  planCode: string | null;
  checkoutUrl: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  settledAt: Date | null;
}) {
  return {
    reference: c.reference,
    status: c.status,
    amountIqd: c.amountIqd,
    planCode: c.planCode,
    checkoutUrl: c.checkoutUrl,
    expiresAt: c.expiresAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    settledAt: c.settledAt?.toISOString() ?? null,
  };
}
