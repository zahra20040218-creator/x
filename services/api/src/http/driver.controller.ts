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
import { ConflictProblem, NotFoundProblem } from '../common/problem.js';
import { DATABASE, type Database } from '../db/db.port.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { DriverPresenceService } from '../matching/driver-presence.service.js';
import { MatchingService } from '../matching/matching.service.js';
import { RideService } from '../rides/ride.service.js';
import type { Actor } from '../rides/ride.types.js';
import { CurrentActor, CurrentUser, Roles } from './auth.guard.js';
import { presentLedgerEntry, presentRide } from './presenters.js';
import {
  CompleteRideSchema as CompleteBodySchema,
  PaginationSchema,
  ReportLocationSchema,
  SetAvailabilitySchema,
} from './schemas.js';
import { requireUuid } from './rides.controller.js';
import { zodBody } from './zod.pipe.js';

/** Driver-side endpoints. Every path is in `docs/api-contract.yaml`. */
@Controller()
@Roles('DRIVER')
export class DriverController {
  constructor(
    private readonly rides: RideService,
    private readonly matching: MatchingService,
    private readonly presence: DriverPresenceService,
    private readonly ledger: LedgerService,
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
    } else {
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

  /** CLAUDE.md §5.1 - exactly one concurrent caller can succeed. */
  @Post('rides/:rideId/accept')
  @HttpCode(200)
  async accept(@CurrentUser() user: AuthenticatedUser, @Param('rideId') rideId: string) {
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
      ...(query.cursor ? { before: new Date(query.cursor) } : {}),
    });
    const last = entries.at(-1);

    return {
      items: entries.map(presentLedgerEntry),
      nextCursor: entries.length === query.limit && last ? last.createdAt.toISOString() : null,
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
