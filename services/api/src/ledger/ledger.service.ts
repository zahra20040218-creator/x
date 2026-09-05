import { randomUUID } from 'node:crypto';

import type { Queryable, SqlValue } from '../db/db.port.js';
import { iqd, parseSignedIqdFromDb, type IqdAmount, type SignedIqdAmount } from '../money/iqd.js';
import {
  isBalanced,
  netOf,
  UnbalancedLedgerError,
  type LedgerCommand,
  type LedgerEntry,
} from './ledger.types.js';

/**
 * The ledger. CLAUDE.md §6.2, §6.3, §6.4, §12.3.
 *
 * Three rules, all enforced rather than documented:
 *
 *  1. **Every write is balanced.** `write()` refuses to issue SQL for a set of
 *     commands that does not sum to zero. The database also refuses, via a
 *     deferred constraint trigger. Both checks exist because they fail at
 *     different times: this one gives a clear error at the call site, the
 *     trigger catches anything that bypasses this class.
 *
 *  2. **Append-only.** There is no update method and no delete method on this
 *     class - not "there is one but you should not call it". Corrections are
 *     new offsetting entries via `correct()`. The database enforces the same
 *     with a trigger that raises on UPDATE or DELETE.
 *
 *  3. **Balances are derived.** `balanceFor()` sums the entries. There is no
 *     stored counter to drift out of sync, which is the specific failure
 *     CLAUDE.md §6.4 is written to prevent.
 *
 * ## The money model for a cash ride
 *
 * A rider hands cash to a driver. The platform never touches the money, but it
 * still has to be recorded, because the platform's claim on the commission and
 * the driver's earnings both derive from it.
 *
 *   DRIVER_CASH_HELD   DEBIT   fare        the driver is holding this cash
 *   PLATFORM_REVENUE   CREDIT  commission  the platform earned this
 *   DRIVER_WALLET      CREDIT  earnings    the driver earned this
 *
 * which nets to zero because `earnings = fare - commission`. At the shipped
 * default of 0 bps (CLAUDE.md §6.5) the commission row is omitted - a
 * zero-amount row is forbidden by the schema - and the remaining two rows
 * still balance. See DECISIONS.md D-003 for why the wallet is modelled as
 * cumulative earnings rather than a float the platform holds - and for the
 * condition under which that model has to be revisited.
 */
export class LedgerService {
  /**
   * Write one balanced transaction.
   *
   * `q` is a Queryable rather than the pool, so this composes into a caller's
   * transaction. Ride settlement passes its transaction here, which is what
   * makes the status change and the ledger rows commit together or not at all.
   */
  async write(
    q: Queryable,
    commands: readonly LedgerCommand[],
    options: { rideId?: string | null; transactionId?: string } = {},
  ): Promise<string> {
    if (!isBalanced(commands)) {
      throw new UnbalancedLedgerError(commands, netOf(commands));
    }

    for (const command of commands) {
      // Belt and braces: the branded type already makes a fractional amount
      // hard to construct, but commands can arrive from JSON at a boundary.
      iqd(command.amountIqd);

      if (command.accountType === 'PLATFORM_REVENUE' && command.accountId !== null) {
        throw new Error('PLATFORM_REVENUE entries must not name an account holder.');
      }
      if (command.accountType !== 'PLATFORM_REVENUE' && command.accountId === null) {
        throw new Error(`${command.accountType} entries require an accountId.`);
      }
    }

    const transactionId = options.transactionId ?? randomUUID();
    const rideId = options.rideId ?? null;

    // One multi-row INSERT rather than N round trips: under transaction pooling
    // every statement is a network hop, and settlement is on the hot path.
    const values: unknown[] = [];
    const tuples = commands.map((command, index) => {
      const base = index * 6;
      values.push(
        transactionId,
        rideId,
        command.accountType,
        command.accountId,
        command.direction,
        command.amountIqd,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${
        commands.length * 6 + index + 1
      })`;
    });
    for (const command of commands) values.push(command.description);

    await q.query(
      `INSERT INTO ledger_entries
         (transaction_id, ride_id, account_type, account_id, direction, amount_iqd, description)
       VALUES ${tuples.join(', ')}`,
      values as never,
    );

    return transactionId;
  }

  /**
   * Record a completed cash ride.
   *
   * Called inside the settlement transaction, never on its own.
   */
  async recordRideSettlement(
    q: Queryable,
    input: {
      rideId: string;
      driverId: string;
      fareIqd: IqdAmount;
      commissionIqd: IqdAmount;
    },
  ): Promise<string> {
    const { rideId, driverId, fareIqd, commissionIqd } = input;

    if (commissionIqd > fareIqd) {
      throw new Error(
        `Commission (${commissionIqd}) cannot exceed the fare (${fareIqd}) on ride ${rideId}.`,
      );
    }

    const driverEarningsIqd = iqd(fareIqd - commissionIqd);

    const commands: LedgerCommand[] = [
      {
        accountType: 'DRIVER_CASH_HELD',
        accountId: driverId,
        direction: 'DEBIT',
        amountIqd: fareIqd,
        description: 'Cash fare collected from rider',
      },
    ];

    // A zero-amount row is forbidden by the schema, so at the default 0 bps the
    // revenue row is simply absent. The remaining pair still balances.
    if (commissionIqd > 0) {
      commands.push({
        accountType: 'PLATFORM_REVENUE',
        accountId: null,
        direction: 'CREDIT',
        amountIqd: commissionIqd,
        description: 'Platform commission',
      });
    }

    if (driverEarningsIqd > 0) {
      commands.push({
        accountType: 'DRIVER_WALLET',
        accountId: driverId,
        direction: 'CREDIT',
        amountIqd: driverEarningsIqd,
        description: 'Driver earnings',
      });
    }

    return this.write(q, commands, { rideId });
  }

  /**
   * Credit a driver wallet from an admin top-up.
   *
   * `transactionId` is supplied by the caller so it can be tied to the
   * idempotency key: replaying a top-up must not credit twice, and
   * `wallet_topups.transaction_id` is UNIQUE, so a duplicate fails at the
   * database rather than relying on the caller having checked first.
   */
  async recordTopUp(
    q: Queryable,
    input: {
      driverId: string;
      amountIqd: IqdAmount;
      transactionId: string;
      reference?: string;
    },
  ): Promise<string> {
    const description = input.reference
      ? `Manual wallet top-up (${input.reference})`
      : 'Manual wallet top-up';

    return this.write(
      q,
      [
        {
          accountType: 'MANUAL_ADJUSTMENT',
          accountId: input.driverId,
          direction: 'DEBIT',
          amountIqd: input.amountIqd,
          description,
        },
        {
          accountType: 'DRIVER_WALLET',
          accountId: input.driverId,
          direction: 'CREDIT',
          amountIqd: input.amountIqd,
          description,
        },
      ],
      { transactionId: input.transactionId },
    );
  }

  /**
   * Apply a correction. CLAUDE.md §6.3: corrections are NEW offsetting entries.
   *
   * A positive amount credits the driver, a negative one debits them. There is
   * deliberately no code path anywhere that edits the entry being corrected.
   */
  async correct(
    q: Queryable,
    input: {
      driverId: string;
      amountIqd: SignedIqdAmount;
      reason: string;
      rideId?: string | null;
      transactionId?: string;
    },
  ): Promise<string> {
    if (input.amountIqd === 0) {
      throw new Error('A correction of zero has no effect; refusing to write empty entries.');
    }

    const magnitude = iqd(Math.abs(input.amountIqd));
    const creditsDriver = input.amountIqd > 0;

    return this.write(
      q,
      [
        {
          accountType: 'DRIVER_WALLET',
          accountId: input.driverId,
          direction: creditsDriver ? 'CREDIT' : 'DEBIT',
          amountIqd: magnitude,
          description: `Correction: ${input.reason}`,
        },
        {
          accountType: 'MANUAL_ADJUSTMENT',
          accountId: input.driverId,
          direction: creditsDriver ? 'DEBIT' : 'CREDIT',
          amountIqd: magnitude,
          description: `Correction: ${input.reason}`,
        },
      ],
      {
        rideId: input.rideId ?? null,
        ...(input.transactionId ? { transactionId: input.transactionId } : {}),
      },
    );
  }

  /**
   * CLAUDE.md §6.4 - derived, never stored.
   *
   * A driver's balance can legitimately be negative (they owe commission), so
   * this returns a signed amount.
   */
  async balanceFor(q: Queryable, driverId: string): Promise<SignedIqdAmount> {
    const result = await q.query<{ balance_iqd: string | null }>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_iqd ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN direction = 'DEBIT'  THEN amount_iqd ELSE 0 END), 0)
              AS balance_iqd
         FROM ledger_entries
        WHERE account_type = 'DRIVER_WALLET' AND account_id = $1`,
      [driverId],
    );

    return parseSignedIqdFromDb(result.rows[0]?.balance_iqd ?? 0);
  }

  /**
   * What the platform has earned, derived the same way a wallet is.
   *
   * ## Why this did not exist
   *
   * `PLATFORM_REVENUE` was write-only across the whole codebase. `write()` and
   * `recordRideSettlement()` emit those rows; `balanceFor` and `entriesFor`
   * both hardcode `account_type = 'DRIVER_WALLET'`, the materialised view is
   * per-driver, and no admin route selected the account type. The platform
   * could bank revenue it had no way to read.
   *
   * That was harmless only because `commission_bps` ships at 0 (CLAUDE.md
   * §6.5), so no revenue row has ever been written. It stops being harmless the
   * moment any income model is switched on - which is exactly what D-020
   * contemplates - so this lands BEFORE the revenue, not after it.
   *
   * ## Direction
   *
   * `PLATFORM_REVENUE` is credited when the platform earns and debited when
   * that is reversed, so CREDIT-minus-DEBIT is positive for real income and the
   * sign means the same thing it means on a wallet. Signed, not absolute: a day
   * whose only movement is a refund is legitimately negative, and clamping it
   * to zero would hide the refund.
   *
   * `account_id IS NULL` is not a filter, it is the invariant - `write()`
   * refuses a PLATFORM_REVENUE row that names an account (CLAUDE.md §6.2), so
   * the condition is stated to document that rather than to select among rows.
   *
   * ## Index
   *
   * Served by `ledger_account_keyset_idx (account_type, account_id, created_at
   * DESC, id DESC)` from migration 0008 - the leading column is the account
   * type, so this aggregate is an index range scan, not a table scan, which is
   * what CLAUDE.md §3.4 requires of any query on `ledger_entries`.
   */
  async platformRevenue(
    q: Queryable,
    range: { since?: Date; until?: Date } = {},
  ): Promise<SignedIqdAmount> {
    const conditions = [`account_type = 'PLATFORM_REVENUE'`, 'account_id IS NULL'];
    const params: SqlValue[] = [];

    if (range.since) {
      params.push(range.since);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (range.until) {
      params.push(range.until);
      conditions.push(`created_at < $${params.length}`);
    }

    const result = await q.query<{ balance_iqd: string | null }>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_iqd ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN direction = 'DEBIT'  THEN amount_iqd ELSE 0 END), 0)
              AS balance_iqd
         FROM ledger_entries
        WHERE ${conditions.join(' AND ')}`,
      params,
    );

    return parseSignedIqdFromDb(result.rows[0]?.balance_iqd ?? 0);
  }

  /**
   * One page of a driver's statement, newest first.
   *
   * `after` is the ID of the last row already served, and the query resolves
   * its position itself. It is not a timestamp for two reasons that both cost
   * a driver money: `now()` is the transaction timestamp, so a settlement's
   * rows share a `created_at` and `created_at < cursor` skips the rest of the
   * group; and `timestamptz` is microsecond precision while a JavaScript Date
   * is millisecond, so a timestamp that round-trips through JSON no longer
   * matches the row it came from. See http/cursor.ts.
   *
   * Served by `ledger_account_keyset_idx`
   * (account_type, account_id, created_at DESC, id DESC) - migration 0008.
   */
  async entriesFor(
    q: Queryable,
    driverId: string,
    options: { limit?: number; after?: string } = {},
  ): Promise<LedgerEntry[]> {
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);

    const result = await q.query<{
      id: string;
      transaction_id: string;
      ride_id: string | null;
      account_type: LedgerEntry['accountType'];
      account_id: string | null;
      direction: LedgerEntry['direction'];
      amount_iqd: string;
      description: string;
      created_at: Date;
    }>(
      `SELECT id, transaction_id, ride_id, account_type, account_id,
              direction, amount_iqd, description, created_at
         FROM ledger_entries
        WHERE account_type = 'DRIVER_WALLET'
          AND account_id = $1
          AND ($2::uuid IS NULL OR (created_at, id) < (
                SELECT created_at, id FROM ledger_entries WHERE id = $2
              ))
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [driverId, options.after ?? null, limit],
    );

    return result.rows.map((row) => ({
      id: row.id,
      transactionId: row.transaction_id,
      rideId: row.ride_id,
      accountType: row.account_type,
      accountId: row.account_id,
      direction: row.direction,
      amountIqd: iqd(Number(row.amount_iqd)),
      description: row.description,
      createdAt: row.created_at,
    }));
  }

  /**
   * Reconciliation: find any transaction whose entries do not sum to zero.
   *
   * The deferred trigger should make this impossible, so a non-empty result
   * means something bypassed both this class and the trigger. It exists because
   * "impossible" and "verified nightly" are different assurances, and only one
   * of them tells you the day it stops being true.
   */
  async findUnbalancedTransactions(q: Queryable, limit = 100): Promise<
    Array<{ transactionId: string; netIqd: number }>
  > {
    const result = await q.query<{ transaction_id: string; net: string }>(
      `SELECT transaction_id,
              SUM(CASE WHEN direction = 'CREDIT' THEN amount_iqd ELSE -amount_iqd END) AS net
         FROM ledger_entries
        GROUP BY transaction_id
       HAVING SUM(CASE WHEN direction = 'CREDIT' THEN amount_iqd ELSE -amount_iqd END) <> 0
        LIMIT $1`,
      [limit],
    );

    return result.rows.map((row) => ({
      transactionId: row.transaction_id,
      netIqd: Number(row.net),
    }));
  }
}
