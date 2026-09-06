import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeClock } from '../../src/common/clock.js';
import { LedgerService } from '../../src/ledger/ledger.service.js';
import { iqd } from '../../src/money/iqd.js';
import { GatewayPaymentService } from '../../src/payments/gateway-payment.service.js';
import { SubscriptionService } from '../../src/subscriptions/subscription.service.js';
import {
  createRealDatabase,
  isRealInfraRequested,
  truncateAll,
} from '../support/real-infra.js';

/**
 * A gateway payment settling, against a real PostgreSQL.
 *
 * The unit tests in `gateway-payment.service.test.ts` assert which ledger
 * commands are ISSUED, using a recorder. This asserts that PostgreSQL ACCEPTS
 * them, which is a different question — because the ledger's guarantees are
 * enforced by things no fake in this repository models:
 *
 *   - the deferred constraint trigger that refuses, at COMMIT, a transaction
 *     whose entries do not sum to zero
 *   - the append-only triggers (CLAUDE.md §6.3) that refuse UPDATE and DELETE
 *   - `gateway_payments_one_pending_uq`, the partial unique index that allows a
 *     driver only one open checkout
 *
 * This distinction is not hypothetical here. Twice in this repository a fake
 * agreed with a bug — `FakeConfigDb` did not model the `platform_config`
 * lookup, so every flag test exercised only the fallback; `FakeDatabase`
 * matched a literal `'TIMED_OUT'` and would have kept passing against a
 * parameterised query. A fee entry booked the wrong way round balances
 * arithmetically and would satisfy the recorder while being wrong about who
 * owes whom.
 */

const RUN = isRealInfraRequested();
const NOW = new Date('2026-05-01T12:00:00.000Z');

describe.runIf(RUN)('a gateway payment, against real PostgreSQL', () => {
  const db = RUN ? createRealDatabase(2) : (undefined as never);
  const ledger = new LedgerService();
  const clock = new FakeClock(NOW);
  const service = RUN
    ? new GatewayPaymentService(db, ledger, new SubscriptionService(ledger, clock), clock, () =>
        Promise.resolve(true),
      )
    : (undefined as never);

  let userId: string;
  let planId: string;
  let reference: string;

  beforeAll(async () => {
    // A world of this test's own, so the aggregates below are about rows it
    // created rather than whatever another file left behind.
    await truncateAll(db);

    const user = await db.query<{ id: string }>(
      `INSERT INTO users (role, phone_e164, display_name)
       VALUES ('DRIVER', '+9647701234567', 'gateway test')
       RETURNING id`,
    );
    userId = user.rows[0]!.id;

    await db.query(
      `INSERT INTO drivers (user_id, vehicle_plate, vehicle_model, vehicle_color)
       VALUES ($1, 'TEST 1', 'Corolla', 'white')`,
      [userId],
    );

    const plan = await db.query<{ id: string }>(
      `INSERT INTO subscription_plans (code, name_ar, name_en, price_iqd, duration_days)
       VALUES ('MONTHLY_25K', 'اشتراك شهري', 'Monthly', 25000, 30)
       RETURNING id`,
    );
    planId = plan.rows[0]!.id;

    const inserted = await db.query<{ reference_id: string }>(
      `INSERT INTO gateway_payments
         (reference_id, provider, purpose, user_id, amount_iqd, plan_id)
       VALUES (gen_random_uuid(), 'WAYL', 'SUBSCRIPTION', $1, 25000, $2)
       RETURNING reference_id`,
      [userId, planId],
    );
    reference = inserted.rows[0]!.reference_id;
  });

  afterAll(async () => {
    await db?.close();
  });

  it('settles a pending attempt', async () => {
    expect(
      await service.settle({ reference, feeIqd: iqd(1_225), providerRef: 'p_test_1' }),
    ).toBe('SETTLED');
  });

  it('wrote nothing PostgreSQL considers unbalanced', async () => {
    // The deferred trigger fires at COMMIT, so a settle that returned SETTLED
    // has already survived it. This asks the same question of the whole table,
    // which is the check `findUnbalancedTransactions` exists to make possible.
    expect(await ledger.findUnbalancedTransactions(db)).toEqual([]);
  });

  it('leaves PLATFORM_REVENUE holding the amount NET of the fee', async () => {
    // 25,000 collected, 1,225 kept by the processor, 23,775 actually earned.
    expect(await ledger.platformRevenue(db)).toBe(23_775);
  });

  it('records the gross and the fee as separate, readable rows', async () => {
    const rows = await db.query<{ direction: string; total: string }>(
      `SELECT direction, sum(amount_iqd)::text AS total
         FROM ledger_entries
        WHERE account_type = 'PLATFORM_REVENUE'
        GROUP BY direction`,
    );
    const by = new Map(rows.rows.map((r) => [r.direction, Number(r.total)]));

    // Two entries, not one netted 23,775. A single net figure is arithmetically
    // fine and permanently destroys the answer to "what did the processor cost
    // us" — permanently, because §6.3 forbids going back to split it.
    expect(by.get('CREDIT')).toBe(25_000);
    expect(by.get('DEBIT')).toBe(1_225);
  });

  it('never touched DRIVER_WALLET', async () => {
    // The driver paid a processor, not out of their earnings. A wallet debit
    // here charges them twice.
    const wallet = await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM ledger_entries WHERE account_type = 'DRIVER_WALLET'`,
    );
    expect(Number(wallet.rows[0]!.n)).toBe(0);
  });

  it('granted the subscription, charged at zero', async () => {
    const sub = await db.query<{ status: string; charged_iqd: string }>(
      `SELECT status, charged_iqd FROM driver_subscriptions WHERE driver_id = $1`,
      [userId],
    );

    expect(sub.rows).toHaveLength(1);
    expect(sub.rows[0]!.status).toBe('ACTIVE');
    // Zero on the subscription row: the money is already on the ledger above,
    // and letting `grant` write its own cash pair would record it twice.
    expect(Number(sub.rows[0]!.charged_iqd)).toBe(0);
  });

  it('refuses a second settlement of the same reference, and writes nothing', async () => {
    const before = await ledger.platformRevenue(db);

    expect(await service.settle({ reference, feeIqd: iqd(1_225), providerRef: 'p' })).toBe(
      'ALREADY_SETTLED',
    );

    // A sweep and a webhook confirming the same payment is the ordinary case,
    // not the exotic one. A double credit here could never be deleted (§6.3),
    // only offset by a second transaction somebody has to explain.
    expect(await ledger.platformRevenue(db)).toBe(before);
    const subs = await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM driver_subscriptions WHERE driver_id = $1`,
      [userId],
    );
    expect(Number(subs.rows[0]!.n)).toBe(1);
  });

  it('reports UNKNOWN for a reference it never issued', async () => {
    // A signed webhook naming a reference this system did not create is either
    // a bug or an attack. Either way it must not mint a subscription.
    expect(
      await service.settle({
        reference: '99999999-0000-4000-8000-000000000009',
        feeIqd: iqd(1),
        providerRef: null,
      }),
    ).toBe('UNKNOWN');
  });

  it('refuses two open checkouts for one driver, at the database level', async () => {
    const open = () =>
      db.query(
        `INSERT INTO gateway_payments
           (reference_id, provider, purpose, user_id, amount_iqd, plan_id)
         VALUES (gen_random_uuid(), 'WAYL', 'SUBSCRIPTION', $1, 25000, $2)`,
        [userId, planId],
      );

    // The settled attempt above is no longer PENDING, so the first of these is
    // allowed and the second is not. `gateway_payments_one_pending_uq` puts the
    // rule in the database rather than in whichever code path remembers to
    // check: a driver who taps twice otherwise holds two payable links, and the
    // second payment has no subscription left to buy.
    await open();
    await expect(open()).rejects.toThrow(/gateway_payments_one_pending_uq|duplicate key/i);
  });

  it('deduplicates a replayed webhook event id at the constraint', async () => {
    expect(await service.claimWebhookEvent('evt_replay_1', 'hash-a')).toBe(true);

    // Wayl's signature carries no timestamp, so a captured request stays
    // cryptographically valid forever. This does not make a replay invalid; it
    // makes it inert.
    expect(await service.claimWebhookEvent('evt_replay_1', 'hash-a')).toBe(false);
    expect(await service.claimWebhookEvent('evt_replay_1', 'different-hash')).toBe(false);
  });
});
