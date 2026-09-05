import { describe, expect, it } from 'vitest';

import { FakeClock } from '../common/clock.js';
import { NotFoundProblem } from '../common/problem.js';
import type { Queryable, QueryResult, SqlValue } from '../db/db.port.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { SubscriptionService } from './subscription.service.js';

/**
 * CLAUDE.md §10: "Write the test before the implementation for anything in §5
 * or §6." Selling a subscription writes ledger rows, so it is §6 work and it is
 * held to the correctness bar rather than the 70% one.
 *
 * These use a recording Queryable rather than `FakeDatabase`, on purpose. The
 * fake models the ride tables and their partial indexes; teaching it the
 * subscription schema would mean writing a second, less faithful Postgres and
 * then trusting it about money. What is actually worth asserting here is the
 * ORCHESTRATION - the order of statements, and the exact ledger commands - and
 * a recorder shows those directly.
 *
 * What this cannot prove, and what covers it instead:
 *
 *   - `driver_subscriptions_one_active_uq` actually refusing a second ACTIVE
 *     row, and the append-only triggers on `ledger_entries`. Those live in the
 *     database. `test/integration/real-capabilities.test.ts` exercises the
 *     index against real Postgres.
 *   - The deferred balance-check constraint. Covered by the ledger's own
 *     integration tests.
 *
 * So: assertions here are about the SERVICE, never about the schema.
 */

interface Recorded {
  sql: string;
  params: readonly SqlValue[];
}

/** A Queryable that records every statement and replies from a script. */
class RecordingQuery implements Queryable {
  readonly statements: Recorded[] = [];

  constructor(private readonly reply: (sql: string) => FakeRows = () => ({ rows: [] })) {}

  query<T>(sql: string, params: readonly SqlValue[] = []): Promise<QueryResult<T>> {
    this.statements.push({ sql, params });
    const { rows, rowCount } = this.reply(sql);
    return Promise.resolve({
      rows: rows as T[],
      rowCount: rowCount ?? rows.length,
    });
  }

  /** Statements whose text contains every fragment, in order of execution. */
  matching(...fragments: string[]): Recorded[] {
    return this.statements.filter((s) => fragments.every((f) => s.sql.includes(f)));
  }

  indexOf(fragment: string): number {
    return this.statements.findIndex((s) => s.sql.includes(fragment));
  }
}

interface FakeRows {
  rows: Array<Record<string, unknown>>;
  rowCount?: number;
}

const PLAN = {
  id: 'plan-1',
  code: 'MONTHLY_25K',
  name_ar: 'اشتراك شهري',
  name_en: 'Monthly subscription',
  price_iqd: '25000',
  duration_days: 30,
};

const NOW = new Date('2026-03-01T00:00:00.000Z');

function make(): { service: SubscriptionService; clock: FakeClock } {
  const clock = new FakeClock(NOW);
  return { service: new SubscriptionService(new LedgerService(), clock), clock };
}

/** Replies for a successful grant: the plan lookup, then the RETURNING row. */
function grantScript(chargedIqd: number, transactionIdSeen: () => string | null) {
  return (sql: string): FakeRows => {
    if (sql.includes('FROM subscription_plans')) return { rows: [PLAN] };
    if (sql.includes('INSERT INTO driver_subscriptions')) {
      return {
        rows: [
          {
            id: 'sub-1',
            status: 'ACTIVE',
            charged_iqd: String(chargedIqd),
            started_at: NOW,
            expires_at: new Date(NOW.getTime() + 30 * 86_400_000),
            transaction_id: transactionIdSeen(),
          },
        ],
      };
    }
    return { rows: [] };
  };
}

describe('SubscriptionService.grant — the ledger pair', () => {
  it('debits MANUAL_ADJUSTMENT and credits PLATFORM_REVENUE, netting to zero', async () => {
    const { service } = make();
    const q = new RecordingQuery(grantScript(25_000, () => 'txn-1'));

    await service.grant(q, { driverId: 'driver-1', planCode: 'MONTHLY_25K' });

    const [entry] = q.matching('INSERT INTO ledger_entries');
    expect(entry).toBeDefined();

    // Params are laid out as 6 per row, then one description per row.
    const p = entry!.params;
    expect(p.slice(2, 6)).toEqual(['MANUAL_ADJUSTMENT', 'driver-1', 'DEBIT', 25_000]);
    expect(p.slice(8, 12)).toEqual(['PLATFORM_REVENUE', null, 'CREDIT', 25_000]);

    // The invariant, stated as arithmetic rather than as a shape: CREDIT is
    // positive and DEBIT negative, and the transaction sums to zero.
    expect(Number(p[11]) - Number(p[5])).toBe(0);
  });

  it('does NOT debit DRIVER_WALLET — the driver paid cash, not from earnings', async () => {
    const { service } = make();
    const q = new RecordingQuery(grantScript(25_000, () => 'txn-1'));

    await service.grant(q, { driverId: 'driver-1', planCode: 'MONTHLY_25K' });

    // Migration 0011's comment predicted DEBIT DRIVER_WALLET. That would charge
    // a cash-paying driver twice - once in notes, once on paper - and it would
    // turn the wallet into a liability account, which DECISIONS.md D-003 says
    // must not happen without revisiting the model first. This test is the
    // guard on that decision, not a style preference.
    const [entry] = q.matching('INSERT INTO ledger_entries');
    expect(entry!.params).not.toContain('DRIVER_WALLET');
  });

  it('writes no ledger rows at all for a free period, and stores a null transaction', async () => {
    const { service } = make();
    const q = new RecordingQuery(grantScript(0, () => null));

    const granted = await service.grant(q, {
      driverId: 'driver-1',
      planCode: 'MONTHLY_25K',
      chargeIqd: 0,
    });

    // Not "two rows of zero" - the schema forbids a zero-amount entry, and a
    // single row could never balance. The absence is the correct behaviour.
    expect(q.matching('INSERT INTO ledger_entries')).toHaveLength(0);
    expect(granted.transactionId).toBeNull();
    expect(granted.chargedIqd).toBe(0);
  });

  it('refuses a fractional charge rather than rounding it', async () => {
    const { service } = make();
    const q = new RecordingQuery(grantScript(25_000, () => 'txn-1'));

    // CLAUDE.md §6.1. A caller sending 25000.5 is a bug somewhere upstream, and
    // rounding it silently would put a wrong number in an append-only ledger.
    await expect(
      service.grant(q, { driverId: 'driver-1', planCode: 'MONTHLY_25K', chargeIqd: 25_000.5 }),
    ).rejects.toThrow();

    expect(q.matching('INSERT INTO ledger_entries')).toHaveLength(0);
    expect(q.matching('INSERT INTO driver_subscriptions')).toHaveLength(0);
  });
});

describe('SubscriptionService.grant — renewal and ordering', () => {
  it('expires the outgoing period BEFORE inserting the new one', async () => {
    const { service } = make();
    const q = new RecordingQuery(grantScript(25_000, () => 'txn-1'));

    await service.grant(q, { driverId: 'driver-1', planCode: 'MONTHLY_25K' });

    const expire = q.indexOf("SET status = 'EXPIRED'");
    const insert = q.indexOf('INSERT INTO driver_subscriptions');
    expect(expire).toBeGreaterThanOrEqual(0);
    // Order is the whole point. `driver_subscriptions_one_active_uq` permits one
    // ACTIVE row per driver, so inserting first would fail on the constraint for
    // every renewal a driver ever made.
    expect(expire).toBeLessThan(insert);
  });

  it('charges the plan price when no explicit amount is given', async () => {
    const { service } = make();
    const q = new RecordingQuery(grantScript(25_000, () => 'txn-1'));

    await service.grant(q, { driverId: 'driver-1', planCode: 'MONTHLY_25K' });

    const [entry] = q.matching('INSERT INTO ledger_entries');
    expect(entry!.params[5]).toBe(25_000);
  });

  it('sets expiry from the injected clock plus the plan duration', async () => {
    const { service } = make();
    const q = new RecordingQuery(grantScript(25_000, () => 'txn-1'));

    await service.grant(q, { driverId: 'driver-1', planCode: 'MONTHLY_25K' });

    const [insert] = q.matching('INSERT INTO driver_subscriptions');
    expect(insert!.params[3]).toEqual(NOW);
    expect(insert!.params[4]).toEqual(new Date('2026-03-31T00:00:00.000Z'));
  });

  it('404s on an unknown or deactivated plan, writing nothing', async () => {
    const { service } = make();
    const q = new RecordingQuery(() => ({ rows: [] }));

    await expect(
      service.grant(q, { driverId: 'driver-1', planCode: 'NOPE' }),
    ).rejects.toBeInstanceOf(NotFoundProblem);

    expect(q.matching("SET status = 'EXPIRED'")).toHaveLength(0);
    expect(q.matching('INSERT INTO ledger_entries')).toHaveLength(0);
  });
});

describe('SubscriptionService.currentFor', () => {
  const row = (expiresAt: Date) => ({
    id: 'sub-1',
    plan_code: 'MONTHLY_25K',
    status: 'ACTIVE',
    charged_iqd: '25000',
    started_at: new Date('2026-02-01T00:00:00.000Z'),
    expires_at: expiresAt,
    transaction_id: 'txn-1',
  });

  it('returns the period when it is still live', async () => {
    const { service } = make();
    const q = new RecordingQuery(() => ({ rows: [row(new Date('2026-03-15T00:00:00.000Z'))] }));

    const current = await service.currentFor(q, 'driver-1');
    expect(current?.planCode).toBe('MONTHLY_25K');
    expect(current?.chargedIqd).toBe(25_000);
  });

  it('returns null for a row still marked ACTIVE whose date has passed', async () => {
    const { service } = make();
    const q = new RecordingQuery(() => ({ rows: [row(new Date('2026-02-28T00:00:00.000Z'))] }));

    // The status column is only as fresh as the last sweep. Trusting it would
    // let a driver whose subscription lapsed an hour ago keep working until the
    // next hourly job - so the date is checked against the clock as well.
    expect(await service.currentFor(q, 'driver-1')).toBeNull();
  });

  it('treats expiry exactly at now as expired', async () => {
    const { service } = make();
    const q = new RecordingQuery(() => ({ rows: [row(NOW)] }));
    expect(await service.currentFor(q, 'driver-1')).toBeNull();
  });

  it('returns null when the driver has no subscription at all', async () => {
    const { service } = make();
    expect(await service.currentFor(new RecordingQuery(), 'driver-1')).toBeNull();
  });
});

describe('SubscriptionService.expireLapsed', () => {
  it('closes only ACTIVE rows already past their date, and reports the count', async () => {
    const { service } = make();
    const q = new RecordingQuery(() => ({ rows: [], rowCount: 3 }));

    expect(await service.expireLapsed(q)).toBe(3);

    const [sweep] = q.matching('UPDATE driver_subscriptions');
    expect(sweep!.sql).toContain("status = 'ACTIVE'");
    expect(sweep!.sql).toContain('expires_at <=');
    expect(sweep!.params[0]).toEqual(NOW);
  });

  it('reports zero rather than throwing when nothing has lapsed', async () => {
    const { service } = make();
    expect(await service.expireLapsed(new RecordingQuery(() => ({ rows: [], rowCount: 0 })))).toBe(
      0,
    );
  });
});

describe('SubscriptionService.listPlans', () => {
  it('maps snake_case rows to the wire shape with money as an integer', async () => {
    const { service } = make();
    const q = new RecordingQuery(() => ({ rows: [PLAN] }));

    const [plan] = await service.listPlans(q);
    expect(plan).toEqual({
      code: 'MONTHLY_25K',
      nameAr: 'اشتراك شهري',
      nameEn: 'Monthly subscription',
      priceIqd: 25_000,
      durationDays: 30,
    });
    // BIGINT arrives from pg as a string. Leaving it a string would compare and
    // sort wrong everywhere downstream.
    expect(typeof plan!.priceIqd).toBe('number');
  });

  it('asks only for active plans, cheapest first', async () => {
    const { service } = make();
    const q = new RecordingQuery(() => ({ rows: [] }));
    await service.listPlans(q);

    expect(q.statements[0]!.sql).toContain('is_active = TRUE');
    expect(q.statements[0]!.sql).toContain('ORDER BY price_iqd ASC');
  });
});
