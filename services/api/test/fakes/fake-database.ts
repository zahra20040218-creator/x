import { randomUUID } from 'node:crypto';

import type {
  Database,
  QueryResult,
  Queryable,
  SqlValue,
  Transaction,
} from '../../src/db/db.port.js';

/**
 * An in-memory stand-in for Postgres, good enough to exercise RideService's
 * orchestration without Docker.
 *
 * It models the behaviours the orchestration actually depends on, and NOT the
 * ones it does not:
 *
 *   modelled  - the guarded UPDATE (`WHERE id = $x AND status = $from`)
 *               returning zero rows when the state moved underneath us
 *   modelled  - transaction rollback discarding writes
 *   modelled  - onCommit callbacks firing only after a successful commit
 *   modelled  - the partial unique indexes, as explicit checks
 *
 *   NOT modelled - the append-only triggers, the deferred balance trigger, the
 *                  CHECK constraints, row locking, MVCC.
 *
 * That second list matters. Those are real guarantees that live in the
 * database, and this fake proves nothing about them: they are covered by
 * `test/integration/*` against a real Postgres, which has not run on this host
 * (see BLOCKED.md). Anything asserted with this fake is an assertion about the
 * SERVICE, never about the schema.
 */

export interface FakeRow {
  [column: string]: unknown;
}

export class FakeDatabase implements Database {
  readonly tables = new Map<string, FakeRow[]>();
  readonly statements: string[] = [];

  /** Set to make the next write throw, to exercise rollback paths. */
  failNextWrite: Error | null = null;

  /**
   * Fail a SPECIFIC statement, to test partial-failure rollback.
   *
   * Overriding `db.query` from a test does not work: `transaction()` binds
   * `tx.query` straight to `execute`, so statements issued inside a transaction
   * never pass through `query`. The hook has to live here.
   */
  failOn: ((sql: string) => Error | null) | null = null;

  constructor() {
    for (const table of [
      'rides',
      'ride_events',
      'ride_offers',
      'ledger_entries',
      'payments',
      'drivers',
      'platform_config',
      'idempotency_keys',
    ]) {
      this.tables.set(table, []);
    }
  }

  rows(table: string): FakeRow[] {
    return this.tables.get(table) ?? [];
  }

  seedConfig(values: Record<string, string | number>): void {
    const rows = this.rows('platform_config');
    rows.length = 0;
    for (const [key, value] of Object.entries(values)) {
      rows.push({ key, value: String(value) });
    }
  }

  seedDriver(userId: string, availability = 'ONLINE'): void {
    this.rows('drivers').push({ user_id: userId, availability });
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<QueryResult<Row>> {
    return this.execute<Row>(sql, params);
  }

  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const snapshot = new Map<string, FakeRow[]>();
    for (const [name, rows] of this.tables) snapshot.set(name, rows.map((r) => ({ ...r })));

    const callbacks: Array<() => Promise<void> | void> = [];
    const tx: Transaction = {
      query: async <Row = Record<string, unknown>>(sql: string, p: readonly SqlValue[] = []) =>
        this.execute<Row>(sql, p),
      onCommit: (cb) => callbacks.push(cb),
    };

    try {
      const result = await work(tx);
      // Committed. Only now do the side effects run.
      for (const cb of callbacks) {
        try {
          await cb();
        } catch {
          // Matches PgDatabase: a failed side effect must not undo a commit.
        }
      }
      return result;
    } catch (error) {
      for (const [name, rows] of snapshot) this.tables.set(name, rows);
      throw error;
    }
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    /* nothing to release */
  }

  // -------------------------------------------------------------------------

  private execute<Row>(sql: string, params: readonly SqlValue[]): QueryResult<Row> {
    this.statements.push(sql);
    const s = sql.replace(/\s+/g, ' ').trim();

    if (this.failNextWrite && /^(INSERT|UPDATE)/i.test(s)) {
      const error = this.failNextWrite;
      this.failNextWrite = null;
      throw error;
    }

    if (this.failOn) {
      const error = this.failOn(s);
      if (error) throw error;
    }

    if (/^SELECT key, value FROM platform_config/i.test(s)) {
      return this.ok(this.rows('platform_config') as Row[]);
    }
    if (/^SELECT key FROM platform_config/i.test(s)) {
      return this.ok(this.rows('platform_config').map((r) => ({ key: r['key'] })) as Row[]);
    }

    if (/^INSERT INTO rides/i.test(s)) return this.insertRide<Row>(params);
    if (/^SELECT .* FROM rides WHERE id = \$1/i.test(s)) {
      const found = this.rows('rides').find((r) => r['id'] === params[0]);
      return this.ok(found ? ([{ ...found }] as Row[]) : []);
    }
    if (/^SELECT .* FROM rides WHERE rider_id = \$1 AND status IN/i.test(s)) {
      const found = this.rows('rides').find(
        (r) =>
          r['rider_id'] === params[0] &&
          ['REQUESTED', 'OFFERED', 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS'].includes(
            r['status'] as string,
          ),
      );
      return this.ok(found ? ([{ ...found }] as Row[]) : []);
    }
    if (/^SELECT .* FROM rides WHERE rider_id = \$1/i.test(s)) {
      return this.listRides<Row>('rider_id', params);
    }
    if (/^SELECT .* FROM rides WHERE driver_id = \$1/i.test(s)) {
      return this.listRides<Row>('driver_id', params);
    }
    if (/^UPDATE rides SET/i.test(s)) return this.updateRide<Row>(s, params);

    if (/^INSERT INTO ride_events/i.test(s)) {
      this.rows('ride_events').push({
        ride_id: params[0], from_state: params[1], to_state: params[2],
        actor_type: params[3], actor_id: params[4], metadata: params[5],
      });
      return this.ok([], 1);
    }

    if (/^INSERT INTO ledger_entries/i.test(s)) return this.insertLedger<Row>(params);
    if (/^SELECT transaction_id FROM ledger_entries/i.test(s)) {
      const found = this.rows('ledger_entries').find((r) => r['ride_id'] === params[0]);
      return this.ok(found ? ([{ transaction_id: found['transaction_id'] }] as Row[]) : []);
    }

    if (/^INSERT INTO payments/i.test(s)) {
      const rideId = params[0];
      if (this.rows('payments').some((r) => r['ride_id'] === rideId)) {
        throw Object.assign(new Error('duplicate key'), {
          code: '23505', constraint: 'payments_ride_uq',
        });
      }
      this.rows('payments').push({
        ride_id: rideId, provider: 'CASH', status: 'CONFIRMED',
        amount_iqd: String(params[1]), confirmed_by: params[2], confirmed_at: params[3],
      });
      return this.ok([], 1);
    }

    if (/^UPDATE drivers SET availability = 'ON_TRIP'/i.test(s)) {
      const driver = this.rows('drivers').find((r) => r['user_id'] === params[0]);
      if (driver) driver['availability'] = 'ON_TRIP';
      return this.ok([], driver ? 1 : 0);
    }
    if (/^UPDATE drivers SET availability = 'ONLINE'/i.test(s)) {
      const driver = this.rows('drivers').find(
        (r) => r['user_id'] === params[0] && r['availability'] === 'ON_TRIP',
      );
      if (driver) driver['availability'] = 'ONLINE';
      return this.ok([], driver ? 1 : 0);
    }

    if (/^UPDATE ride_offers/i.test(s)) {
      for (const offer of this.rows('ride_offers')) {
        if (offer['ride_id'] === params[0] && offer['status'] === 'PENDING') {
          offer['status'] = offer['driver_id'] === params[1] ? 'ACCEPTED' : 'SUPERSEDED';
        }
      }
      return this.ok([], 1);
    }

    return this.ok([]);
  }

  private insertRide<Row>(params: readonly SqlValue[]): QueryResult<Row> {
    const riderId = params[0] as string;

    // rides_one_active_per_rider_uq
    if (
      this.rows('rides').some(
        (r) =>
          r['rider_id'] === riderId &&
          ['REQUESTED', 'OFFERED', 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS'].includes(
            r['status'] as string,
          ),
      )
    ) {
      throw Object.assign(new Error('duplicate key'), {
        code: '23505', constraint: 'rides_one_active_per_rider_uq',
      });
    }

    const row: FakeRow = {
      id: randomUUID(),
      rider_id: riderId,
      driver_id: null,
      status: 'REQUESTED',
      pickup_lat: params[1], pickup_lng: params[2], pickup_address: params[3],
      dropoff_lat: params[4], dropoff_lng: params[5], dropoff_address: params[6],
      estimated_fare_iqd: String(params[7]),
      final_fare_iqd: null,
      commission_bps_snapshot: params[10],
      commission_iqd: null,
      estimated_distance_m: params[8],
      estimated_duration_s: params[9],
      actual_distance_m: null,
      payment_method: 'CASH',
      requested_at: new Date(), accepted_at: null, driver_arrived_at: null,
      started_at: null, completed_at: null, cancelled_at: null,
      cancellation_reason: null, created_at: new Date(),
    };
    this.rows('rides').push(row);
    return this.ok([{ ...row }] as Row[], 1);
  }

  /**
   * The guarded UPDATE. `WHERE id = $n AND status = $m` - if the ride is no
   * longer in the expected state, ZERO rows are affected and the caller must
   * treat that as a conflict. This is the single most important behaviour this
   * fake models.
   */
  private updateRide<Row>(sql: string, params: readonly SqlValue[]): QueryResult<Row> {
    const idMatch = /WHERE id = \$(\d+) AND status = \$(\d+)/i.exec(sql);
    if (!idMatch) return this.ok([]);

    const rideId = params[Number(idMatch[1]) - 1];
    const expectedFrom = params[Number(idMatch[2]) - 1];

    const ride = this.rows('rides').find((r) => r['id'] === rideId);
    if (!ride || ride['status'] !== expectedFrom) return this.ok([], 0);

    // Parse assignments from the SET clause ONLY. Scanning the whole statement
    // also matches `status = $5` inside the WHERE, which would assign the ride's
    // OLD status back over the new one - a cancel would appear to succeed and
    // leave the ride active.
    const setClause = sql.slice(0, sql.search(/\sWHERE\s/i));
    const assignments = [...setClause.matchAll(/(\w+) = \$(\d+)/g)];
    const driverIdAssignment = assignments.find(([, col]) => col === 'driver_id');

    // rides_one_active_per_driver_uq - the database-level backstop behind the
    // Redis claim.
    if (driverIdAssignment) {
      const newDriverId = params[Number(driverIdAssignment[2]) - 1];
      if (
        this.rows('rides').some(
          (r) =>
            r['id'] !== rideId &&
            r['driver_id'] === newDriverId &&
            ['ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS'].includes(r['status'] as string),
        )
      ) {
        throw Object.assign(new Error('duplicate key'), {
          code: '23505', constraint: 'rides_one_active_per_driver_uq',
        });
      }
    }

    for (const [, column, index] of assignments) {
      if (column === 'id') continue;
      const value = params[Number(index) - 1];
      ride[column!] =
        column === 'final_fare_iqd' || column === 'commission_iqd'
          ? String(value)
          : (value as unknown);
    }

    return this.ok([{ ...ride }] as Row[], 1);
  }

  private insertLedger<Row>(params: readonly SqlValue[]): QueryResult<Row> {
    const rowCount = params.length / 7;
    for (let i = 0; i < rowCount; i++) {
      const base = i * 6;
      this.rows('ledger_entries').push({
        id: randomUUID(),
        transaction_id: params[base],
        ride_id: params[base + 1],
        account_type: params[base + 2],
        account_id: params[base + 3],
        direction: params[base + 4],
        amount_iqd: params[base + 5],
        description: params[rowCount * 6 + i],
        created_at: new Date(),
      });
    }
    return this.ok([], rowCount);
  }

  private listRides<Row>(column: string, params: readonly SqlValue[]): QueryResult<Row> {
    const limit = params[3] as number;
    const status = params[2] as string | null;
    const rows = this.rows('rides')
      .filter((r) => r[column] === params[0])
      .filter((r) => status === null || r['status'] === status)
      .slice(0, limit)
      .map((r) => ({ ...r }));
    return this.ok(rows as Row[]);
  }

  private ok<Row>(rows: Row[], rowCount = rows.length): QueryResult<Row> {
    return { rows, rowCount };
  }

  /** Net of a ledger transaction. Zero for every balanced write. */
  ledgerNet(transactionId: string): number {
    return this.rows('ledger_entries')
      .filter((r) => r['transaction_id'] === transactionId)
      .reduce(
        (sum, r) =>
          sum + (r['direction'] === 'CREDIT' ? Number(r['amount_iqd']) : -Number(r['amount_iqd'])),
        0,
      );
  }

  walletBalance(driverId: string): number {
    return this.rows('ledger_entries')
      .filter((r) => r['account_type'] === 'DRIVER_WALLET' && r['account_id'] === driverId)
      .reduce(
        (sum, r) =>
          sum + (r['direction'] === 'CREDIT' ? Number(r['amount_iqd']) : -Number(r['amount_iqd'])),
        0,
      );
  }
}

export type { Queryable };
