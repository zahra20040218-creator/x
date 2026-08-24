import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PgDatabase } from '../../src/db/pg-database.js';
import { LedgerService } from '../../src/ledger/ledger.service.js';
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
const RIDER_B = '22222222-1111-4111-8111-111111111111';
const TRANSACTION = 'cccccccc-1111-4111-8111-111111111111';

describeReal('real PostgreSQL', () => {
  let db: PgDatabase;
  let ledger: LedgerService;

  beforeAll(() => {
    db = createRealDatabase(10);
    // If this run is not actually against Postgres, fail here rather than
    // report green.
    assertRealDatabase(db);
    ledger = new LedgerService();
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
              ($3,'DRIVER','+9647700000003','سائق ب'),
              ($4,'RIDER','+9647700000004','راكب ب')`,
      [RIDER, DRIVER_A, DRIVER_B, RIDER_B],
    );
    await db.query(`INSERT INTO riders (user_id) VALUES ($1), ($2)`, [RIDER, RIDER_B]);
    await db.query(
      `INSERT INTO drivers (user_id, vehicle_plate, vehicle_model, vehicle_color)
       VALUES ($1,'11111','Corolla','أبيض'), ($2,'22222','Corolla','أسود')`,
      [DRIVER_A, DRIVER_B],
    );
  });

  /**
   * `final_fare_iqd` and `commission_iqd` are set for COMPLETED rides because
   * of the `rides_completed_has_fare` CHECK - a completed ride without a fare
   * is not a valid row. The fake never enforced this, so the first real run
   * rejected it.
   */
  async function createRide(status = 'REQUESTED', rider = RIDER): Promise<string> {
    const completed = status === 'COMPLETED';
    const result = await db.query<{ id: string }>(
      `INSERT INTO rides
         (rider_id, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
          estimated_fare_iqd, estimated_distance_m, estimated_duration_s,
          driver_id, final_fare_iqd, commission_iqd, accepted_at, started_at, completed_at)
       VALUES ($1, $2::ride_status, 33.3061, 44.4213, 33.2989, 44.4361, 5000, 1500, 300,
               $3, $4, $5, $6, $6, $6)
       RETURNING id`,
      [
        rider,
        status,
        completed ? DRIVER_A : null,
        completed ? 5000 : null,
        completed ? 0 : null,
        completed ? new Date() : null,
      ],
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
      // Two riders: one active ride per RIDER is separately enforced, and
      // tripping that constraint would never reach the driver one.
      const first = await createRide('OFFERED', RIDER);
      const second = await createRide('OFFERED', RIDER_B);

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
    it('are BIGINT in every table that stores money', async () => {
      // BASE TABLES only. The first run of this test also matched
      // `driver_wallet_balances.balance_iqd`, which is a VIEW column and comes
      // back `numeric` simply because SUM(bigint) is numeric in PostgreSQL.
      // That is not a CLAUDE.md §6.1 violation - nothing is stored as numeric,
      // and numeric is exact rather than floating point. Asserting on views
      // was the test being wrong, not the schema.
      const result = await db.query<{ table_name: string; data_type: string }>(
        `SELECT c.table_name, c.data_type
           FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = current_schema()
            AND t.table_type = 'BASE TABLE'
            AND c.column_name LIKE '%_iqd'`,
      );

      expect(result.rows.length).toBeGreaterThan(0);
      for (const row of result.rows) {
        expect(`${row.table_name}.${row.data_type}`).toBe(`${row.table_name}.bigint`);
      }
    });

    /**
     * The consequence of that numeric view column, which the fake hid.
     *
     * node-postgres returns `numeric` (and `bigint`) as a STRING, because both
     * can exceed JS integer precision. The fake returns JS numbers, so any code
     * doing arithmetic straight off the row would look correct in every test
     * and be wrong in production.
     */
    it('returns wallet balances as strings, which the code must parse', async () => {
      const rideId = await createRide('COMPLETED');
      await seedBalancedLedger(rideId);

      const result = await db.query<{ balance_iqd: unknown }>(
        `SELECT balance_iqd FROM driver_wallet_balances WHERE driver_id = $1`,
        [DRIVER_A],
      );

      expect(typeof result.rows[0]!.balance_iqd).toBe('string');
      expect(Number(result.rows[0]!.balance_iqd)).toBe(5000);
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

  // -------------------------------------------------------------------------
  // Statement pagination
  //
  // The cursor was the last row's `created_at`, and the next page asked for
  // `created_at < cursor`. In PostgreSQL `now()` is the TRANSACTION timestamp,
  // so every wallet row a transaction writes carries an identical
  // `created_at` - and `ORDER BY created_at DESC` alone is not a total order.
  // A page boundary landing inside such a group therefore dropped the rest of
  // it, silently, off a driver's money statement.
  //
  // Only a real PostgreSQL shows this: it needs `now()`'s real semantics and a
  // real non-deterministic tie order.
  // -------------------------------------------------------------------------

  describe('wallet statement pagination', () => {
    /**
     * Six wallet credits sharing one timestamp, written by one transaction -
     * exactly what a settlement batch looks like.
     */
    async function seedSameInstant(count: number): Promise<void> {
      // Balanced PAIRS, not bare credits: the deferred trigger rejects a
      // transaction whose rows do not sum to zero, and it was right to reject
      // the first version of this seed. One INSERT means one transaction,
      // which is what makes every created_at identical - the condition the
      // bug needs.
      const values = Array.from({ length: count }, (_, i) => {
        const tx = `$${i + 2}`;
        return `(${tx}, 'DRIVER_WALLET',    $1, 'CREDIT', ${1000 + i}, 'batch'),
                (${tx}, 'DRIVER_CASH_HELD', $1, 'DEBIT',  ${1000 + i}, 'cash')`;
      }).join(',');

      const txIds = await db.query<{ id: string }>(
        `SELECT gen_random_uuid() AS id FROM generate_series(1, $1)`,
        [count],
      );

      await db.query(
        `INSERT INTO ledger_entries
           (transaction_id, account_type, account_id, direction, amount_iqd, description)
         VALUES ${values}`,
        [DRIVER_A, ...txIds.rows.map((r) => r.id)],
      );
    }

    async function pageThrough(pageSize: number): Promise<string[]> {
      const seen: string[] = [];
      let cursor: string | undefined;

      // Bounded so a cursor that fails to advance ends the test rather than
      // hanging it.
      for (let page = 0; page < 20; page++) {
        const rows = await ledger.entriesFor(db, DRIVER_A, {
          limit: pageSize,
          ...(cursor ? { after: cursor } : {}),
        });
        if (rows.length === 0) break;
        seen.push(...rows.map((r) => r.id));
        if (rows.length < pageSize) break;
        cursor = rows.at(-1)!.id;
      }
      return seen;
    }

    it('every row appears exactly once when a page boundary splits one instant', async () => {
      await seedSameInstant(6);

      // The wallet side only - the balancing DRIVER_CASH_HELD rows are not
      // part of the statement this query serves.
      const all = await db.query<{ id: string }>(
        `SELECT id FROM ledger_entries
          WHERE account_id = $1 AND account_type = 'DRIVER_WALLET'`,
        [DRIVER_A],
      );
      expect(all.rows).toHaveLength(6);

      // Page size 2 across 6 rows that all share created_at: boundaries fall
      // inside the group twice.
      const seen = await pageThrough(2);

      expect(new Set(seen).size).toBe(seen.length); // no row served twice
      expect(new Set(seen)).toEqual(new Set(all.rows.map((r) => r.id))); // none lost
    });

    it('a driver is never shown less than they earned', async () => {
      await seedSameInstant(6);

      const expected = 1000 + 1001 + 1002 + 1003 + 1004 + 1005;
      const seen = await pageThrough(2);

      const rows = await db.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_iqd), 0) AS total
           FROM ledger_entries WHERE id = ANY($1::uuid[])`,
        [seen],
      );

      // The failure this guards is money the driver earned and never saw.
      expect(Number(rows.rows[0]!.total)).toBe(expected);
    });

    it('paginates correctly when timestamps do differ', async () => {
      for (let i = 0; i < 5; i++) {
        // Separate statements, so each pair lands at its own instant.
        await db.query(
          `INSERT INTO ledger_entries
             (transaction_id, account_type, account_id, direction, amount_iqd, created_at)
           VALUES ($3, 'DRIVER_WALLET',    $1, 'CREDIT', 500, now() - ($2 || ' minutes')::interval),
                  ($3, 'DRIVER_CASH_HELD', $1, 'DEBIT',  500, now() - ($2 || ' minutes')::interval)`,
          [DRIVER_A, String(i), randomUUID()],
        );
      }

      const seen = await pageThrough(2);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });
  });

});
