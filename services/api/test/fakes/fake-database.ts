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
      'users',
      'riders',
      'refresh_tokens',
      'ratings',
      'disputes',
      'wallet_topups',
      'audit_log',
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

    // ---- idempotency (CLAUDE.md 5.2) ----
    if (/^INSERT INTO idempotency_keys/i.test(s)) {
      const [key, userId, endpoint, requestHash, , expiresAt] = params as [
        string, string, string, string, Date, Date,
      ];
      const exists = this.rows('idempotency_keys').some(
        (r) => r['key'] === key && r['user_id'] === userId && r['endpoint'] === endpoint,
      );
      // ON CONFLICT DO NOTHING: the primary key admits exactly one row, and the
      // rowCount is how the caller learns whether it won the claim.
      if (exists) return this.ok([], 0);
      this.rows('idempotency_keys').push({
        key, user_id: userId, endpoint, request_hash: requestHash,
        response_status: null, response_body: null, expires_at: expiresAt,
      });
      return this.ok([], 1);
    }
    if (/^UPDATE idempotency_keys/i.test(s)) {
      const [status, body, , userId, endpoint, key] = params as [
        number, string, string | null, string, string, string,
      ];
      const row = this.rows('idempotency_keys').find(
        (r) => r['key'] === key && r['user_id'] === userId && r['endpoint'] === endpoint,
      );
      if (row) {
        row['response_status'] = status;
        row['response_body'] = JSON.parse(body);
      }
      return this.ok([], row ? 1 : 0);
    }
    if (/^DELETE FROM idempotency_keys/i.test(s) && /RESPONSE_STATUS IS NULL/i.test(s)) {
      const [userId, endpoint, key] = params as [string, string, string];
      const rows = this.rows('idempotency_keys');
      const index = rows.findIndex(
        (r) =>
          r['key'] === key && r['user_id'] === userId &&
          r['endpoint'] === endpoint && r['response_status'] === null,
      );
      if (index === -1) return this.ok([], 0);
      rows.splice(index, 1);
      return this.ok([], 1);
    }
    if (/^SELECT request_hash, response_status, response_body/i.test(s)) {
      const [userId, endpoint, key] = params as [string, string, string];
      const row = this.rows('idempotency_keys').find(
        (r) => r['key'] === key && r['user_id'] === userId && r['endpoint'] === endpoint,
      );
      return this.ok(row ? ([{ ...row }] as Row[]) : []);
    }

    // ---- platform config ----
    if (/^UPDATE platform_config/i.test(s)) {
      const [value, , , key] = params as [string, Date, string, string];
      const row = this.rows('platform_config').find((r) => r['key'] === key);
      if (row) row['value'] = value;
      else this.rows('platform_config').push({ key, value });
      return this.ok([], 1);
    }

    // ---- driver state ----
    if (/^SELECT availability, is_suspended, vehicle_plate/i.test(s)) {
      const found = this.rows('drivers').find((d) => d['user_id'] === params[0]);
      return this.ok(found ? ([{ ...found }] as Row[]) : []);
    }
    if (/^SELECT 1 FROM rides/i.test(s)) {
      const active = this.rows('rides').some(
        (r) =>
          r['driver_id'] === params[0] &&
          ['ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS'].includes(r['status'] as string),
      );
      return this.ok(active ? ([{ one: 1 }] as Row[]) : []);
    }
    if (/^SELECT 1 FROM ride_offers/i.test(s)) {
      const found = this.rows('ride_offers').some(
        (o) =>
          o['ride_id'] === params[0] && o['driver_id'] === params[1] && o['status'] === 'PENDING',
      );
      return this.ok(found ? ([{ one: 1 }] as Row[]) : []);
    }
    if (/^SELECT 1 FROM drivers/i.test(s)) {
      const found = this.rows('drivers').some((d) => d['user_id'] === params[0]);
      return this.ok(found ? ([{ one: 1 }] as Row[]) : []);
    }
    if (/^UPDATE drivers SET availability = 'OFFLINE'/i.test(s)) {
      const driver = this.rows('drivers').find((d) => d['user_id'] === params[0]);
      if (driver) driver['availability'] = 'OFFLINE';
      return this.ok([], driver ? 1 : 0);
    }
    // The availability ENDPOINT: "... AND availability <> 'ON_TRIP'".
    // Distinguished from releaseDriver's "... AND availability = 'ON_TRIP'" by
    // the operator alone - matching on the ON_TRIP text alone shadows the other
    // and silently stops the driver being freed after a ride.
    if (/^UPDATE drivers SET availability = 'ONLINE'/i.test(s) && /<> 'ON_TRIP'/i.test(s)) {
      const driver = this.rows('drivers').find(
        (d) => d['user_id'] === params[0] && d['availability'] !== 'ON_TRIP',
      );
      if (driver) driver['availability'] = 'ONLINE';
      return this.ok([], driver ? 1 : 0);
    }

    // ---- offers / payments lookups ----
    if (/^SELECT id, distance_m, expires_at FROM ride_offers/i.test(s)) {
      const found = this.rows('ride_offers').find(
        (o) =>
          o['ride_id'] === params[0] && o['driver_id'] === params[1] && o['status'] === 'PENDING',
      );
      if (!found) return this.ok([]);
      return this.ok([
        { id: 'offer-1', distance_m: found['distance_m'], expires_at: found['expires_at'] },
      ] as Row[]);
    }
    if (/^SELECT id, status, amount_iqd, confirmed_at FROM payments/i.test(s)) {
      const found = this.rows('payments').find((p) => p['ride_id'] === params[0]);
      if (!found) return this.ok([]);
      return this.ok([
        {
          id: 'payment-1', status: found['status'],
          amount_iqd: found['amount_iqd'], confirmed_at: found['confirmed_at'],
        },
      ] as Row[]);
    }

    // ---- counterparty joins ----
    if (/^SELECT u\.id, u\.display_name, d\.rating_sum/i.test(s)) {
      const user = this.rows('users').find((u) => u['id'] === params[0]);
      const driver = this.rows('drivers').find((d) => d['user_id'] === params[0]);
      if (!user || !driver) return this.ok([]);
      return this.ok([
        {
          id: user['id'], display_name: user['display_name'],
          rating_sum: driver['rating_sum'] ?? '0', rating_count: driver['rating_count'] ?? '0',
          vehicle_plate: driver['vehicle_plate'], vehicle_model: driver['vehicle_model'],
          vehicle_color: driver['vehicle_color'],
        },
      ] as Row[]);
    }
    if (/^SELECT u\.id, u\.display_name, r\.rating_sum/i.test(s)) {
      const user = this.rows('users').find((u) => u['id'] === params[0]);
      if (!user) return this.ok([]);
      return this.ok([
        {
          id: user['id'], display_name: user['display_name'],
          rating_sum: '0', rating_count: '0',
        },
      ] as Row[]);
    }

    // ---- ratings ----
    if (/^INSERT INTO ratings/i.test(s)) {
      const [rideId, raterId] = params as [string, string];
      const exists = this.rows('ratings').some(
        (r) => r['ride_id'] === rideId && r['rater_id'] === raterId,
      );
      if (exists) return this.ok([], 0);
      this.rows('ratings').push({
        ride_id: rideId, rater_id: raterId, ratee_id: params[2],
        score: params[3], comment: params[4],
      });
      return this.ok([{ id: randomUUID(), created_at: new Date() }] as Row[], 1);
    }
    if (/^UPDATE (drivers|riders) SET rating_sum/i.test(s)) {
      const table = /UPDATE drivers/i.test(s) ? 'drivers' : 'riders';
      const row = this.rows(table).find((r) => r['user_id'] === params[1]);
      if (row) {
        row['rating_sum'] = String(Number(row['rating_sum'] ?? 0) + Number(params[0]));
        row['rating_count'] = String(Number(row['rating_count'] ?? 0) + 1);
      }
      return this.ok([], row ? 1 : 0);
    }

    // ---- disputes ----
    if (/^INSERT INTO disputes/i.test(s)) {
      const id = randomUUID();
      this.rows('disputes').push({
        id, ride_id: params[0], opened_by: params[1], status: 'OPEN',
        reason_code: params[2], description: params[3],
        resolution: null, created_at: new Date(), resolved_at: null,
      });
      return this.ok([{ id, created_at: new Date() }] as Row[], 1);
    }

    // ---- wallet top-ups ----
    if (/^INSERT INTO wallet_topups/i.test(s)) {
      this.rows('wallet_topups').push({
        driver_id: params[0], admin_id: params[1], amount_iqd: params[2],
        transaction_id: params[3], reference: params[4],
      });
      return this.ok([], 1);
    }

    // ---- admin: driver CRUD ----
    // Admin creates a driver: 2 params, and returns created_at. Distinct from
    // the rider self-signup INSERT, which carries a firebase_uid.
    if (/^INSERT INTO users \(role, phone_e164, display_name\)/i.test(s)) {
      const phone = params[0] as string;
      if (this.rows('users').some((u) => u['phone_e164'] === phone && u['role'] === 'DRIVER')) {
        throw Object.assign(new Error('duplicate key'), {
          code: '23505', constraint: 'users_phone_role_uq',
        });
      }
      const row: FakeRow = {
        id: randomUUID(), role: 'DRIVER', phone_e164: phone,
        display_name: params[1], is_active: true, created_at: new Date(),
      };
      this.rows('users').push(row);
      return this.ok([{ id: row['id'], created_at: row['created_at'] }] as Row[], 1);
    }

    if (/^INSERT INTO drivers \(user_id, vehicle_plate/i.test(s)) {
      this.rows('drivers').push({
        user_id: params[0], vehicle_plate: params[1], vehicle_model: params[2],
        vehicle_color: params[3], availability: 'OFFLINE', is_suspended: false,
        suspended_reason: null, rating_sum: '0', rating_count: '0',
      });
      return this.ok([], 1);
    }

    // The admin driver view: users JOIN drivers LEFT JOIN wallet balances.
    if (/^SELECT u\.id, u\.display_name, u\.phone_e164, u\.created_at/i.test(s)) {
      const single = /WHERE u\.id = \$1/i.test(s);
      const users = this.rows('users').filter((u) => {
        if (u['role'] !== 'DRIVER') return false;
        return single ? u['id'] === params[0] : true;
      });

      const rows = users
        .map((u) => {
          const d = this.rows('drivers').find((x) => x['user_id'] === u['id']);
          if (!d) return null;
          const completed = this.rows('rides').filter(
            (r) => r['driver_id'] === u['id'] && r['status'] === 'COMPLETED',
          ).length;
          return {
            id: u['id'], display_name: u['display_name'],
            phone_e164: u['phone_e164'], created_at: u['created_at'] ?? new Date(),
            availability: d['availability'], is_suspended: d['is_suspended'] ?? false,
            suspended_reason: d['suspended_reason'] ?? null,
            vehicle_plate: d['vehicle_plate'], vehicle_model: d['vehicle_model'],
            vehicle_color: d['vehicle_color'],
            rating_sum: d['rating_sum'] ?? '0', rating_count: d['rating_count'] ?? '0',
            balance_iqd: String(this.walletBalance(u['id'] as string)),
            rides_completed: String(completed),
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      return this.ok(rows as Row[]);
    }

    if (/^UPDATE users SET display_name/i.test(s)) {
      const user = this.rows('users').find((u) => u['id'] === params[1]);
      if (user) user['display_name'] = params[0];
      return this.ok([], user ? 1 : 0);
    }

    // The dynamic driver UPDATE built column-by-column by updateDriver.
    //
    // Explicitly EXCLUDES the availability and rating statements, which have
    // their own handlers further down. Matching them here would shadow those
    // and silently stop a driver being freed after a ride - the same shadowing
    // bug that was already caught once on the ON_TRIP path.
    if (
      /^UPDATE drivers SET /i.test(s) &&
      /WHERE user_id = \$\d+/i.test(s) &&
      !/availability = '/i.test(s) &&
      !/rating_sum/i.test(s)
    ) {
      const setClause = s.slice(0, s.search(/\sWHERE\s/i));
      const assignments = [...setClause.matchAll(/(\w+) = \$(\d+)/g)];
      const idIndex = /WHERE user_id = \$(\d+)/i.exec(s);
      if (!idIndex) return this.ok([], 0);

      const driver = this.rows('drivers').find(
        (d) => d['user_id'] === params[Number(idIndex[1]) - 1],
      );
      if (!driver) return this.ok([], 0);

      for (const [, column, index] of assignments) {
        driver[column!] = params[Number(index) - 1] as unknown;
      }
      return this.ok([], 1);
    }

    // ---- audit log ----
    if (/^INSERT INTO audit_log/i.test(s)) {
      this.rows('audit_log').push({
        actor_id: params[0], actor_role: params[1], action: params[2],
        target_type: params[3], target_id: params[4], result: params[5],
        correlation_id: params[6], metadata: params[7], created_at: new Date(),
      });
      return this.ok([], 1);
    }
    if (/^SELECT id, actor_id, actor_role, action/i.test(s)) {
      const rows = this.rows('audit_log').filter((r) =>
        /WHERE target_type/i.test(s)
          ? r['target_type'] === params[0] && r['target_id'] === params[1]
          : r['actor_id'] === params[0],
      );
      return this.ok(rows.map((r) => ({ ...r })) as Row[]);
    }

    // ---- users / auth ----
    if (/^SELECT id, role, display_name, phone_e164, is_active FROM users WHERE id = \$1/i.test(s)) {
      const found = this.rows('users').find((u) => u['id'] === params[0]);
      return this.ok(found ? ([{ ...found }] as Row[]) : []);
    }
    if (/^SELECT id, role, display_name, phone_e164, is_active FROM users WHERE phone_e164/i.test(s)) {
      const found = this.rows('users').find(
        (u) => u['phone_e164'] === params[0] && u['role'] === params[1],
      );
      return this.ok(found ? ([{ ...found }] as Row[]) : []);
    }
    if (/^INSERT INTO users/i.test(s)) {
      const row: FakeRow = {
        id: randomUUID(),
        role: 'RIDER',
        phone_e164: params[0],
        display_name: params[1],
        firebase_uid: params[2],
        is_active: true,
      };
      this.rows('users').push(row);
      return this.ok([{ ...row }] as Row[], 1);
    }
    if (/^UPDATE users SET firebase_uid/i.test(s)) {
      const user = this.rows('users').find((u) => u['id'] === params[1]);
      if (user) user['firebase_uid'] = params[0];
      return this.ok([], user ? 1 : 0);
    }
    if (/^INSERT INTO riders/i.test(s)) {
      this.rows('riders').push({ user_id: params[0] });
      return this.ok([], 1);
    }

    // ---- refresh tokens ----
    if (/^INSERT INTO refresh_tokens/i.test(s)) {
      this.rows('refresh_tokens').push({
        user_id: params[0], token_hash: params[1], expires_at: params[2], revoked_at: null,
        session_id: params[3],
      });
      return this.ok([], 1);
    }
    // Migration 0006. Placed inside the refresh-token block deliberately: a
    // generic `SELECT ... FROM refresh_tokens` handler added above this one
    // would shadow it, and the session check silently returning "live" for
    // everything is exactly the kind of fake-only pass this suite exists to
    // prevent.
    if (/^SELECT TRUE AS ok\s+FROM refresh_tokens/i.test(s)) {
      const now = params[1] as Date;
      const live = this.rows('refresh_tokens').some(
        (t) =>
          t['session_id'] === params[0] &&
          t['revoked_at'] === null &&
          (t['expires_at'] as Date) > now,
      );
      return this.ok(live ? ([{ ok: true }] as Row[]) : []);
    }
    if (/^UPDATE refresh_tokens SET revoked_at = \$1 WHERE token_hash/i.test(s)) {
      const now = params[0] as Date;
      const row = this.rows('refresh_tokens').find(
        (t) =>
          t['token_hash'] === params[1] &&
          t['revoked_at'] === null &&
          (t['expires_at'] as Date) > now,
      );
      if (!row) return this.ok([], 0);
      row['revoked_at'] = now;
      return this.ok([{ user_id: row['user_id'], session_id: row['session_id'] }] as Row[], 1);
    }
    if (/^UPDATE refresh_tokens SET revoked_at = \$1 WHERE user_id/i.test(s)) {
      let n = 0;
      for (const t of this.rows('refresh_tokens')) {
        if (t['user_id'] === params[1] && t['revoked_at'] === null) {
          t['revoked_at'] = params[0];
          n++;
        }
      }
      return this.ok([], n);
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

    if (/^SELECT user_id FROM drivers/i.test(s)) {
      const ids = params[0] as unknown as string[];
      const rows = this.rows('drivers')
        .filter(
          (d) =>
            ids.includes(d['user_id'] as string) &&
            d['availability'] === 'ONLINE' &&
            d['is_suspended'] !== true,
        )
        .map((d) => ({ user_id: d['user_id'] }));
      return this.ok(rows as Row[]);
    }

    // Two different questions share this prefix, and answering the second with
    // the first is how D-14 hid: the ownership check "is THIS driver the
    // offeree" was answered with "who is the offeree", which is true for
    // everybody. Ordered so the narrower query is matched first, and the
    // narrower one actually reads params[1].
    if (/^SELECT driver_id FROM ride_offers\s+WHERE ride_id = \$1 AND driver_id = \$2/i.test(s)) {
      const found = this.rows('ride_offers').find(
        (o) =>
          o['ride_id'] === params[0] &&
          o['driver_id'] === params[1] &&
          o['status'] === 'PENDING',
      );
      return this.ok(found ? ([{ driver_id: found['driver_id'] }] as Row[]) : []);
    }

    if (/^SELECT driver_id FROM ride_offers/i.test(s)) {
      const found = this.rows('ride_offers').find(
        (o) => o['ride_id'] === params[0] && o['status'] === 'PENDING',
      );
      return this.ok(found ? ([{ driver_id: found['driver_id'] }] as Row[]) : []);
    }

    if (/^SELECT DISTINCT ride_id FROM ride_offers/i.test(s)) {
      const now = params[0] as Date;
      const limit = params[1] as number;
      const seen = new Set<string>();
      for (const o of this.rows('ride_offers')) {
        if (o['status'] === 'PENDING' && (o['expires_at'] as Date) < now) {
          seen.add(o['ride_id'] as string);
        }
      }
      const rows = [...seen].slice(0, limit).map((ride_id) => ({ ride_id }));
      return this.ok(rows as Row[]);
    }

    if (/^INSERT INTO ride_offers/i.test(s)) {
      const [ride_id, driver_id, distance_m, expires_at] = params as [
        string, string, number, Date,
      ];
      const existing = this.rows('ride_offers').find(
        (o) => o['ride_id'] === ride_id && o['driver_id'] === driver_id,
      );
      if (existing) {
        existing['status'] = 'PENDING';
        existing['expires_at'] = expires_at;
        existing['responded_at'] = null;
      } else {
        this.rows('ride_offers').push({
          ride_id, driver_id, status: 'PENDING', distance_m, expires_at, responded_at: null,
        });
      }
      return this.ok([], 1);
    }

    if (/^UPDATE ride_offers SET status = 'TIMED_OUT'/i.test(s)) {
      let n = 0;
      for (const o of this.rows('ride_offers')) {
        if (o['ride_id'] === params[0] && o['status'] === 'PENDING') {
          o['status'] = 'TIMED_OUT';
          o['responded_at'] = new Date();
          n++;
        }
      }
      return this.ok([], n);
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
