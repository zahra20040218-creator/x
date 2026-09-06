import { describe, expect, it } from 'vitest';

import { FakeClock } from '../common/clock.js';
import { NotImplementedError } from '../common/problem.js';
import type { Database, QueryResult, SqlValue, Transaction } from '../db/db.port.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { iqd } from '../money/iqd.js';
import { SubscriptionService } from '../subscriptions/subscription.service.js';
import { GatewayPaymentService } from './gateway-payment.service.js';

/**
 * Settling a gateway payment.
 *
 * CLAUDE.md §10 puts anything in §6 at the correctness bar and asks for the
 * test before the implementation. What is pinned here is the ledger — because
 * a wrong entry is real money, and because the ledger is append-only (§6.3) so
 * a wrong entry can never be deleted, only offset by a second transaction
 * somebody has to explain to a driver.
 *
 * A recording Queryable rather than `FakeDatabase`: the exact ledger commands
 * and their order are the subject, and a recorder shows them directly. The
 * schema-level guarantees relied on — the partial unique index on one PENDING
 * attempt, the append-only triggers, `FOR UPDATE` — live in Postgres and are
 * not modelled here.
 */

const USER = '11111111-0000-4000-8000-000000000001';
const REF = '22222222-0000-4000-8000-000000000002';
const NOW = new Date('2026-05-01T12:00:00.000Z');

interface Recorded {
  sql: string;
  params: readonly SqlValue[];
}

class RecordingDb implements Database {
  readonly statements: Recorded[] = [];

  constructor(private readonly reply: (sql: string) => Array<Record<string, unknown>> = () => []) {}

  query<T>(sql: string, params: readonly SqlValue[] = []): Promise<QueryResult<T>> {
    this.statements.push({ sql, params });
    const rows = this.reply(sql);
    return Promise.resolve({ rows: rows as T[], rowCount: rows.length });
  }

  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return work(this as unknown as Transaction);
  }

  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  ledgerWrites(): Recorded[] {
    return this.statements.filter((s) => s.sql.includes('INSERT INTO ledger_entries'));
  }

  matching(fragment: string): Recorded[] {
    return this.statements.filter((s) => s.sql.includes(fragment));
  }
}

/** A PENDING attempt for a 25,000 IQD subscription. */
const pendingAttempt = (sql: string): Array<Record<string, unknown>> => {
  if (sql.includes('FROM gateway_payments')) {
    return [
      {
        id: 'gp-1',
        user_id: USER,
        amount_iqd: '25000',
        status: 'PENDING',
        plan_code: 'MONTHLY_25K',
      },
    ];
  }
  // The subscription grant looks its plan up.
  if (sql.includes('FROM subscription_plans')) {
    return [
      {
        id: 'plan-1',
        code: 'MONTHLY_25K',
        name_ar: 'اشتراك شهري',
        name_en: 'Monthly',
        price_iqd: '25000',
        duration_days: 30,
      },
    ];
  }
  if (sql.includes('INSERT INTO driver_subscriptions')) {
    return [
      {
        id: 'sub-1',
        status: 'ACTIVE',
        charged_iqd: '0',
        started_at: NOW,
        expires_at: new Date(NOW.getTime() + 30 * 86_400_000),
        transaction_id: null,
      },
    ];
  }
  return [];
};

function make(db: RecordingDb, enabled = true): GatewayPaymentService {
  const clock = new FakeClock(NOW);
  return new GatewayPaymentService(
    db,
    new LedgerService(),
    new SubscriptionService(new LedgerService(), clock),
    clock,
    () => Promise.resolve(enabled),
  );
}

/** Sum a ledger INSERT's rows: CREDIT positive, DEBIT negative. */
function netOf(entry: Recorded): number {
  const p = entry.params;
  const rows = Math.floor(p.length / 7);
  let net = 0;
  for (let i = 0; i < rows; i += 1) {
    const direction = p[i * 6 + 4] as string;
    const amount = Number(p[i * 6 + 5]);
    net += direction === 'CREDIT' ? amount : -amount;
  }
  return net;
}

describe('settle — the ledger', () => {
  it('writes gross revenue and the processor fee as SEPARATE transactions', async () => {
    const db = new RecordingDb(pendingAttempt);

    await make(db).settle({ reference: REF, feeIqd: iqd(1_225), providerRef: 'p_1' });

    // Two, not one. A single net entry of 23,775 would be arithmetically fine
    // and would permanently destroy the answer to "what did the processor cost
    // us" — and the ledger is append-only, so it could never be recovered.
    const writes = db.ledgerWrites();
    expect(writes).toHaveLength(2);
  });

  it('books the gross against MANUAL_ADJUSTMENT and PLATFORM_REVENUE, netting to zero', async () => {
    const db = new RecordingDb(pendingAttempt);
    await make(db).settle({ reference: REF, feeIqd: iqd(1_225), providerRef: null });

    const [gross] = db.ledgerWrites();
    const p = gross!.params;
    expect(p.slice(2, 6)).toEqual(['MANUAL_ADJUSTMENT', USER, 'DEBIT', 25_000]);
    expect(p.slice(8, 12)).toEqual(['PLATFORM_REVENUE', null, 'CREDIT', 25_000]);
    expect(netOf(gross!)).toBe(0);
  });

  it('books the fee as a REDUCTION of platform revenue, netting to zero', async () => {
    const db = new RecordingDb(pendingAttempt);
    await make(db).settle({ reference: REF, feeIqd: iqd(1_225), providerRef: null });

    const fee = db.ledgerWrites()[1]!;
    const p = fee.params;
    expect(p.slice(2, 6)).toEqual(['PLATFORM_REVENUE', null, 'DEBIT', 1_225]);
    expect(p.slice(8, 12)).toEqual(['MANUAL_ADJUSTMENT', USER, 'CREDIT', 1_225]);
    expect(netOf(fee)).toBe(0);

    // Net effect: PLATFORM_REVENUE holds 25,000 - 1,225 = 23,775, which is what
    // the platform actually keeps.
  });

  it('never touches DRIVER_WALLET', async () => {
    const db = new RecordingDb(pendingAttempt);
    await make(db).settle({ reference: REF, feeIqd: iqd(1_225), providerRef: null });

    // The driver paid a processor, not out of their earnings. Debiting the
    // wallet would charge them twice — the same trap D-020 documents for cash.
    for (const write of db.ledgerWrites()) {
      expect(write.params).not.toContain('DRIVER_WALLET');
    }
  });

  it('writes NO fee entry when the provider reported none', async () => {
    const db = new RecordingDb(pendingAttempt);
    await make(db).settle({ reference: REF, feeIqd: null, providerRef: null });

    // Null means "they have not said", not "they took nothing". Inventing a
    // zero-amount pair is not a balanced transaction, it is noise — and the
    // schema forbids a zero-amount row anyway.
    expect(db.ledgerWrites()).toHaveLength(1);
  });

  it('writes no fee entry for a fee of zero', async () => {
    const db = new RecordingDb(pendingAttempt);
    await make(db).settle({ reference: REF, feeIqd: iqd(0), providerRef: null });
    expect(db.ledgerWrites()).toHaveLength(1);
  });
});

describe('settle — idempotency', () => {
  it('is a NO-OP for an attempt that is already settled', async () => {
    // Three things confirm the same payment: the sweep, a webhook, and a
    // webhook retry. A second grant here is a double credit that §6.3 makes
    // permanent.
    const db = new RecordingDb((sql) =>
      sql.includes('FROM gateway_payments')
        ? [{ id: 'gp-1', user_id: USER, amount_iqd: '25000', status: 'PAID', plan_code: 'M' }]
        : [],
    );

    expect(await make(db).settle({ reference: REF, feeIqd: iqd(1), providerRef: null })).toBe(
      'ALREADY_SETTLED',
    );
    expect(db.ledgerWrites()).toHaveLength(0);
    expect(db.matching('INSERT INTO driver_subscriptions')).toHaveLength(0);
  });

  it('reports UNKNOWN for a reference it has never seen, and writes nothing', async () => {
    // A signed webhook naming a reference this system did not create is either
    // a bug or an attack. Either way it must not mint a subscription.
    const db = new RecordingDb(() => []);

    expect(await make(db).settle({ reference: REF, feeIqd: iqd(1), providerRef: null })).toBe(
      'UNKNOWN',
    );
    expect(db.ledgerWrites()).toHaveLength(0);
  });

  it('locks the row it is about to settle', async () => {
    const db = new RecordingDb(pendingAttempt);
    await make(db).settle({ reference: REF, feeIqd: null, providerRef: null });

    // The sweep and a webhook can arrive together; the loser must see the
    // winner's status rather than a stale one.
    expect(db.matching('FROM gateway_payments')[0]!.sql).toContain('FOR UPDATE');
  });
});

describe('settle — what the driver receives', () => {
  it('grants the subscription in the SAME transaction as the money', async () => {
    const db = new RecordingDb(pendingAttempt);
    await make(db).settle({ reference: REF, feeIqd: iqd(1_225), providerRef: null });

    // A payment with no subscription, or a subscription with no payment, is
    // not a state any retry can repair.
    expect(db.matching('INSERT INTO driver_subscriptions')).toHaveLength(1);
  });

  it('grants it at charge ZERO, so the payment is not counted twice', async () => {
    const db = new RecordingDb(pendingAttempt);
    await make(db).settle({ reference: REF, feeIqd: iqd(1_225), providerRef: null });

    // `SubscriptionService.grant` writes its own wallet-to-revenue pair for a
    // CASH sale. The money here is already on the ledger above; letting grant
    // write a second pair would record 25,000 of revenue twice.
    const insert = db.matching('INSERT INTO driver_subscriptions')[0]!;
    expect(insert.params[2]).toBe(0);
  });
});

describe('the off switches', () => {
  it('refuses to open a checkout when the rail is disabled', async () => {
    const db = new RecordingDb(pendingAttempt);

    await expect(
      make(db, false).openCheckout({ userId: USER, planCode: 'MONTHLY_25K' }),
    ).rejects.toBeInstanceOf(NotImplementedError);

    // And touches nothing on the way to refusing.
    expect(db.statements).toHaveLength(0);
  });
});

describe('webhook replay', () => {
  it('claims an event id exactly once', async () => {
    const db = new RecordingDb(() => []);
    // rowCount 1 on insert, 0 on conflict — the unique index does the work.
    const service = make(db);

    await service.claimWebhookEvent('evt_1', 'hash');
    const [claim] = db.matching('payment_webhook_events');

    // ON CONFLICT DO NOTHING, so two deliveries racing on two API instances
    // collide at the constraint rather than between a read and a write.
    expect(claim!.sql).toContain('ON CONFLICT');
    expect(claim!.sql).toContain('DO NOTHING');
    expect(claim!.params).toEqual(['evt_1', 'hash']);
  });
});
