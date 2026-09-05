import type { Clock } from '../common/clock.js';
import { ConflictProblem, NotFoundProblem } from '../common/problem.js';
import type { Queryable } from '../db/db.port.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { iqd, type IqdAmount } from '../money/iqd.js';

/**
 * Selling a driver a subscription period.
 *
 * ## Why this file exists
 *
 * Migration 0011 shipped `subscription_plans` and `driver_subscriptions`, and
 * `CapabilityService` reads them to refuse a driver who has not paid. Nothing
 * ever wrote them. The system could BLOCK a driver for lacking a subscription
 * and could not SELL one - by any means, cash included. The only non-ride money
 * endpoint in the API ran the other way, crediting drivers.
 *
 * The purchase logic does not belong in a controller: expiring the previous
 * period, inserting the new one and writing the ledger rows must commit
 * together or not at all, and that discipline is what every other money path in
 * this repo keeps in a service. `CapabilityService` is the wrong home for the
 * opposite reason - it is the read side, and a gate that can also charge money
 * is a gate nobody can reason about.
 *
 * ## The ledger pair, and why it is NOT the one migration 0011 predicted
 *
 * 0011's comment predicted:
 *
 *     DEBIT  DRIVER_WALLET     amount
 *     CREDIT PLATFORM_REVENUE  amount
 *
 * That is right for a subscription funded FROM the driver's wallet. It is wrong
 * for the way v1 actually collects, which is an operator taking cash in hand
 * (DECISIONS.md D-020). If the driver hands over notes AND their earnings
 * ledger is debited, they have been charged twice - once in cash, once on
 * paper.
 *
 * So a cash-collected period writes:
 *
 *     DEBIT  MANUAL_ADJUSTMENT  amount   cash arrived from outside the system
 *     CREDIT PLATFORM_REVENUE   amount   the platform earned it
 *
 * the exact mirror of `recordTopUp`, which is the only other place money
 * crosses the system boundary.
 *
 * This is not a workaround, and it has a consequence worth stating: the
 * driver's wallet is untouched, so it stays the cumulative-earnings account
 * DECISIONS.md D-003 describes. D-003 says the model must be revisited "before
 * launch, not after" the platform starts holding driver funds - collecting
 * subscriptions this way never holds them, so that reversal condition stays
 * closed. Funding a subscription from the wallet instead WOULD open it.
 *
 * ## Zero is a real price
 *
 * A granted free period writes no ledger rows at all. The schema forbids a
 * zero-amount entry, so a "balanced" pair of zeroes is not writable and a
 * single row could not balance. `transaction_id` is null in that case, which is
 * exactly what 0011 documents it as meaning.
 */

export interface SubscriptionPlan {
  code: string;
  nameAr: string;
  nameEn: string;
  priceIqd: IqdAmount;
  durationDays: number;
}

export interface DriverSubscription {
  id: string;
  planCode: string;
  status: 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
  chargedIqd: IqdAmount;
  startedAt: Date;
  expiresAt: Date;
  transactionId: string | null;
}

interface PlanRow {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  price_iqd: string;
  duration_days: number;
}

interface SubscriptionRow {
  id: string;
  plan_code: string;
  status: 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
  charged_iqd: string;
  started_at: Date;
  expires_at: Date;
  transaction_id: string | null;
}

export class SubscriptionService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly clock: Clock,
  ) {}

  /**
   * Active plans, cheapest first.
   *
   * No supporting index is named because none is needed: `subscription_plans`
   * holds one row in v1 and will hold single digits for the life of the
   * product, so CLAUDE.md §3.4 (an index for every query on a table over 10k
   * rows) does not bite here.
   */
  async listPlans(q: Queryable): Promise<SubscriptionPlan[]> {
    const result = await q.query<PlanRow>(
      `SELECT id, code, name_ar, name_en, price_iqd, duration_days
         FROM subscription_plans
        WHERE is_active = TRUE
        ORDER BY price_iqd ASC, code ASC`,
    );
    return result.rows.map(toPlan);
  }

  /**
   * The driver's live period, or null.
   *
   * Filtered on `status = 'ACTIVE'` to use `driver_subscriptions_one_active_uq`
   * and THEN checked against the clock - deliberately both. The status column
   * needs a sweep to stay true and is stale between two runs of it; the partial
   * index is what makes the lookup cheap. Trusting only the status would let a
   * lapsed driver work; querying only on the date would not use the index.
   */
  async currentFor(q: Queryable, driverId: string): Promise<DriverSubscription | null> {
    const result = await q.query<SubscriptionRow>(
      `SELECT s.id, p.code AS plan_code, s.status, s.charged_iqd,
              s.started_at, s.expires_at, s.transaction_id
         FROM driver_subscriptions s
         JOIN subscription_plans p ON p.id = s.plan_id
        WHERE s.driver_id = $1 AND s.status = 'ACTIVE'
        ORDER BY s.expires_at DESC
        LIMIT 1`,
      [driverId],
    );

    const row = result.rows[0];
    if (!row) return null;
    if (row.expires_at.getTime() <= this.clock.now().getTime()) return null;
    return toSubscription(row);
  }

  /**
   * Sell one period. The caller MUST already be inside a transaction.
   *
   * `q` is a Queryable and not the pool by design: expiring the old row,
   * inserting the new one and writing the ledger pair are one atomic fact. A
   * partial application of this - a charge with no entitlement, or an
   * entitlement with no charge - is not recoverable by retrying, because the
   * ledger is append-only (CLAUDE.md §6.3) and a stray charge could only ever
   * be offset, never removed.
   */
  async grant(
    q: Queryable,
    input: {
      driverId: string;
      planCode: string;
      chargeIqd?: number;
      note?: string;
    },
  ): Promise<DriverSubscription> {
    const planResult = await q.query<PlanRow>(
      `SELECT id, code, name_ar, name_en, price_iqd, duration_days
         FROM subscription_plans
        WHERE code = $1 AND is_active = TRUE`,
      [input.planCode],
    );
    const plan = planResult.rows[0];
    if (!plan) throw new NotFoundProblem('Subscription plan');

    // `iqd()` rather than a cast: `chargeIqd` arrives from JSON, and a
    // fractional amount must be refused here, not rounded (CLAUDE.md §6.1).
    const chargedIqd = iqd(input.chargeIqd ?? Number(plan.price_iqd));

    const now = this.clock.now();

    // Expire the outgoing period FIRST, in the same transaction.
    //
    // `driver_subscriptions_one_active_uq` permits exactly one ACTIVE row per
    // driver. Without this the second period a driver ever bought would fail on
    // the constraint - which is the index doing its job, and is why renewal has
    // to close the old row rather than hope none exists.
    //
    // An early renewal loses the unused tail of the old period. That is the
    // deliberate choice: the alternative is to start the new period at the old
    // one's expiry, which silently sells a driver a date they did not ask for
    // and cannot see. Recorded here so the next reader knows it was decided.
    await q.query(
      `UPDATE driver_subscriptions
          SET status = 'EXPIRED'
        WHERE driver_id = $1 AND status = 'ACTIVE'`,
      [input.driverId],
    );

    const expiresAt = new Date(now.getTime() + plan.duration_days * 24 * 60 * 60 * 1000);

    let transactionId: string | null = null;
    if (chargedIqd > 0) {
      const description = input.note
        ? `Subscription ${plan.code} (${input.note})`
        : `Subscription ${plan.code}`;

      transactionId = await this.ledger.write(q, [
        {
          accountType: 'MANUAL_ADJUSTMENT',
          accountId: input.driverId,
          direction: 'DEBIT',
          amountIqd: chargedIqd,
          description,
        },
        {
          // PLATFORM_REVENUE never names an account holder - `write()` enforces
          // it, and CLAUDE.md §6.2 is why.
          accountType: 'PLATFORM_REVENUE',
          accountId: null,
          direction: 'CREDIT',
          amountIqd: chargedIqd,
          description,
        },
      ]);
    }

    const inserted = await q.query<SubscriptionRow>(
      `INSERT INTO driver_subscriptions
         (driver_id, plan_id, status, charged_iqd, started_at, expires_at, transaction_id)
       VALUES ($1, $2, 'ACTIVE', $3, $4, $5, $6)
       RETURNING id, status, charged_iqd, started_at, expires_at, transaction_id`,
      [input.driverId, plan.id, chargedIqd, now, expiresAt, transactionId],
    );

    const row = inserted.rows[0];
    // The unique index is the only thing that could refuse this insert, and the
    // UPDATE above just cleared it. If it still failed, two grants raced on the
    // same driver and the loser must not report success.
    if (!row) {
      throw new ConflictProblem(
        `Could not create a subscription for driver ${input.driverId}; a concurrent grant won.`,
      );
    }

    return toSubscription({ ...row, plan_code: plan.code });
  }

  /**
   * Close every ACTIVE period whose date has passed. Returns how many.
   *
   * The capability check does not need this to be correct - it compares
   * `expires_at` to the clock and ignores `status` precisely so a missed sweep
   * can never let a lapsed driver work. The sweep exists so the status column
   * tells the truth for everything that reads it directly: the admin panel, a
   * support query, and the partial unique index that would otherwise refuse a
   * renewal against a period nobody closed.
   *
   * Served by `driver_subscriptions_expiry_idx (expires_at) WHERE status =
   * 'ACTIVE'` - migration 0011 built that index for this query and nothing had
   * ever run it.
   */
  async expireLapsed(q: Queryable): Promise<number> {
    const result = await q.query(
      `UPDATE driver_subscriptions
          SET status = 'EXPIRED'
        WHERE status = 'ACTIVE' AND expires_at <= $1`,
      [this.clock.now()],
    );
    return result.rowCount ?? 0;
  }
}

function toPlan(row: PlanRow): SubscriptionPlan {
  return {
    code: row.code,
    nameAr: row.name_ar,
    nameEn: row.name_en,
    priceIqd: iqd(Number(row.price_iqd)),
    durationDays: row.duration_days,
  };
}

function toSubscription(row: SubscriptionRow): DriverSubscription {
  return {
    id: row.id,
    planCode: row.plan_code,
    status: row.status,
    chargedIqd: iqd(Number(row.charged_iqd)),
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    transactionId: row.transaction_id,
  };
}
