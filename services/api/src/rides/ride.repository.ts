import type { Queryable } from '../db/db.port.js';
import { parseIqdFromDb, type IqdAmount } from '../money/iqd.js';
import type { TransitionDecision } from './ride-state-machine.js';
import type { RideRecord, RideStatus } from './ride.types.js';

/**
 * Ride persistence.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * 1. **The status UPDATE is guarded by the expected current state.** Every
 *    status write is `... WHERE id = $1 AND status = $expectedFrom`. If it
 *    affects zero rows, somebody else moved the ride first and the caller must
 *    get a 409 rather than overwrite them. This is what makes concurrent
 *    conflicting transitions safe without locking the table.
 *
 * 2. **Money comes back as a string.** node-postgres returns BIGINT as text
 *    (see `pg-database.ts`), so every money column goes through
 *    `parseIqdFromDb`. Reading `row.final_fare_iqd` directly would give a
 *    string, and `'100' + 50` is `'10050'`.
 */

interface RideRow {
  id: string;
  rider_id: string;
  driver_id: string | null;
  status: RideStatus;
  pickup_lat: number;
  pickup_lng: number;
  pickup_address: string | null;
  dropoff_lat: number;
  dropoff_lng: number;
  dropoff_address: string | null;
  estimated_fare_iqd: string;
  final_fare_iqd: string | null;
  commission_bps_snapshot: number;
  commission_iqd: string | null;
  estimated_distance_m: number;
  estimated_duration_s: number;
  actual_distance_m: number | null;
  payment_method: 'CASH' | 'GATEWAY';
  requested_at: Date;
  accepted_at: Date | null;
  driver_arrived_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
}

const RIDE_COLUMNS = `
  id, rider_id, driver_id, status,
  pickup_lat, pickup_lng, pickup_address,
  dropoff_lat, dropoff_lng, dropoff_address,
  estimated_fare_iqd, final_fare_iqd, commission_bps_snapshot, commission_iqd,
  estimated_distance_m, estimated_duration_s, actual_distance_m,
  payment_method, requested_at, accepted_at, driver_arrived_at,
  started_at, completed_at, cancelled_at, cancellation_reason
`;

export function toRideRecord(row: RideRow): RideRecord {
  return {
    id: row.id,
    riderId: row.rider_id,
    driverId: row.driver_id,
    status: row.status,
    pickupLat: row.pickup_lat,
    pickupLng: row.pickup_lng,
    pickupAddress: row.pickup_address,
    dropoffLat: row.dropoff_lat,
    dropoffLng: row.dropoff_lng,
    dropoffAddress: row.dropoff_address,
    estimatedFareIqd: parseIqdFromDb(row.estimated_fare_iqd),
    finalFareIqd: row.final_fare_iqd === null ? null : parseIqdFromDb(row.final_fare_iqd),
    commissionBpsSnapshot: row.commission_bps_snapshot,
    commissionIqd: row.commission_iqd === null ? null : parseIqdFromDb(row.commission_iqd),
    estimatedDistanceM: row.estimated_distance_m,
    estimatedDurationS: row.estimated_duration_s,
    actualDistanceM: row.actual_distance_m,
    paymentMethod: row.payment_method,
    requestedAt: row.requested_at,
    acceptedAt: row.accepted_at,
    driverArrivedAt: row.driver_arrived_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
  };
}

export interface CreateRideInput {
  riderId: string;
  pickupLat: number;
  pickupLng: number;
  pickupAddress: string | null;
  dropoffLat: number;
  dropoffLng: number;
  dropoffAddress: string | null;
  estimatedFareIqd: IqdAmount;
  estimatedDistanceM: number;
  estimatedDurationS: number;
  commissionBpsSnapshot: number;
}

/** Column writes that accompany a particular transition. */
export interface TransitionSideEffects {
  driverId?: string;
  acceptedAt?: Date;
  driverArrivedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  cancellationReason?: string | null;
  finalFareIqd?: IqdAmount;
  commissionIqd?: IqdAmount;
  actualDistanceM?: number | null;
}

export class RideRepository {
  async create(q: Queryable, input: CreateRideInput): Promise<RideRecord> {
    const result = await q.query<RideRow>(
      `INSERT INTO rides (
         rider_id, pickup_lat, pickup_lng, pickup_address,
         dropoff_lat, dropoff_lng, dropoff_address,
         estimated_fare_iqd, estimated_distance_m, estimated_duration_s,
         commission_bps_snapshot
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING ${RIDE_COLUMNS}`,
      [
        input.riderId,
        input.pickupLat,
        input.pickupLng,
        input.pickupAddress,
        input.dropoffLat,
        input.dropoffLng,
        input.dropoffAddress,
        input.estimatedFareIqd,
        input.estimatedDistanceM,
        input.estimatedDurationS,
        input.commissionBpsSnapshot,
      ],
    );

    return toRideRecord(result.rows[0]!);
  }

  async findById(q: Queryable, rideId: string): Promise<RideRecord | null> {
    const result = await q.query<RideRow>(
      `SELECT ${RIDE_COLUMNS} FROM rides WHERE id = $1`,
      [rideId],
    );
    const row = result.rows[0];
    return row ? toRideRecord(row) : null;
  }

  /**
   * Read inside a transaction, taking a row lock.
   *
   * The guarded UPDATE already makes a lost update impossible, but locking here
   * means a concurrent transition BLOCKS rather than failing and being retried,
   * which is cheaper on the hot path than a 409 round trip.
   */
  async findByIdForUpdate(q: Queryable, rideId: string): Promise<RideRecord | null> {
    const result = await q.query<RideRow>(
      `SELECT ${RIDE_COLUMNS} FROM rides WHERE id = $1 FOR UPDATE`,
      [rideId],
    );
    const row = result.rows[0];
    return row ? toRideRecord(row) : null;
  }

  /** The rider's current live ride, if any. */
  async findActiveForRider(q: Queryable, riderId: string): Promise<RideRecord | null> {
    const result = await q.query<RideRow>(
      `SELECT ${RIDE_COLUMNS} FROM rides
        WHERE rider_id = $1
          AND status IN ('REQUESTED','OFFERED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')
        LIMIT 1`,
      [riderId],
    );
    const row = result.rows[0];
    return row ? toRideRecord(row) : null;
  }

  /**
   * Apply a validated transition.
   *
   * Returns the updated ride, or null when zero rows matched - which means the
   * ride was no longer in `decision.from` and another actor got there first.
   * The caller turns that into a 409. It must never be treated as success.
   */
  async applyTransition(
    q: Queryable,
    decision: TransitionDecision,
    effects: TransitionSideEffects = {},
  ): Promise<RideRecord | null> {
    const sets: string[] = ['status = $1', 'updated_at = now()'];
    const params: unknown[] = [decision.to];

    const push = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (effects.driverId !== undefined) push('driver_id', effects.driverId);
    if (effects.acceptedAt !== undefined) push('accepted_at', effects.acceptedAt);
    if (effects.driverArrivedAt !== undefined) push('driver_arrived_at', effects.driverArrivedAt);
    if (effects.startedAt !== undefined) push('started_at', effects.startedAt);
    if (effects.completedAt !== undefined) push('completed_at', effects.completedAt);
    if (effects.cancelledAt !== undefined) push('cancelled_at', effects.cancelledAt);
    if (effects.cancellationReason !== undefined) {
      push('cancellation_reason', effects.cancellationReason);
    }
    if (effects.finalFareIqd !== undefined) push('final_fare_iqd', effects.finalFareIqd);
    if (effects.commissionIqd !== undefined) push('commission_iqd', effects.commissionIqd);
    if (effects.actualDistanceM !== undefined) push('actual_distance_m', effects.actualDistanceM);

    params.push(decision.rideId);
    const idParam = params.length;
    params.push(decision.from);
    const fromParam = params.length;

    const result = await q.query<RideRow>(
      // The `AND status = $from` is the whole point. Without it, two concurrent
      // transitions both succeed and the later one silently wins.
      `UPDATE rides SET ${sets.join(', ')}
        WHERE id = $${idParam} AND status = $${fromParam}
        RETURNING ${RIDE_COLUMNS}`,
      params as never,
    );

    const row = result.rows[0];
    return row ? toRideRecord(row) : null;
  }

  /**
   * Append the audit row. CLAUDE.md §4: every transition writes exactly one, in
   * the same transaction as the status change.
   */
  async insertEvent(q: Queryable, decision: TransitionDecision): Promise<void> {
    await q.query(
      `INSERT INTO ride_events (ride_id, from_state, to_state, actor_type, actor_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        decision.rideId,
        decision.from,
        decision.to,
        decision.actorType,
        decision.actorId,
        JSON.stringify({ ...decision.metadata, description: decision.description }),
      ],
    );
  }

  async listForRider(
    q: Queryable,
    riderId: string,
    options: { limit: number; after?: string; status?: RideStatus },
  ): Promise<RideRecord[]> {
    const result = await q.query<RideRow>(
      // The rider id comes from the token, never from a query parameter, so
      // there is no input that widens this filter (ACCEPTANCE_CHECKLIST check 5).
      `SELECT ${RIDE_COLUMNS} FROM rides
        WHERE rider_id = $1
          -- Keyset on (created_at, id): created_at alone is not a total
          -- order, and a timestamp cannot round-trip through a JavaScript
          -- Date without losing microseconds. See http/cursor.ts.
          AND ($2::uuid IS NULL OR (created_at, id) < (
                SELECT created_at, id FROM rides WHERE id = $2
              ))
          AND ($3::ride_status IS NULL OR status = $3)
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [riderId, options.after ?? null, options.status ?? null, options.limit],
    );
    return result.rows.map(toRideRecord);
  }

  async listForDriver(
    q: Queryable,
    driverId: string,
    options: { limit: number; after?: string; status?: RideStatus },
  ): Promise<RideRecord[]> {
    const result = await q.query<RideRow>(
      `SELECT ${RIDE_COLUMNS} FROM rides
        WHERE driver_id = $1
          -- Keyset on (created_at, id): created_at alone is not a total
          -- order, and a timestamp cannot round-trip through a JavaScript
          -- Date without losing microseconds. See http/cursor.ts.
          AND ($2::uuid IS NULL OR (created_at, id) < (
                SELECT created_at, id FROM rides WHERE id = $2
              ))
          AND ($3::ride_status IS NULL OR status = $3)
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [driverId, options.after ?? null, options.status ?? null, options.limit],
    );
    return result.rows.map(toRideRecord);
  }
}
