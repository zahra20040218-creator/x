import { beforeEach, describe, expect, it } from 'vitest';

import type { Queryable, QueryResult, SqlValue } from '../db/db.port.js';
import { iqd, signedIqd } from '../money/iqd.js';
import { LedgerService } from './ledger.service.js';
import { isBalanced, netOf, UnbalancedLedgerError, type LedgerCommand } from './ledger.types.js';

const DRIVER = 'dddddddd-0000-4000-8000-000000000001';
const OTHER_DRIVER = 'dddddddd-0000-4000-8000-000000000002';
const RIDE = 'rrrrrrrr-0000-4000-8000-000000000001';

interface StoredEntry {
  transactionId: string;
  rideId: string | null;
  accountType: string;
  accountId: string | null;
  direction: 'DEBIT' | 'CREDIT';
  amountIqd: number;
  description: string;
  createdAt: Date;
}

/**
 * An in-memory stand-in for the ledger table.
 *
 * It records every statement so the tests can assert what SQL was issued (in
 * particular that no UPDATE or DELETE is ever issued), and it computes balances
 * from the rows it stored so the service's own arithmetic is exercised rather
 * than mocked away.
 *
 * It does NOT enforce the database's constraints - the balance trigger, the
 * append-only trigger and the positive-amount CHECK are the database's job and
 * are covered in test/integration/ledger.test.ts against a real Postgres. What
 * is proved here is that the service never even attempts a bad write.
 */
class FakeLedgerDb implements Queryable {
  readonly statements: Array<{ sql: string; params: readonly SqlValue[] }> = [];
  readonly entries: StoredEntry[] = [];
  private sequence = 0;

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<QueryResult<Row>> {
    this.statements.push({ sql, params });
    const normalised = sql.trim().toUpperCase();

    if (normalised.startsWith('INSERT INTO LEDGER_ENTRIES')) {
      this.recordInsert(params);
      return { rows: [], rowCount: params.length / 7 };
    }

    if (normalised.includes('FROM LEDGER_ENTRIES') && normalised.includes('AS BALANCE_IQD')) {
      const driverId = params[0] as string;
      const balance = this.entries
        .filter((e) => e.accountType === 'DRIVER_WALLET' && e.accountId === driverId)
        .reduce((sum, e) => sum + (e.direction === 'CREDIT' ? e.amountIqd : -e.amountIqd), 0);
      return { rows: [{ balance_iqd: String(balance) } as Row], rowCount: 1 };
    }

    if (normalised.includes('GROUP BY TRANSACTION_ID')) {
      const byTransaction = new Map<string, number>();
      for (const e of this.entries) {
        const net = (byTransaction.get(e.transactionId) ?? 0) +
          (e.direction === 'CREDIT' ? e.amountIqd : -e.amountIqd);
        byTransaction.set(e.transactionId, net);
      }
      const rows = [...byTransaction.entries()]
        .filter(([, net]) => net !== 0)
        .map(([transaction_id, net]) => ({ transaction_id, net: String(net) }) as Row);
      return { rows, rowCount: rows.length };
    }

    if (normalised.includes('FROM LEDGER_ENTRIES')) {
      const driverId = params[0] as string;
      const rows = this.entries
        .filter((e) => e.accountType === 'DRIVER_WALLET' && e.accountId === driverId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(
          (e, index) =>
            ({
              id: `entry-${index}`,
              transaction_id: e.transactionId,
              ride_id: e.rideId,
              account_type: e.accountType,
              account_id: e.accountId,
              direction: e.direction,
              amount_iqd: String(e.amountIqd),
              description: e.description,
              created_at: e.createdAt,
            }) as Row,
        );
      return { rows, rowCount: rows.length };
    }

    return { rows: [], rowCount: 0 };
  }

  /** Mirrors the parameter layout built by LedgerService.write(). */
  private recordInsert(params: readonly SqlValue[]): void {
    const rowCount = params.length / 7;
    for (let i = 0; i < rowCount; i++) {
      const base = i * 6;
      this.entries.push({
        transactionId: params[base] as string,
        rideId: params[base + 1] as string | null,
        accountType: params[base + 2] as string,
        accountId: params[base + 3] as string | null,
        direction: params[base + 4] as 'DEBIT' | 'CREDIT',
        amountIqd: params[base + 5] as number,
        description: params[rowCount * 6 + i] as string,
        createdAt: new Date(Date.UTC(2026, 0, 1) + this.sequence++ * 1_000),
      });
    }
  }

  balanceOf(driverId: string): number {
    return this.entries
      .filter((e) => e.accountType === 'DRIVER_WALLET' && e.accountId === driverId)
      .reduce((sum, e) => sum + (e.direction === 'CREDIT' ? e.amountIqd : -e.amountIqd), 0);
  }

  transactionIds(): string[] {
    return [...new Set(this.entries.map((e) => e.transactionId))];
  }

  netOfTransaction(transactionId: string): number {
    return this.entries
      .filter((e) => e.transactionId === transactionId)
      .reduce((sum, e) => sum + (e.direction === 'CREDIT' ? e.amountIqd : -e.amountIqd), 0);
  }
}

describe('ledger.types', () => {
  const credit = (amount: number): LedgerCommand => ({
    accountType: 'DRIVER_WALLET',
    accountId: DRIVER,
    direction: 'CREDIT',
    amountIqd: iqd(amount),
    description: '',
  });
  const debit = (amount: number): LedgerCommand => ({
    accountType: 'MANUAL_ADJUSTMENT',
    accountId: DRIVER,
    direction: 'DEBIT',
    amountIqd: iqd(amount),
    description: '',
  });

  it('nets credits against debits', () => {
    expect(netOf([credit(100), debit(100)])).toBe(0);
    expect(netOf([credit(100), debit(60)])).toBe(40);
    expect(netOf([])).toBe(0);
  });

  it('requires at least two entries to be balanced', () => {
    expect(isBalanced([credit(100), debit(100)])).toBe(true);
    expect(isBalanced([])).toBe(false);
    // A single zero-net entry is not double-entry, however tempting.
    expect(isBalanced([credit(0)])).toBe(false);
    expect(isBalanced([credit(100), debit(60)])).toBe(false);
  });
});

describe('LedgerService', () => {
  let db: FakeLedgerDb;
  let ledger: LedgerService;

  beforeEach(() => {
    db = new FakeLedgerDb();
    ledger = new LedgerService();
  });

  // -------------------------------------------------------------------------
  // CLAUDE.md §6.2 - balance
  // -------------------------------------------------------------------------

  describe('write', () => {
    it('writes a balanced pair', async () => {
      const transactionId = await ledger.write(db, [
        {
          accountType: 'MANUAL_ADJUSTMENT',
          accountId: DRIVER,
          direction: 'DEBIT',
          amountIqd: iqd(10_000),
          description: 'top-up',
        },
        {
          accountType: 'DRIVER_WALLET',
          accountId: DRIVER,
          direction: 'CREDIT',
          amountIqd: iqd(10_000),
          description: 'top-up',
        },
      ]);

      expect(db.entries).toHaveLength(2);
      expect(db.netOfTransaction(transactionId)).toBe(0);
    });

    it('refuses an unbalanced transaction and writes nothing', async () => {
      await expect(
        ledger.write(db, [
          {
            accountType: 'DRIVER_WALLET',
            accountId: DRIVER,
            direction: 'CREDIT',
            amountIqd: iqd(10_000),
            description: 'x',
          },
          {
            accountType: 'MANUAL_ADJUSTMENT',
            accountId: DRIVER,
            direction: 'DEBIT',
            amountIqd: iqd(9_000),
            description: 'x',
          },
        ]),
      ).rejects.toThrow(UnbalancedLedgerError);

      expect(db.entries).toHaveLength(0);
    });

    it('refuses a single-entry transaction', async () => {
      await expect(
        ledger.write(db, [
          {
            accountType: 'DRIVER_WALLET',
            accountId: DRIVER,
            direction: 'CREDIT',
            amountIqd: iqd(100),
            description: 'x',
          },
        ]),
      ).rejects.toThrow(UnbalancedLedgerError);
      expect(db.entries).toHaveLength(0);
    });

    it('refuses an empty transaction', async () => {
      await expect(ledger.write(db, [])).rejects.toThrow(UnbalancedLedgerError);
    });

    it('refuses a fractional amount', async () => {
      await expect(
        ledger.write(db, [
          {
            accountType: 'DRIVER_WALLET',
            accountId: DRIVER,
            direction: 'CREDIT',
            amountIqd: 100.5 as never,
            description: 'x',
          },
          {
            accountType: 'MANUAL_ADJUSTMENT',
            accountId: DRIVER,
            direction: 'DEBIT',
            amountIqd: 100.5 as never,
            description: 'x',
          },
        ]),
      ).rejects.toThrow(/not an integer/);
      expect(db.entries).toHaveLength(0);
    });

    it('refuses PLATFORM_REVENUE with an account holder', async () => {
      await expect(
        ledger.write(db, [
          {
            accountType: 'PLATFORM_REVENUE',
            accountId: DRIVER,
            direction: 'CREDIT',
            amountIqd: iqd(100),
            description: 'x',
          },
          {
            accountType: 'DRIVER_WALLET',
            accountId: DRIVER,
            direction: 'DEBIT',
            amountIqd: iqd(100),
            description: 'x',
          },
        ]),
      ).rejects.toThrow(/must not name an account holder/);
    });

    it('refuses a driver account with no account holder', async () => {
      await expect(
        ledger.write(db, [
          {
            accountType: 'DRIVER_WALLET',
            accountId: null,
            direction: 'CREDIT',
            amountIqd: iqd(100),
            description: 'x',
          },
          {
            accountType: 'PLATFORM_REVENUE',
            accountId: null,
            direction: 'DEBIT',
            amountIqd: iqd(100),
            description: 'x',
          },
        ]),
      ).rejects.toThrow(/require an accountId/);
    });
  });

  // -------------------------------------------------------------------------
  // CLAUDE.md §6.3 / §12.3 - append only
  // -------------------------------------------------------------------------

  describe('append-only', () => {
    it('exposes no update or delete method', () => {
      const surface = Object.getOwnPropertyNames(LedgerService.prototype);
      expect(surface.some((m) => /update|delete|remove|void|reverse/i.test(m))).toBe(false);
    });

    it('never issues an UPDATE or DELETE against ledger_entries', async () => {
      await ledger.recordTopUp(db, {
        driverId: DRIVER,
        amountIqd: iqd(10_000),
        transactionId: 'tx-1',
      });
      await ledger.recordRideSettlement(db, {
        rideId: RIDE,
        driverId: DRIVER,
        fareIqd: iqd(12_500),
        commissionIqd: iqd(0),
      });
      await ledger.correct(db, {
        driverId: DRIVER,
        amountIqd: signedIqd(-500),
        reason: 'dispute',
      });
      await ledger.balanceFor(db, DRIVER);

      for (const { sql } of db.statements) {
        expect(sql).not.toMatch(/\bUPDATE\b/i);
        expect(sql).not.toMatch(/\bDELETE\b/i);
      }
    });

    it('applies a correction as new offsetting entries, leaving the original intact', async () => {
      await ledger.recordTopUp(db, {
        driverId: DRIVER,
        amountIqd: iqd(10_000),
        transactionId: 'tx-1',
      });
      const before = [...db.entries];

      await ledger.correct(db, {
        driverId: DRIVER,
        amountIqd: signedIqd(-2_000),
        reason: 'overpaid',
      });

      // Original rows are byte-for-byte untouched.
      expect(db.entries.slice(0, before.length)).toEqual(before);
      expect(db.entries.length).toBe(before.length + 2);
      expect(db.balanceOf(DRIVER)).toBe(8_000);
    });
  });

  // -------------------------------------------------------------------------
  // Ride settlement
  // -------------------------------------------------------------------------

  describe('recordRideSettlement', () => {
    // CLAUDE.md §6.5 - the shipped v1 configuration.
    it('writes a balanced pair at the default zero commission', async () => {
      const transactionId = await ledger.recordRideSettlement(db, {
        rideId: RIDE,
        driverId: DRIVER,
        fareIqd: iqd(12_500),
        commissionIqd: iqd(0),
      });

      expect(db.entries).toHaveLength(2);
      expect(db.netOfTransaction(transactionId)).toBe(0);
      expect(db.entries.map((e) => e.accountType).sort()).toEqual([
        'DRIVER_CASH_HELD',
        'DRIVER_WALLET',
      ]);
      // No zero-amount row was attempted - the schema forbids one.
      expect(db.entries.every((e) => e.amountIqd > 0)).toBe(true);
      expect(db.balanceOf(DRIVER)).toBe(12_500);
    });

    it('writes three balanced rows when a commission applies', async () => {
      const transactionId = await ledger.recordRideSettlement(db, {
        rideId: RIDE,
        driverId: DRIVER,
        fareIqd: iqd(10_000),
        commissionIqd: iqd(1_500),
      });

      expect(db.entries).toHaveLength(3);
      expect(db.netOfTransaction(transactionId)).toBe(0);
      expect(db.balanceOf(DRIVER)).toBe(8_500);

      const revenue = db.entries.find((e) => e.accountType === 'PLATFORM_REVENUE');
      expect(revenue?.amountIqd).toBe(1_500);
      expect(revenue?.accountId).toBeNull();
    });

    it('tags every entry with the ride', async () => {
      await ledger.recordRideSettlement(db, {
        rideId: RIDE,
        driverId: DRIVER,
        fareIqd: iqd(5_000),
        commissionIqd: iqd(500),
      });
      expect(db.entries.every((e) => e.rideId === RIDE)).toBe(true);
    });

    it('refuses a commission larger than the fare', async () => {
      await expect(
        ledger.recordRideSettlement(db, {
          rideId: RIDE,
          driverId: DRIVER,
          fareIqd: iqd(5_000),
          commissionIqd: iqd(6_000),
        }),
      ).rejects.toThrow(/cannot exceed the fare/);
      expect(db.entries).toHaveLength(0);
    });

    it('balances even when the commission is the entire fare', async () => {
      const transactionId = await ledger.recordRideSettlement(db, {
        rideId: RIDE,
        driverId: DRIVER,
        fareIqd: iqd(5_000),
        commissionIqd: iqd(5_000),
      });

      expect(db.netOfTransaction(transactionId)).toBe(0);
      expect(db.balanceOf(DRIVER)).toBe(0);
    });

    // The property, across the whole plausible input space.
    it('balances for every fare and commission combination', async () => {
      for (let fare = 250; fare <= 50_000; fare += 1_111) {
        for (const bps of [0, 500, 1_500, 10_000]) {
          const local = new FakeLedgerDb();
          const commission = Math.floor((fare * bps + 5_000) / 10_000);

          const transactionId = await ledger.recordRideSettlement(local, {
            rideId: RIDE,
            driverId: DRIVER,
            fareIqd: iqd(fare),
            commissionIqd: iqd(commission),
          });

          expect(local.netOfTransaction(transactionId)).toBe(0);
          expect(local.entries.length).toBeGreaterThanOrEqual(2);
          expect(local.entries.every((e) => Number.isInteger(e.amountIqd))).toBe(true);
          expect(local.entries.every((e) => e.amountIqd > 0)).toBe(true);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Wallet - ACCEPTANCE_CHECKLIST.md check 6
  // -------------------------------------------------------------------------

  describe('recordTopUp and balanceFor', () => {
    it('shows the top-up in the balance immediately', async () => {
      await ledger.recordTopUp(db, {
        driverId: DRIVER,
        amountIqd: iqd(10_000),
        transactionId: 'tx-1',
      });

      expect(await ledger.balanceFor(db, DRIVER)).toBe(10_000);
    });

    // The exact sequence from the acceptance checklist: top up 10,000 twice,
    // the balance must be 20,000 - not 10,000 (lost) and not 30,000 (double).
    it('doubles to 20,000 when the same amount is topped up twice', async () => {
      await ledger.recordTopUp(db, {
        driverId: DRIVER,
        amountIqd: iqd(10_000),
        transactionId: 'tx-1',
      });
      await ledger.recordTopUp(db, {
        driverId: DRIVER,
        amountIqd: iqd(10_000),
        transactionId: 'tx-2',
      });

      expect(await ledger.balanceFor(db, DRIVER)).toBe(20_000);
    });

    it('keeps drivers separate', async () => {
      await ledger.recordTopUp(db, {
        driverId: DRIVER,
        amountIqd: iqd(10_000),
        transactionId: 'tx-1',
      });
      await ledger.recordTopUp(db, {
        driverId: OTHER_DRIVER,
        amountIqd: iqd(7_000),
        transactionId: 'tx-2',
      });

      expect(await ledger.balanceFor(db, DRIVER)).toBe(10_000);
      expect(await ledger.balanceFor(db, OTHER_DRIVER)).toBe(7_000);
    });

    it('is zero for a driver with no entries', async () => {
      expect(await ledger.balanceFor(db, DRIVER)).toBe(0);
    });

    it('carries the caller-supplied transaction id, which is what makes a replay detectable', async () => {
      const id = await ledger.recordTopUp(db, {
        driverId: DRIVER,
        amountIqd: iqd(10_000),
        transactionId: 'idempotency-derived-id',
      });
      expect(id).toBe('idempotency-derived-id');
      expect(db.transactionIds()).toEqual(['idempotency-derived-id']);
    });

    it('includes the reference in the description when given', async () => {
      await ledger.recordTopUp(db, {
        driverId: DRIVER,
        amountIqd: iqd(1_000),
        transactionId: 'tx-1',
        reference: 'receipt-42',
      });
      expect(db.entries[0]?.description).toContain('receipt-42');
    });
  });

  describe('correct', () => {
    it('credits the driver for a positive correction', async () => {
      await ledger.correct(db, {
        driverId: DRIVER,
        amountIqd: signedIqd(3_000),
        reason: 'goodwill',
      });
      expect(await ledger.balanceFor(db, DRIVER)).toBe(3_000);
    });

    it('debits the driver for a negative correction, allowing a negative balance', async () => {
      await ledger.correct(db, {
        driverId: DRIVER,
        amountIqd: signedIqd(-3_000),
        reason: 'overcharge recovered',
      });
      expect(await ledger.balanceFor(db, DRIVER)).toBe(-3_000);
    });

    it('refuses a zero correction rather than writing empty entries', async () => {
      await expect(
        ledger.correct(db, { driverId: DRIVER, amountIqd: signedIqd(0), reason: 'nothing' }),
      ).rejects.toThrow(/has no effect/);
      expect(db.entries).toHaveLength(0);
    });

    it('records the reason on both sides', async () => {
      await ledger.correct(db, {
        driverId: DRIVER,
        amountIqd: signedIqd(500),
        reason: 'dispute 17',
      });
      expect(db.entries.every((e) => e.description.includes('dispute 17'))).toBe(true);
    });
  });

  describe('findUnbalancedTransactions', () => {
    it('finds nothing when every write went through this service', async () => {
      await ledger.recordTopUp(db, {
        driverId: DRIVER,
        amountIqd: iqd(10_000),
        transactionId: 'tx-1',
      });
      await ledger.recordRideSettlement(db, {
        rideId: RIDE,
        driverId: DRIVER,
        fareIqd: iqd(9_000),
        commissionIqd: iqd(900),
      });

      expect(await ledger.findUnbalancedTransactions(db)).toEqual([]);
    });

    it('reports a transaction that was corrupted behind the service', async () => {
      await ledger.recordTopUp(db, {
        driverId: DRIVER,
        amountIqd: iqd(10_000),
        transactionId: 'tx-1',
      });
      // Simulate a row inserted by something that bypassed both this class and
      // the database trigger.
      db.entries.push({
        transactionId: 'tx-1',
        rideId: null,
        accountType: 'DRIVER_WALLET',
        accountId: DRIVER,
        direction: 'CREDIT',
        amountIqd: 5_000,
        description: 'rogue',
        createdAt: new Date(),
      });

      const unbalanced = await ledger.findUnbalancedTransactions(db);
      expect(unbalanced).toEqual([{ transactionId: 'tx-1', netIqd: 5_000 }]);
    });
  });

  describe('entriesFor', () => {
    it('returns the driver own wallet entries, newest first', async () => {
      await ledger.recordTopUp(db, {
        driverId: DRIVER,
        amountIqd: iqd(1_000),
        transactionId: 'tx-1',
      });
      await ledger.recordTopUp(db, {
        driverId: DRIVER,
        amountIqd: iqd(2_000),
        transactionId: 'tx-2',
      });

      const entries = await ledger.entriesFor(db, DRIVER);
      expect(entries).toHaveLength(2);
      expect(entries[0]!.amountIqd).toBe(2_000);
      expect(entries.every((e) => e.accountId === DRIVER)).toBe(true);
    });

    // ACCEPTANCE_CHECKLIST.md check 5 - one driver must not see another's money.
    it('never returns another driver entries', async () => {
      await ledger.recordTopUp(db, {
        driverId: OTHER_DRIVER,
        amountIqd: iqd(9_999),
        transactionId: 'tx-1',
      });

      expect(await ledger.entriesFor(db, DRIVER)).toEqual([]);
    });

    it('clamps the page size', async () => {
      await ledger.entriesFor(db, DRIVER, { limit: 5_000 });
      expect(db.statements.at(-1)!.params).toContain(100);

      await ledger.entriesFor(db, DRIVER, { limit: 0 });
      expect(db.statements.at(-1)!.params).toContain(1);
    });
  });
});
