import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import type { AuthenticatedUser } from '../auth/auth.service.js';
import { ConflictProblem, NotFoundProblem, ValidationProblem } from '../common/problem.js';
import { DATABASE, type Database } from '../db/db.port.js';
import { FareCalculator } from '../fare/fare-calculator.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { PlatformConfigService } from '../platform-config/platform-config.service.js';
import { RideService } from '../rides/ride.service.js';
import type { Actor, RideRecord } from '../rides/ride.types.js';
import { CurrentActor, CurrentUser, Roles } from './auth.guard.js';
import { RateLimit } from './rate-limit.js';
import { presentRide, type CounterpartyRow, type RidePresentation } from './presenters.js';
import {
  CancelRideSchema,
  CreateRideSchema,
  FareEstimateSchema,
  IdempotencyKeySchema,
  ListRidesQuerySchema,
  RateRideSchema,
  UuidSchema,
} from './schemas.js';
import { decodeKeysetCursor, nextKeysetCursor } from './cursor.js';
import { RideDispatcher } from '../matching/ride-dispatcher.js';
import { zodBody } from './zod.pipe.js';

/**
 * Every path here is in `docs/api-contract.yaml` (CLAUDE.md §12.1).
 *
 * The controllers are deliberately thin. Authorisation, state transitions and
 * money all live in the domain services; a controller that made its own
 * decision about who may do what would be a second place for those rules to
 * live, and the two would drift.
 */
@Controller()
export class RidesController {
  constructor(
    private readonly rides: RideService,
    private readonly fare: FareCalculator,
    private readonly config: PlatformConfigService,
    private readonly idempotency: IdempotencyService,
    private readonly dispatcher: RideDispatcher,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  @Post('fare/estimate')
  // Cheap but not free: it reads config and does trigonometry. A rider
  // dragging a pin fires several per second, so the limit sits above that.
  @RateLimit({ limit: 60, windowSeconds: 60, by: 'user', tier: 'STANDARD' })
  @HttpCode(200)
  async estimate(@Body(zodBody(FareEstimateSchema)) body: { pickup: LatLng; dropoff: LatLng }) {
    const tariff = await this.config.tariff(this.db);
    const quote = this.fare.quoteForTrip(tariff, body.pickup, body.dropoff);

    return {
      estimatedFareIqd: quote.totalIqd,
      distanceM: quote.distanceM,
      durationS: quote.durationS,
      breakdown: quote.breakdown,
    };
  }

  /**
   * CLAUDE.md §5.2 - `Idempotency-Key` is REQUIRED.
   *
   * A replay returns the ORIGINAL ride with 200; a fresh request returns 201.
   * The status code is the only difference, exactly as the contract specifies,
   * so a client can tell them apart without guessing.
   */
  @Post('rides')
  @Roles('RIDER')
  // Deliberately generous: CLAUDE.md 5.2 REQUIRES the app to retry with the
  // same Idempotency-Key on a dropped response, and a tight limit here would
  // punish exactly the behaviour the constitution mandates. The idempotency
  // layer - not this limit - is what stops duplicate rides.
  @RateLimit({ limit: 20, windowSeconds: 60, by: 'user', tier: 'STANDARD' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(zodBody(CreateRideSchema)) body: CreateRideBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RidePresentation> {
    const key = IdempotencyKeySchema.safeParse(idempotencyKey);
    if (!key.success) {
      throw new ValidationProblem([
        {
          path: 'Idempotency-Key',
          message: 'A UUID Idempotency-Key header is required (CLAUDE.md 5.2).',
        },
      ]);
    }

    const outcome = await this.idempotency.run(
      this.db,
      { userId: user.id, endpoint: 'POST /rides', key: key.data, body },
      async () => {
        const ride = await this.rides.createRide({
          riderId: user.id,
          pickup: body.pickup,
          pickupAddress: body.pickupAddress ?? null,
          dropoff: body.dropoff,
          dropoffAddress: body.dropoffAddress ?? null,
          proposedFareIqd: body.proposedFareIqd ?? null,
        });
        return { status: 201, value: presentRide(ride) };
      },
    );

    // Dispatch the ride.
    //
    // Nothing did this. `POST /rides` created a ride, returned 201, and no
    // driver was ever offered it - the ride sat in REQUESTED while the rider's
    // screen polled "searching" forever. MatchingService.dispatch was called
    // only from matching's own re-dispatch path and from tests.
    //
    // Only on a FRESH ride: an idempotent replay must not dispatch a second
    // time, which would offer one ride to two drivers.
    if (outcome.fresh) {
      await this.dispatcher.dispatch(outcome.value.id);
    }

    response.status(outcome.fresh ? 201 : 200);
    return outcome.value;
  }

  @Get('rides/me')
  async listMine(
    @CurrentActor() actor: Actor,
    @Query(zodBody(ListRidesQuerySchema)) query: ListRidesQuery,
  ) {
    const rides = await this.rides.listMyRides(actor, {
      limit: query.limit,
      ...(query.status ? { status: query.status } : {}),
      ...(query.cursor ? { after: decodeKeysetCursor(query.cursor) } : {}),
    });

    const items = await Promise.all(rides.map((ride) => this.withCounterparties(ride, actor)));

    return {
      items,
      nextCursor: nextKeysetCursor(rides, query.limit),
    };
  }

  @Get('rides/:rideId')
  // Polled by the rider for the whole of a ride. OPERATIONAL: refusing it
  // during a Redis outage would blank the tracking screen mid-ride.
  @RateLimit({ limit: 120, windowSeconds: 60, by: 'user', tier: 'OPERATIONAL' })
  async getOne(@CurrentActor() actor: Actor, @Param('rideId') rideId: string) {
    const id = UuidSchema.safeParse(rideId);
    // A malformed id is answered 404 rather than 422, for the same reason a
    // ride belonging to someone else is: neither should confirm what exists.
    if (!id.success) throw new NotFoundProblem('Ride');

    const ride = await this.rides.getRideFor(id.data, actor);
    return this.withCounterparties(ride, actor);
  }

  @Post('rides/:rideId/cancel')
  @HttpCode(200)
  async cancel(
    @CurrentActor() actor: Actor,
    @Param('rideId') rideId: string,
    @Body(zodBody(CancelRideSchema)) body: { reason?: string },
  ) {
    const ride = await this.rides.cancelRide(requireUuid(rideId), actor, body.reason);
    return this.withCounterparties(ride, actor);
  }

  @Post('rides/:rideId/rate')
  @HttpCode(201)
  async rate(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentActor() actor: Actor,
    @Param('rideId') rideId: string,
    @Body(zodBody(RateRideSchema)) body: { score: number; comment?: string },
  ) {
    const id = requireUuid(rideId);
    const ride = await this.rides.getRideFor(id, actor);

    if (ride.status !== 'COMPLETED') {
      throw new ConflictProblem('Only a completed ride can be rated.');
    }

    // The person being rated is the OTHER party, derived from the ride rather
    // than taken from the request - otherwise a rider could rate anyone.
    const rateeId = actor.type === 'RIDER' ? ride.driverId : ride.riderId;
    if (!rateeId) throw new ConflictProblem('This ride has no counterparty to rate.');

    return this.db.transaction(async (tx) => {
      const inserted = await tx.query<{ id: string; created_at: Date }>(
        `INSERT INTO ratings (ride_id, rater_id, ratee_id, score, comment)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (ride_id, rater_id) DO NOTHING
         RETURNING id, created_at`,
        [id, user.id, rateeId, body.score, body.comment ?? null],
      );

      const row = inserted.rows[0];
      if (!row) throw new ConflictProblem('You have already rated this ride.');

      // Denormalised counters on the counterparty, updated in the same
      // transaction so an average can never reflect a rating that rolled back.
      const table = actor.type === 'RIDER' ? 'drivers' : 'riders';
      await tx.query(
        `UPDATE ${table} SET rating_sum = rating_sum + $1, rating_count = rating_count + 1
          WHERE user_id = $2`,
        [body.score, rateeId],
      );

      return {
        id: row.id,
        rideId: id,
        score: body.score,
        comment: body.comment ?? null,
        createdAt: row.created_at.toISOString(),
      };
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Attach the counterparty, and ONLY the counterparty.
   *
   * A rider sees the driver; a driver sees the rider. Neither ever receives the
   * other's phone number, because `presentPublicUser` has no field for one.
   */
  private async withCounterparties(ride: RideRecord, actor: Actor): Promise<RidePresentation> {
    const counterparties: { rider?: CounterpartyRow; driver?: CounterpartyRow } = {};

    if (actor.type !== 'DRIVER' && ride.driverId) {
      const driver = await this.loadDriver(ride.driverId);
      if (driver) counterparties.driver = driver;
    }

    if (actor.type !== 'RIDER') {
      const rider = await this.loadRider(ride.riderId);
      if (rider) counterparties.rider = rider;
    }

    return presentRide(ride, counterparties);
  }

  private async loadDriver(driverId: string): Promise<CounterpartyRow | undefined> {
    const result = await this.db.query<CounterpartyRow>(
      `SELECT u.id, u.display_name, d.rating_sum, d.rating_count,
              d.vehicle_plate, d.vehicle_model, d.vehicle_color
         FROM users u JOIN drivers d ON d.user_id = u.id
        WHERE u.id = $1`,
      [driverId],
    );
    return result.rows[0];
  }

  private async loadRider(riderId: string): Promise<CounterpartyRow | undefined> {
    const result = await this.db.query<CounterpartyRow>(
      `SELECT u.id, u.display_name, r.rating_sum, r.rating_count
         FROM users u JOIN riders r ON r.user_id = u.id
        WHERE u.id = $1`,
      [riderId],
    );
    return result.rows[0];
  }
}

interface LatLng {
  lat: number;
  lng: number;
}

interface CreateRideBody {
  pickup: LatLng;
  pickupAddress?: string | undefined;
  dropoff: LatLng;
  dropoffAddress?: string | undefined;
  paymentMethod: 'CASH';
  proposedFareIqd?: number | undefined;
}

interface ListRidesQuery {
  status?: RideRecord['status'] | undefined;
  limit: number;
  cursor?: string | undefined;
}

export function requireUuid(value: string): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) throw new NotFoundProblem('Ride');
  return parsed.data;
}
