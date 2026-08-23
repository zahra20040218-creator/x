import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PgDatabase } from '../../src/db/pg-database.js';
import {
  assertRealDatabase,
  createRealDatabase,
  isRealInfraRequested,
  truncateAll,
} from '../support/real-infra.js';

/**
 * The guarantees a fake cannot prove.
 *
 * Deliberately NOT a port of the 692-test suite. Most of those tests exercise
 * validation, presenters, the state-machine rule table and HTTP wiring — none
 * of which depend on PostgreSQL's semantics, and all of which the fake models
 * perfectly well. Re-running them against a real database would cost a
 * 103-site rewrite of fake-specific seeding helpers and prove almost nothing
 * new.
 *
 * What a fake genuinely cannot model is here:
 *
 *   - triggers (append-only ledger)
 *   - deferred constraints (balanced double-entry)
 *   - column types (BIGINT vs a JS number)
 *   - partial unique indexes (one active ride per driver)
 *   - CHECK constraints
 *   - **transaction isolation under real concurrency** — D-15, where the fake
 *     is not merely incomplete but actively wrong: it snapshots the whole
 *     database and restores it on any failure, so concurrent rollbacks erase a
 *     committed write.
 *
 * These require `REAL_INFRA=1` and real connection details. The suite fails
 * rather than skips when those are demanded and absent — see
 * `test/support/real-infra.ts`.
 */

const RUN = isRealInfraRequested();
const describeReal = RUN ? describe : describe.skip;

// Fixed ids so failures name a row rather than a UUID nobody can look up.
const RIDER = '11111111-1111-4111-8111-111111111111';
const DRIVER_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const DRIVER_B = 'bbbbbbbb-1111-4111-8111-111111111111';
const TRANSACTION = 'cccccccc-1111-4111-8111-111111111111';

describeReal('real PostgreSQL', () => {
  let db: PgDatabase;

  beforeAll(() => {
    db = createRealDatabase(10);
    // If this run is not actually against Postgres, fail here rather than
    // report green.
    assertRealDatabase(db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);

    await db.query(
      `INSERT INTO users (id, role, phone_e164, display_name)
       VALUES ($1,'RIDER','+9647700000001','راكب'),
              ($2,'DRIVER','+9647700000002','سائق أ'),
              ($3,'DRIVER','+9647700000003','سائق ب')`,
      [RIDER, DRIVER_A, DRIVER_B],
    );
    await db.query(`INSERT INTO riders (user_id) VALUES ($1)`, [RIDER]);
    await db.query(
      `INSERT INTO drivers (user_id, vehicle_plate, vehicle_model, vehicle_color)
       VALUES ($1,'11111','Corolla','أبيض'), ($2,'22222','Corolla','أسود')`,
      [DRIVER_A, DRIVER_B],
    );
  });

  async function createRide(status = 'REQUESTED'): Promise<string> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO rides
         (rider_id, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
          estimated_fare_iqd, estimated_distance_m, estimated_duration_s)
       VALUES ($1, $2::ride_status, 33.3061, 44.4213, 33.2989, 44.4361, 5000, 1500, 300)
       RETURNING id`,
      [RIDER, status],
    );
    return result.rows[0]!.id;
  }

  /**
   * Two entries that sum to zero, sharing one transaction_id.
   *
   * Both details are load-bearing: `transaction_id` is NOT NULL, and a
   * DEFERRABLE INITIALLY DEFERRED constraint trigger rejects the transaction at
   * COMMIT unless the entries for that id balance. An unbalanced pair would
   * fail for the wrong reason and make the append-only tests meaningless.
   */
  async function seedBalancedLedger(rideId: string): Promise<void> {
    // One transaction_id shared by both rows - generated here rather than with
    // gen_random_uuid(), which would be evaluated per row and produce two
    // separate, each-unbalanced transactions.
    await db.query(
      `INSERT INTO ledger_entries
         (transaction_id, ride_id, account_type, account_id, direction, amount_iqd, description)
       VALUES ($3, $1, 'DRIVER_WALLET',    $2, 'CREDIT', 5000, 'fare'),
              ($3, $1, 'DRIVER_CASH_HELD', $2, 'DEBIT',  5000, 'cash')`,
      [rideId, DRIVER_A, TRANSACTION],
    );
  }

  // -------------------------------------------------------------------------
  // D-15: the one the fake gets actively wrong
  // -------------------------------------------------------------------------

  describe('transaction isolation', () => {
    it('keeps a committed write when concurrent transactions roll back', async () => {
      const rideId = await createRide('OFFERED');

      // One transaction assigns the ride. Twenty others fail. Under the fake,
      // the rollbacks erase the winner's row; under real Postgres they must
      // not touch it.
      const attempts = [
        db.transaction(async (tx) => {
          await tx.query(`UPDATE rides SET driver_id = $1, status = 'ACCEPTED' WHERE id = $2`, [
            DRIVER_A,
            rideId,
          ]);
        }),
        ...Array.from({ length: 20 }, () =>
          db
            .transaction(async (tx) => {
              await tx.query(`SELECT 1 FROM rides WHERE id = $1`, [rideId]);
              throw new Error('deliberate rollback');
            })
            .catch(() => undefined),
        ),
      ];

      await Promise.all(attempts);

      const after = await db.query<{ driver_id: string | null; status: string }>(
        `SELECT driver_id, status FROM rides WHERE id = $1`,
        [rideId],
      );
      expect(after.rows[0]!.driver_id).toBe(DRIVER_A);
      expect(after.rows[0]!.status).toBe('ACCEPTED');
    });

    it('rolls back only the failing transaction', async () => {
      const rideId = await createRide();

      await expect(
        db.transaction(async (tx) => {
          await tx.query(`UPDATE rides SET estimated_fare_iqd = 9999 WHERE id = $1`, [rideId]);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      const after = await db.query<{ estimated_fare_iqd: string }>(
        `SELECT estimated_fare_iqd FROM rides WHERE id = $1`,
        [rideId],
      );
      expect(Number(after.rows[0]!.estimated_fare_iqd)).toBe(5000);
    });
  });

  // -------------------------------------------------------------------------
  // D-2's database half: the guarded UPDATE that backs the Redis claim
  // -------------------------------------------------------------------------

  describe('concurrent acceptance', () => {
    it('lets exactly one of twenty real concurrent transactions accept', async () => {
      const rideId = await createRide('OFFERED');

      // The production guard: UPDATE ... WHERE status = 'OFFERED'. Whoever
      // commits first flips the status; everyone else matches zero rows.
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          db
            .transaction(async (tx) => {
              const r = await tx.query(
                `UPDATE rides SET driver_id = $1, status = 'ACCEPTED'
                  WHERE id = $2 AND status = 'OFFERED'`,
                [i % 2 === 0 ? DRIVER_A : DRIVER_B, rideId],
              );
              return r.rowCount;
            })
            .catch(() => 0),
        ),
      );

      expect(results.filter((n) => n === 1)).toHaveLength(1);

      const events = await db.query<{ count: string }>(
        `SELECT count(*) AS count FROM rides WHERE id = $1 AND status = 'ACCEPTED'`,
        [rideId],
      );
      expect(Number(events.rows[0]!.count)).toBe(1);
    });

    it('enforces one active ride per driver at the index level', async () => {
      const first = await createRide('OFFERED');
      const second = await createRide('OFFERED');

      await db.query(`UPDATE rides SET driver_id = $1, status = 'ACCEPTED' WHERE id = $2`, [
        DRIVER_A,
        first,
      ]);

      // The backstop behind the Redis claim. If this does not fire, the claim
      // is the ONLY thing preventing a driver holding two rides.
      await expect(
        db.query(`UPDATE rides SET driver_id = $1, status = 'ACCEPTED' WHERE id = $2`, [
          DRIVER_A,
          second,
        ]),
      ).rejects.toThrow(/rides_one_active_per_driver_uq/);
    });
  });

  // -------------------------------------------------------------------------
  // Schema-level guarantees that only exist in the database
  // -------------------------------------------------------------------------

  describe('ledger', () => {
    it('is append-only: UPDATE is refused by the trigger', async () => {
      const rideId = await createRide('COMPLETED');
      await seedBalancedLedger(rideId);

      await expect(
        db.query(`UPDATE ledger_entries SET amount_iqd = 1 WHERE ride_id = $1`, [rideId]),
      ).rejects.toThrow();
    });

    it('is append-only: DELETE is refused by the trigger', async () => {
      const rideId = await createRide('COMPLETED');
      await seedBalancedLedger(rideId);

      await expect(
        db.query(`DELETE FROM ledger_entries WHERE ride_id = $1`, [rideId]),
      ).rejects.toThrow();
    });
  });

  describe('money columns', () => {
    it('are BIGINT, not floating point', async () => {
      const result = await db.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND (column_name LIKE '%_iqd' OR column_name = 'amount_iqd')`,
      );

      expect(result.rows.length).toBeGreaterThan(0);
      for (const row of result.rows) {
        expect(row.data_type).toBe('bigint');
      }
    });

    it('rejects a phone number that is not E.164 Iraqi', async () => {
      await expect(
        db.query(
          `INSERT INTO users (role, phone_e164, display_name)
           VALUES ('RIDER','07700000001','bad')`,
        ),
      ).rejects.toThrow(/users_phone_e164_format/);
    });
  });

  describe('sessions (migration 0006)', () => {
    it('has the session_id column and its partial index', async () => {
      const column = await db.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'refresh_tokens' AND column_name = 'session_id'`,
      );
      expect(column.rows).toHaveLength(1);

      const index = await db.query(
        `SELECT 1 FROM pg_indexes
          WHERE tablename = 'refresh_tokens'
            AND indexname = 'refresh_tokens_session_live_idx'`,
      );
      expect(index.rows).toHaveLength(1);
    });
  });
});
