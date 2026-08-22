import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';

import type { AuthenticatedUser } from '../auth/auth.service.js';
import { normalizeIraqiPhone, InvalidPhoneNumberError } from '../auth/phone.js';
import { ConflictProblem, NotFoundProblem, ValidationProblem } from '../common/problem.js';
import { DATABASE, isUniqueViolationOn, type Database } from '../db/db.port.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { iqd, signedIqd } from '../money/iqd.js';
import { PlatformConfigService, type ConfigKey } from '../platform-config/platform-config.service.js';
import { RideRepository } from '../rides/ride.repository.js';
import { CurrentUser, Roles } from './auth.guard.js';
import { presentLedgerEntry, presentRide } from './presenters.js';
import { requireUuid } from './rides.controller.js';
import {
  CreateDriverSchema,
  IdempotencyKeySchema,
  PaginationSchema,
  ResolveDisputeSchema,
  TopUpWalletSchema,
  UpdateConfigSchema,
  UpdateDriverSchema,
} from './schemas.js';
import { zodBody } from './zod.pipe.js';

/**
 * Admin API. Every path is in `docs/api-contract.yaml`.
 *
 * This is the one place phone numbers are returned for OTHER users, which is
 * why the whole controller is gated on `@Roles('ADMIN')` at the class level
 * rather than per method — a new method added here is admin-only by default,
 * and forgetting the decorator cannot silently expose it.
 */
@Controller('admin')
@Roles('ADMIN')
export class AdminController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly config: PlatformConfigService,
    private readonly rides: RideRepository,
    private readonly idempotency: IdempotencyService,
  ) {}

  // -------------------------------------------------------------------------
  // Drivers — CLAUDE.md §2: admins create drivers manually in v1.
  // -------------------------------------------------------------------------

  @Get('drivers')
  async listDrivers(
    @Query(zodBody(PaginationSchema)) query: { limit: number; cursor?: string },
  ) {
    const result = await this.db.query<AdminDriverRow>(
      `SELECT u.id, u.display_name, u.phone_e164, u.created_at,
              d.availability, d.is_suspended, d.suspended_reason,
              d.vehicle_plate, d.vehicle_model, d.vehicle_color,
              d.rating_sum, d.rating_count,
              COALESCE(w.balance_iqd, 0) AS balance_iqd,
              (SELECT COUNT(*) FROM rides r
                WHERE r.driver_id = u.id AND r.status = 'COMPLETED') AS rides_completed
         FROM users u
         JOIN drivers d ON d.user_id = u.id
         LEFT JOIN driver_wallet_balances w ON w.driver_id = u.id
        WHERE u.role = 'DRIVER'
          AND ($1::timestamptz IS NULL OR u.created_at < $1)
        ORDER BY u.created_at DESC
        LIMIT $2`,
      [query.cursor ? new Date(query.cursor) : null, query.limit],
    );

    const items = result.rows.map(presentAdminDriver);
    const last = result.rows.at(-1);

    return {
      items,
      nextCursor:
        result.rows.length === query.limit && last ? last.created_at.toISOString() : null,
    };
  }

  @Post('drivers')
  @HttpCode(201)
  async createDriver(@Body(zodBody(CreateDriverSchema)) body: CreateDriverBody) {
    let phone: string;
    try {
      phone = normalizeIraqiPhone(body.phone);
    } catch (error) {
      if (error instanceof InvalidPhoneNumberError) {
        throw new ValidationProblem([
          { path: 'phone', message: 'Not a valid Iraqi mobile number.' },
        ]);
      }
      throw error;
    }

    return this.db.transaction(async (tx) => {
      try {
        const user = await tx.query<{ id: string; created_at: Date }>(
          `INSERT INTO users (role, phone_e164, display_name)
           VALUES ('DRIVER', $1, $2) RETURNING id, created_at`,
          [phone, body.displayName],
        );
        const driverId = user.rows[0]!.id;

        await tx.query(
          `INSERT INTO drivers (user_id, vehicle_plate, vehicle_model, vehicle_color)
           VALUES ($1, $2, $3, $4)`,
          [driverId, body.vehiclePlate, body.vehicleModel, body.vehicleColor],
        );

        return {
          id: driverId,
          displayName: body.displayName,
          phone,
          availability: 'OFFLINE',
          isSuspended: false,
          suspendedReason: null,
          rating: null,
          ridesCompleted: 0,
          walletBalanceIqd: 0,
          vehicle: {
            plate: body.vehiclePlate,
            model: body.vehicleModel,
            color: body.vehicleColor,
          },
          createdAt: user.rows[0]!.created_at.toISOString(),
        };
      } catch (error) {
        if (isUniqueViolationOn(error, 'users_phone_role_uq')) {
          throw new ConflictProblem('A driver already exists for that phone number.');
        }
        throw error;
      }
    });
  }

  @Get('drivers/:driverId')
  async getDriver(@Param('driverId') driverId: string) {
    const result = await this.db.query<AdminDriverRow>(
      `SELECT u.id, u.display_name, u.phone_e164, u.created_at,
              d.availability, d.is_suspended, d.suspended_reason,
              d.vehicle_plate, d.vehicle_model, d.vehicle_color,
              d.rating_sum, d.rating_count,
              COALESCE(w.balance_iqd, 0) AS balance_iqd,
              (SELECT COUNT(*) FROM rides r
                WHERE r.driver_id = u.id AND r.status = 'COMPLETED') AS rides_completed
         FROM users u
         JOIN drivers d ON d.user_id = u.id
         LEFT JOIN driver_wallet_balances w ON w.driver_id = u.id
        WHERE u.id = $1`,
      [requireUuid(driverId)],
    );

    const row = result.rows[0];
    if (!row) throw new NotFoundProblem('Driver');
    return presentAdminDriver(row);
  }

  @Patch('drivers/:driverId')
  async updateDriver(
    @Param('driverId') driverId: string,
    @Body(zodBody(UpdateDriverSchema)) body: UpdateDriverBody,
  ) {
    const id = requireUuid(driverId);

    await this.db.transaction(async (tx) => {
      if (body.displayName !== undefined) {
        await tx.query(
          `UPDATE users SET display_name = $1, updated_at = now() WHERE id = $2`,
          [body.displayName, id],
        );
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (column: string, value: unknown): void => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };

      if (body.vehiclePlate !== undefined) push('vehicle_plate', body.vehiclePlate);
      if (body.vehicleModel !== undefined) push('vehicle_model', body.vehicleModel);
      if (body.vehicleColor !== undefined) push('vehicle_color', body.vehicleColor);
      if (body.isSuspended !== undefined) push('is_suspended', body.isSuspended);
      if (body.suspendedReason !== undefined) push('suspended_reason', body.suspendedReason);

      if (sets.length > 0) {
        params.push(id);
        await tx.query(
          `UPDATE drivers SET ${sets.join(', ')}, updated_at = now()
            WHERE user_id = $${params.length}`,
          params as never,
        );
      }
    });

    return this.getDriver(id);
  }

  /**
   * CLAUDE.md §6.5 / §5.2 — a retried top-up must not double-credit.
   *
   * Two independent defences: the idempotency layer, and the UNIQUE index on
   * `wallet_topups.transaction_id`. The second exists because the first depends
   * on the client sending the same key, and a client is not a guarantee.
   */
  @Post('drivers/:driverId/wallet/topup')
  async topUp(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('driverId') driverId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(zodBody(TopUpWalletSchema)) body: { amountIqd: number; reference?: string },
    @Res({ passthrough: true }) response: Response,
  ) {
    const id = requireUuid(driverId);
    const key = IdempotencyKeySchema.safeParse(idempotencyKey);
    if (!key.success) {
      throw new ValidationProblem([
        { path: 'Idempotency-Key', message: 'A UUID Idempotency-Key header is required.' },
      ]);
    }

    const outcome = await this.idempotency.run(
      this.db,
      { userId: admin.id, endpoint: 'POST /admin/wallet/topup', key: key.data, body: { id, ...body } },
      async () => {
        const wallet = await this.db.transaction(async (tx) => {
          const exists = await tx.query(`SELECT 1 FROM drivers WHERE user_id = $1`, [id]);
          if (exists.rowCount === 0) throw new NotFoundProblem('Driver');

          const transactionId = randomUUID();
          await this.ledger.recordTopUp(tx, {
            driverId: id,
            amountIqd: iqd(body.amountIqd),
            transactionId,
            ...(body.reference ? { reference: body.reference } : {}),
          });

          await tx.query(
            `INSERT INTO wallet_topups (driver_id, admin_id, amount_iqd, transaction_id, reference)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, admin.id, body.amountIqd, transactionId, body.reference ?? ''],
          );

          return {
            driverId: id,
            balanceIqd: await this.ledger.balanceFor(tx, id),
          };
        });

        return { status: 201, value: wallet };
      },
    );

    response.status(outcome.fresh ? 201 : 200);
    return outcome.value;
  }

  // -------------------------------------------------------------------------
  // Rides
  // -------------------------------------------------------------------------

  @Get('rides')
  async listRides(
    @Query(zodBody(PaginationSchema)) query: { limit: number; cursor?: string },
  ) {
    // Served by rides_status_created_at_idx (CLAUDE.md §3.4).
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM rides
        WHERE ($1::timestamptz IS NULL OR created_at < $1)
        ORDER BY created_at DESC LIMIT $2`,
      [query.cursor ? new Date(query.cursor) : null, query.limit],
    );

    const items = [];
    for (const row of result.rows) {
      const ride = await this.rides.findById(this.db, row.id);
      if (ride) items.push(presentRide(ride));
    }

    const last = items.at(-1);
    return {
      items,
      nextCursor: items.length === query.limit && last ? last.requestedAt : null,
    };
  }

  @Get('rides/:rideId')
  async getRide(@Param('rideId') rideId: string) {
    const id = requireUuid(rideId);
    const ride = await this.rides.findById(this.db, id);
    if (!ride) throw new NotFoundProblem('Ride');

    const events = await this.db.query<{
      id: string; from_state: string | null; to_state: string;
      actor_type: string; actor_id: string | null; metadata: unknown; created_at: Date;
    }>(
      `SELECT id, from_state, to_state, actor_type, actor_id, metadata, created_at
         FROM ride_events WHERE ride_id = $1 ORDER BY created_at`,
      [id],
    );

    const entries = await this.db.query<{
      id: string; transaction_id: string; account_type: string;
      direction: string; amount_iqd: string; description: string; created_at: Date;
    }>(
      `SELECT id, transaction_id, account_type, direction, amount_iqd, description, created_at
         FROM ledger_entries WHERE ride_id = $1 ORDER BY created_at`,
      [id],
    );

    const offers = await this.db.query<{
      driver_id: string; status: string; distance_m: number;
      offered_at: Date; responded_at: Date | null;
    }>(
      `SELECT driver_id, status, distance_m, offered_at, responded_at
         FROM ride_offers WHERE ride_id = $1 ORDER BY offered_at`,
      [id],
    );

    return {
      ride: presentRide(ride),
      events: events.rows.map((e) => ({
        id: Number(e.id),
        fromState: e.from_state,
        toState: e.to_state,
        actorType: e.actor_type,
        actorId: e.actor_id,
        metadata: e.metadata,
        createdAt: e.created_at.toISOString(),
      })),
      ledgerEntries: entries.rows.map((e) => ({
        id: e.id,
        transactionId: e.transaction_id,
        rideId: id,
        accountType: e.account_type,
        direction: e.direction,
        amountIqd: Number(e.amount_iqd),
        description: e.description,
        createdAt: e.created_at.toISOString(),
      })),
      offers: offers.rows.map((o) => ({
        driverId: o.driver_id,
        status: o.status,
        distanceM: o.distance_m,
        offeredAt: o.offered_at.toISOString(),
        respondedAt: o.responded_at?.toISOString() ?? null,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Disputes
  // -------------------------------------------------------------------------

  @Get('disputes')
  async listDisputes(
    @Query(zodBody(PaginationSchema)) query: { limit: number; cursor?: string },
  ) {
    const result = await this.db.query<DisputeRow>(
      `SELECT id, ride_id, opened_by, status, reason_code, description,
              resolution, created_at, resolved_at
         FROM disputes
        WHERE ($1::timestamptz IS NULL OR created_at < $1)
        ORDER BY created_at DESC LIMIT $2`,
      [query.cursor ? new Date(query.cursor) : null, query.limit],
    );

    const last = result.rows.at(-1);
    return {
      items: result.rows.map(presentDispute),
      nextCursor:
        result.rows.length === query.limit && last ? last.created_at.toISOString() : null,
    };
  }

  /**
   * Resolve, optionally with a monetary correction.
   *
   * A correction is always a NEW balanced pair of offsetting entries. No
   * existing ledger row is touched (CLAUDE.md §6.3), and the correction commits
   * in the same transaction as the resolution so the two cannot disagree.
   */
  @Post('disputes/:disputeId/resolve')
  @HttpCode(200)
  async resolveDispute(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('disputeId') disputeId: string,
    @Body(zodBody(ResolveDisputeSchema)) body: ResolveDisputeBody,
  ) {
    const id = requireUuid(disputeId);

    return this.db.transaction(async (tx) => {
      const found = await tx.query<DisputeRow & { ride_id: string }>(
        `SELECT id, ride_id, opened_by, status, reason_code, description,
                resolution, created_at, resolved_at
           FROM disputes WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const dispute = found.rows[0];
      if (!dispute) throw new NotFoundProblem('Dispute');
      if (dispute.status !== 'OPEN') {
        throw new ConflictProblem('This dispute has already been resolved.');
      }

      if (body.adjustmentIqd !== undefined && body.adjustmentIqd !== 0) {
        const ride = await this.rides.findById(tx, dispute.ride_id);
        if (!ride?.driverId) {
          throw new ConflictProblem('This ride has no driver to adjust.');
        }
        await this.ledger.correct(tx, {
          driverId: ride.driverId,
          amountIqd: signedIqd(body.adjustmentIqd),
          reason: `Dispute ${id}: ${body.resolution}`,
          rideId: dispute.ride_id,
        });
      }

      const updated = await tx.query<DisputeRow>(
        `UPDATE disputes
            SET status = $1, resolution = $2, resolved_by = $3, resolved_at = now()
          WHERE id = $4 AND status = 'OPEN'
          RETURNING id, ride_id, opened_by, status, reason_code, description,
                    resolution, created_at, resolved_at`,
        [body.outcome, body.resolution, admin.id, id],
      );

      const row = updated.rows[0];
      if (!row) throw new ConflictProblem('This dispute has already been resolved.');
      return presentDispute(row);
    });
  }

  // -------------------------------------------------------------------------
  // Config — CLAUDE.md §6.5: changeable without a deploy.
  // -------------------------------------------------------------------------

  @Get('config')
  async getConfig() {
    return this.config.read(this.db);
  }

  @Put('config')
  async updateConfig(
    @CurrentUser() admin: AuthenticatedUser,
    @Body(zodBody(UpdateConfigSchema)) body: Partial<Record<ConfigKey, number>>,
  ) {
    return this.config.update(this.db, body, admin.id);
  }
}

// ---------------------------------------------------------------------------

interface AdminDriverRow {
  id: string;
  display_name: string;
  phone_e164: string;
  created_at: Date;
  availability: string;
  is_suspended: boolean;
  suspended_reason: string | null;
  vehicle_plate: string;
  vehicle_model: string;
  vehicle_color: string;
  rating_sum: string;
  rating_count: string;
  balance_iqd: string;
  rides_completed: string;
}

function presentAdminDriver(row: AdminDriverRow): Record<string, unknown> {
  const count = Number(row.rating_count);
  return {
    id: row.id,
    displayName: row.display_name,
    phone: row.phone_e164,
    availability: row.availability,
    isSuspended: row.is_suspended,
    suspendedReason: row.suspended_reason,
    rating: count > 0 ? Math.round((Number(row.rating_sum) / count) * 10) / 10 : null,
    ridesCompleted: Number(row.rides_completed),
    walletBalanceIqd: Number(row.balance_iqd),
    vehicle: {
      plate: row.vehicle_plate,
      model: row.vehicle_model,
      color: row.vehicle_color,
    },
    createdAt: row.created_at.toISOString(),
  };
}

interface DisputeRow {
  id: string;
  ride_id: string;
  opened_by: string;
  status: string;
  reason_code: string;
  description: string;
  resolution: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

function presentDispute(row: DisputeRow): Record<string, unknown> {
  return {
    id: row.id,
    rideId: row.ride_id,
    openedBy: row.opened_by,
    status: row.status,
    reasonCode: row.reason_code,
    description: row.description,
    resolution: row.resolution,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  };
}

interface CreateDriverBody {
  phone: string;
  displayName: string;
  vehiclePlate: string;
  vehicleModel: string;
  vehicleColor: string;
}

interface UpdateDriverBody {
  displayName?: string | undefined;
  vehiclePlate?: string | undefined;
  vehicleModel?: string | undefined;
  vehicleColor?: string | undefined;
  isSuspended?: boolean | undefined;
  suspendedReason?: string | undefined;
}

interface ResolveDisputeBody {
  outcome: 'RESOLVED' | 'REJECTED';
  resolution: string;
  adjustmentIqd?: number | undefined;
}

export { presentLedgerEntry };
