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

import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { normalizeIraqiPhone, InvalidPhoneNumberError } from '../auth/phone.js';
import { TokenService } from '../auth/token.service.js';
import { ConflictProblem, NotFoundProblem, ValidationProblem } from '../common/problem.js';
import {
  DRIVER_DOCUMENT_TYPES,
  DriverComplianceService,
} from '../compliance/driver-compliance.service.js';
import { DATABASE, isUniqueViolationOn, type Database } from '../db/db.port.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { iqd, signedIqd } from '../money/iqd.js';
import { PlatformConfigService, type ConfigKey } from '../platform-config/platform-config.service.js';
import { RideRepository } from '../rides/ride.repository.js';
import { CurrentUser, Roles } from './auth.guard.js';
import { RateLimit } from './rate-limit.js';
import { presentLedgerEntry, presentRide } from './presenters.js';
import { requireUuid } from './rides.controller.js';
import {
  CreateDriverSchema,
  IdempotencyKeySchema,
  PaginationSchema,
  RecordDriverDocumentSchema,
  ResolveDisputeSchema,
  TopUpWalletSchema,
  UpdateConfigSchema,
  UpdateDriverSchema,
} from './schemas.js';
import type { RecordDriverDocumentBody } from './schemas.js';
import { decodeKeysetCursor, nextKeysetCursor } from './cursor.js';
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
    private readonly compliance: DriverComplianceService,
    @Inject(DATABASE) private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly config: PlatformConfigService,
    private readonly rides: RideRepository,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
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
          AND ($1::uuid IS NULL OR (u.created_at, u.id) < (
                SELECT created_at, id FROM users WHERE id = $1
              ))
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT $2`,
      [query.cursor ? decodeKeysetCursor(query.cursor) : null, query.limit],
    );

    const items = result.rows.map(presentAdminDriver);

    return {
      items,
      nextCursor: nextKeysetCursor(result.rows, query.limit),
    };
  }

  @Post('drivers')
  @RateLimit({ limit: 30, windowSeconds: 60, by: 'user', tier: 'CRITICAL' })
  @HttpCode(201)
  async createDriver(
    @CurrentUser() admin: AuthenticatedUser,
    @Body(zodBody(CreateDriverSchema)) body: CreateDriverBody,
  ) {
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

        // In the SAME transaction as the create: an audit row for a driver
        // that was never created would be worse than no row at all.
        await this.audit.record(tx, {
          actorId: admin.id,
          actorRole: 'ADMIN',
          action: AUDIT_ACTIONS.driverCreate,
          targetType: 'driver',
          targetId: driverId,
          result: 'SUCCESS',
          // No phone, no name - scrub() would strip them anyway.
          metadata: { vehiclePlate: body.vehiclePlate },
        });

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
  // Suspension and reinstatement live here.
  @RateLimit({ limit: 60, windowSeconds: 60, by: 'user', tier: 'CRITICAL' })
  async updateDriver(
    @CurrentUser() admin: AuthenticatedUser,
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

      // Suspension is a security-sensitive change, so it invalidates the
      // driver's sessions in the same transaction. Without this, suspending a
      // driver for fraud left every device they were signed in on holding a
      // working token until it expired.
      //
      // Note what this deliberately does NOT do: it does not set
      // `users.is_active = false`. Suspension bars a driver from taking rides;
      // it does not bar them from signing in to see that they are suspended
      // and contact support. Forcing re-authentication is the intended
      // strength - preventing it is a different, heavier action.
      if (body.isSuspended === true) {
        await this.tokens.revokeAllForUser(tx, id);
      }

      // Suspension gets its own verb. "Who suspended this driver, and when"
      // is a different question from "who edited their plate", and an
      // operator filtering the log should not have to read metadata to tell
      // them apart.
      const action =
        body.isSuspended === undefined
          ? AUDIT_ACTIONS.driverUpdate
          : body.isSuspended
            ? AUDIT_ACTIONS.driverSuspend
            : AUDIT_ACTIONS.driverUnsuspend;

      await this.audit.record(tx, {
        actorId: admin.id,
        actorRole: 'ADMIN',
        action,
        targetType: 'driver',
        targetId: id,
        result: 'SUCCESS',
        metadata: {
          fields: Object.keys(body),
          ...(body.suspendedReason ? { suspendedReason: body.suspendedReason } : {}),
        },
      });
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
  // Money movement. An operator tops up a handful of wallets a day; anything
  // faster is a stuck script or a compromised admin session.
  @RateLimit({ limit: 30, windowSeconds: 60, by: 'user', tier: 'CRITICAL' })
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

          // Money moved. This is the row that answers "who credited this
          // driver", and it commits with the credit or not at all.
          await this.audit.record(tx, {
            actorId: admin.id,
            actorRole: 'ADMIN',
            action: AUDIT_ACTIONS.walletTopUp,
            targetType: 'driver',
            targetId: id,
            result: 'SUCCESS',
            metadata: {
              amountIqd: body.amountIqd,
              transactionId,
              ...(body.reference ? { reference: body.reference } : {}),
            },
          });

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


  /**
   * The documents on file for one driver, and whether they satisfy the current
   * policy.
   *
   * The verdict is computed rather than stored, so it reflects today's expiry
   * dates and today's configured policy — not whatever was true when the row
   * was last written.
   */
  @Get('drivers/:driverId/documents')
  async listDriverDocuments(@Param('driverId') driverId: string) {
    const id = requireUuid(driverId);

    const result = await this.db.query<{
      doc_type: string;
      status: string;
      reference: string;
      expires_at: Date | null;
      verified_by: string | null;
      verified_at: Date | null;
      note: string;
      updated_at: Date;
    }>(
      `SELECT doc_type, status, reference, expires_at, verified_by, verified_at,
              note, updated_at
         FROM driver_documents
        WHERE driver_id = $1
        ORDER BY doc_type`,
      [id],
    );

    const verdict = await this.compliance.evaluate(this.db, id);

    return {
      items: result.rows.map((row) => ({
        docType: row.doc_type,
        status: row.status,
        reference: row.reference,
        expiresAt: row.expires_at ? toDateOnly(row.expires_at) : null,
        verifiedBy: row.verified_by,
        verifiedAt: row.verified_at?.toISOString() ?? null,
        note: row.note,
        updatedAt: row.updated_at.toISOString(),
      })),
      compliance: verdict,
    };
  }

  /**
   * Record the outcome of an administrator checking a document.
   *
   * PUT, and one row per (driver, type): re-checking a renewed licence updates
   * the record rather than adding a second one, and there is never a question
   * of which of two rows is current. The history is in the audit log, which is
   * already append-only — keeping a second copy here would give two accounts of
   * the same event and no rule for which is right.
   */
  @Put('drivers/:driverId/documents/:docType')
  @RateLimit({ limit: 60, windowSeconds: 60, by: 'user', tier: 'CRITICAL' })
  async recordDriverDocument(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('driverId') driverId: string,
    @Param('docType') docType: string,
    @Body(zodBody(RecordDriverDocumentSchema)) body: RecordDriverDocumentBody,
  ) {
    const id = requireUuid(driverId);

    const type = docType.toUpperCase();
    if (!(DRIVER_DOCUMENT_TYPES as readonly string[]).includes(type)) {
      throw new ValidationProblem([
        { path: 'docType', message: `Unknown document type: ${docType}` },
      ]);
    }

    const driver = await this.db.query(`SELECT 1 FROM drivers WHERE user_id = $1`, [id]);
    if (driver.rowCount === 0) throw new NotFoundProblem('Driver');

    // VERIFIED carries the verifier; anything else clears them, so a document
    // downgraded from verified does not keep an approval that no longer applies.
    const verifying = body.status === 'VERIFIED';

    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO driver_documents
           (driver_id, doc_type, status, reference, expires_at, verified_by, verified_at, note)
         VALUES ($1, $2::driver_document_type, $3::driver_document_status, $4, $5::date, $6, $7, $8)
         ON CONFLICT (driver_id, doc_type) DO UPDATE SET
           status      = EXCLUDED.status,
           reference   = EXCLUDED.reference,
           expires_at  = EXCLUDED.expires_at,
           verified_by = EXCLUDED.verified_by,
           verified_at = EXCLUDED.verified_at,
           note        = EXCLUDED.note,
           updated_at  = now()`,
        [
          id,
          type,
          body.status,
          body.reference ?? '',
          body.expiresAt ?? null,
          verifying ? admin.id : null,
          verifying ? new Date() : null,
          body.note ?? '',
        ],
      );

      await this.audit.record(tx, {
        actorId: admin.id,
        actorRole: 'ADMIN',
        action:
          body.status === 'REJECTED'
            ? AUDIT_ACTIONS.documentReject
            : AUDIT_ACTIONS.documentVerify,
        targetType: 'driver_document',
        targetId: id,
        result: 'SUCCESS',
        // The document NUMBER is deliberately absent: it is the closest thing
        // to an identity document this system holds, and the audit log is
        // exported for disputes (CLAUDE.md §9 - no PII in logs).
        metadata: { docType: type, status: body.status, hasExpiry: body.expiresAt !== undefined },
      });
    });

    return this.listDriverDocuments(driverId);
  }

  @Get('rides')
  async listRides(
    @Query(zodBody(PaginationSchema)) query: { limit: number; cursor?: string },
  ) {
    // Served by rides_status_created_at_idx (CLAUDE.md §3.4).
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM rides
        WHERE ($1::uuid IS NULL OR (created_at, id) < (
                SELECT created_at, id FROM rides WHERE id = $1
              ))
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [query.cursor ? decodeKeysetCursor(query.cursor) : null, query.limit],
    );

    const items = [];
    for (const row of result.rows) {
      const ride = await this.rides.findById(this.db, row.id);
      if (ride) items.push(presentRide(ride));
    }

    return {
      items,
      // Was `last.requestedAt` while the query paged on `created_at` - a cursor
      // that did not name the boundary it was taken from.
      nextCursor: nextKeysetCursor(result.rows, query.limit),
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
        WHERE ($1::uuid IS NULL OR (created_at, id) < (
                SELECT created_at, id FROM disputes WHERE id = $1
              ))
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [query.cursor ? decodeKeysetCursor(query.cursor) : null, query.limit],
    );

    return {
      items: result.rows.map(presentDispute),
      nextCursor: nextKeysetCursor(result.rows, query.limit),
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
  // Resolution can issue a refund, so it can move money.
  @RateLimit({ limit: 60, windowSeconds: 60, by: 'user', tier: 'CRITICAL' })
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

      await this.audit.record(tx, {
        actorId: admin.id,
        actorRole: 'ADMIN',
        action: AUDIT_ACTIONS.disputeResolve,
        targetType: 'dispute',
        targetId: id,
        result: 'SUCCESS',
        metadata: {
          outcome: body.outcome,
          rideId: dispute.ride_id,
          // The adjustment is the part with financial consequence, so it is
          // recorded explicitly rather than left inside a free-text field.
          ...(body.adjustmentIqd !== undefined
            ? { adjustmentIqd: body.adjustmentIqd }
            : {}),
        },
      });

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
  // Changes the commission rate and the fare table.
  @RateLimit({ limit: 30, windowSeconds: 60, by: 'user', tier: 'CRITICAL' })
  async updateConfig(
    @CurrentUser() admin: AuthenticatedUser,
    @Body(zodBody(UpdateConfigSchema)) body: Partial<Record<ConfigKey, number>>,
  ) {
    const before = await this.config.read(this.db);
    const after = await this.config.update(this.db, body, admin.id);

    // Both values recorded. "Commission changed" is not actionable; "commission
    // went from 0 to 2500 bps at 03:14 by this admin" is.
    await this.audit.record(this.db, {
      actorId: admin.id,
      actorRole: 'ADMIN',
      action: AUDIT_ACTIONS.configUpdate,
      targetType: 'platform_config',
      targetId: Object.keys(body).join(','),
      result: 'SUCCESS',
      metadata: {
        changes: Object.fromEntries(
          Object.keys(body).map((key) => [
            key,
            { from: before[key as ConfigKey], to: after[key as ConfigKey] },
          ]),
        ),
      },
    });

    return after;
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

/** A DATE column rendered back as `YYYY-MM-DD`, without a timezone shift. */
function toDateOnly(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
