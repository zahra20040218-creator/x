import { beforeEach, describe, expect, it } from 'vitest';

import { NotImplementedError } from '../common/problem.js';
import type { Queryable, QueryResult, SqlValue } from '../db/db.port.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { iqd } from '../money/iqd.js';
import {
  CashProvider,
  GatewayProvider,
  PaymentProviderRegistry,
  type PaymentContext,
} from './payment-provider.js';

const RIDE = 'rrrr0000-0000-4000-8000-000000000001';
const DRIVER = 'dddd0000-0000-4000-8000-000000000001';
const RIDER = 'aaaa0000-0000-4000-8000-000000000001';
const PAYMENT_ID = 'pppp0000-0000-4000-8000-000000000001';

class FakePaymentsDb implements Queryable {
  payments: Array<Record<string, unknown>> = [];
  ledger: Array<Record<string, unknown>> = [];

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<QueryResult<Row>> {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (/^INSERT INTO payments/i.test(s)) {
      this.payments.push({
        id: PAYMENT_ID,
        ride_id: params[0],
        amount_iqd: String(params[1]),
        confirmed_by: params[2],
        status: 'CONFIRMED',
      });
      return { rows: [{ id: PAYMENT_ID } as Row], rowCount: 1 };
    }

    if (/^SELECT ride_id, amount_iqd, confirmed_by FROM payments/i.test(s)) {
      const found = this.payments.find((p) => p['id'] === params[0]);
      return { rows: found ? [found as Row] : [], rowCount: found ? 1 : 0 };
    }

    if (/^SELECT status FROM payments/i.test(s)) {
      const found = this.payments.find((p) => p['id'] === params[0]);
      return {
        rows: found ? [{ status: found['status'] } as Row] : [],
        rowCount: found ? 1 : 0,
      };
    }

    if (/^INSERT INTO ledger_entries/i.test(s)) {
      const rowCount = params.length / 7;
      for (let i = 0; i < rowCount; i++) {
        const base = i * 6;
        this.ledger.push({
          transaction_id: params[base],
          account_type: params[base + 2],
          direction: params[base + 4],
          amount_iqd: params[base + 5],
        });
      }
      return { rows: [], rowCount };
    }

    return { rows: [], rowCount: 0 };
  }

  net(transactionId: string): number {
    return this.ledger
      .filter((e) => e['transaction_id'] === transactionId)
      .reduce(
        (sum, e) =>
          sum + (e['direction'] === 'CREDIT' ? Number(e['amount_iqd']) : -Number(e['amount_iqd'])),
        0,
      );
  }
}

/**
 * A fixed timestamp, not `new Date()`.
 *
 * `confirmedAt` comes from the caller's injected clock rather than SQL `now()`,
 * so the settlement timestamp stays inside the same testable discipline as
 * every other time-dependent path in this codebase.
 */
const CONFIRMED_AT = new Date('2026-03-01T09:15:00.000Z');

const context = (commissionIqd = 0): PaymentContext => ({
  rideId: RIDE,
  driverId: DRIVER,
  riderId: RIDER,
  commissionBps: 0,
  commissionIqd: iqd(commissionIqd),
  confirmedAt: CONFIRMED_AT,
});

describe('CashProvider', () => {
  let db: FakePaymentsDb;
  let provider: CashProvider;

  beforeEach(() => {
    db = new FakePaymentsDb();
    provider = new CashProvider(new LedgerService());
  });

  it('is named CASH', () => {
    expect(provider.name).toBe('CASH');
  });

  // Cash is confirmed on arrival: the driver has the notes in hand by the time
  // this runs, so there is no pending state to model.
  it('records a CONFIRMED payment and a balanced ledger transaction', async () => {
    const result = await provider.charge(db, RIDE, iqd(12_500), context());

    expect(result.status).toBe('CONFIRMED');
    expect(result.paymentId).toBe(PAYMENT_ID);
    expect(result.providerRef).toBeNull();
    expect(db.net(result.ledgerTransactionId)).toBe(0);
  });

  it('splits the fare when a commission applies', async () => {
    const result = await provider.charge(db, RIDE, iqd(10_000), context(1_500));

    const wallet = db.ledger.find((e) => e['account_type'] === 'DRIVER_WALLET');
    const revenue = db.ledger.find((e) => e['account_type'] === 'PLATFORM_REVENUE');

    expect(wallet!['amount_iqd']).toBe(8_500);
    expect(revenue!['amount_iqd']).toBe(1_500);
    expect(db.net(result.ledgerTransactionId)).toBe(0);
  });

  it('reads back the status', async () => {
    const result = await provider.charge(db, RIDE, iqd(5_000), context());
    expect(await provider.getStatus(db, result.paymentId)).toBe('CONFIRMED');
  });

  it('throws for an unknown payment', async () => {
    await expect(provider.getStatus(db, 'missing')).rejects.toThrow(/not found/);
    await expect(provider.refund(db, 'missing', iqd(100))).rejects.toThrow(/not found/);
  });

  // CLAUDE.md §6.3 - a refund is new offsetting entries, never an edit.
  describe('refund', () => {
    it('writes offsetting entries and leaves the originals untouched', async () => {
      const charged = await provider.charge(db, RIDE, iqd(10_000), context());
      const originals = [...db.ledger];

      const refund = await provider.refund(db, charged.paymentId, iqd(10_000));

      expect(db.ledger.slice(0, originals.length)).toEqual(originals);
      expect(db.net(refund.ledgerTransactionId)).toBe(0);
      expect(refund.status).toBe('REFUNDED');
    });

    it('refuses to refund more than was charged', async () => {
      const charged = await provider.charge(db, RIDE, iqd(10_000), context());
      await expect(provider.refund(db, charged.paymentId, iqd(15_000))).rejects.toThrow(
        /exceeds the payment/,
      );
    });

    it('allows a partial refund', async () => {
      const charged = await provider.charge(db, RIDE, iqd(10_000), context());
      const refund = await provider.refund(db, charged.paymentId, iqd(3_000));
      expect(db.net(refund.ledgerTransactionId)).toBe(0);
    });
  });
});

// CLAUDE.md §7 - a stub that throws, so the seam is real and exercised rather
// than aspirational.
describe('GatewayProvider', () => {
  const provider = new GatewayProvider();

  it('is named GATEWAY', () => {
    expect(provider.name).toBe('GATEWAY');
  });

  it.each([
    ['charge', () => provider.charge()],
    ['refund', () => provider.refund()],
    ['getStatus', () => provider.getStatus()],
  ])('%s throws NotImplementedError with a 501', async (_name, call) => {
    await expect(call()).rejects.toThrow(NotImplementedError);
    try {
      await call();
    } catch (error) {
      expect((error as NotImplementedError).status).toBe(501);
    }
  });
});

describe('PaymentProviderRegistry', () => {
  const registry = new PaymentProviderRegistry([
    new CashProvider(new LedgerService()),
    new GatewayProvider(),
  ]);

  it('resolves a registered provider', () => {
    expect(registry.get('CASH').name).toBe('CASH');
    expect(registry.get('GATEWAY').name).toBe('GATEWAY');
  });

  it('throws for an unregistered provider', () => {
    expect(() => registry.get('PAYPAL' as never)).toThrow(NotImplementedError);
  });

  // The claim CLAUDE.md §7 makes about this abstraction: adding a real gateway
  // means implementing three methods, and nothing else changes.
  it('exposes exactly the three methods the contract names', () => {
    for (const name of ['CASH', 'GATEWAY'] as const) {
      const provider = registry.get(name);
      expect(typeof provider.charge).toBe('function');
      expect(typeof provider.refund).toBe('function');
      expect(typeof provider.getStatus).toBe('function');
    }
  });
});
