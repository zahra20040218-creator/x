import { randomUUID } from 'node:crypto';

import type { Clock } from '../common/clock.js';
import { ConflictProblem, NotFoundProblem, NotImplementedError } from '../common/problem.js';
import type { Database, Queryable } from '../db/db.port.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { iqd, type IqdAmount } from '../money/iqd.js';
import { SubscriptionService } from '../subscriptions/subscription.service.js';

/**
 * Collecting money from a driver through a live payment rail.
 *
 * CLAUDE.md §2 permits exactly one, for driver-side collections only. There is
 * deliberately no path here for a rider fare: at the seeded tariff a typical
 * 5,250 IQD trip costs 731 IQD in processor fees — 13.9% — against a
 * commission of 0, so a card fare loses money on every single ride.
 *
 * ## The two-phase shape, and why it is not optional
 *
 * A hosted checkout is a promise before it is money. `openCheckout` creates the
 * intent and the link; `settle` runs later, when the provider says what
 * happened. Nothing in this system modelled that window before — `payment_status`
 * carried a PENDING value that no code had ever written.
 *
 * The reference id is generated HERE, before the provider is called. If that
 * call times out after they created the link, the row already exists and
 * reconciliation can ask about it by name. Storing an id they return would
 * make a lost reply into money that vanished.
 *
 * ## Settlement is idempotent because it must be
 *
 * Three things can confirm the same payment: the polling sweep, a webhook, and
 * a webhook retry. The ledger is append-only (§6.3), so a double credit could
 * never be deleted — only offset by a second transaction a driver reading their
 * statement would have to be talked through. So settlement is guarded on the
 * row's own status inside the transaction, and a second confirmation is a
 * no-op rather than a second grant.
 */

export interface CheckoutRecord {
  reference: string;
  status: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'REFUNDED';
  amountIqd: IqdAmount;
  planCode: string | null;
  checkoutUrl: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  settledAt: Date | null;
}

interface Row {
  reference_id: string;
  status: CheckoutRecord['status'];
  amount_iqd: string;
  plan_code: string | null;
  checkout_url: string | null;
  expires_at: Date | null;
  created_at: Date;
  settled_at: Date | null;
}

export class GatewayPaymentService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly subscriptions: SubscriptionService,
    private readonly clock: Clock,
    /**
     * Whether an owner has switched the rail on. A function, not a boolean,
     * for the same reason the commission rate is config (§6.5): it must take
     * effect without a deploy.
     */
    private readonly enabled: () => Promise<boolean>,
  ) {}

  /**
   * Reserve an intent and return the row to create a link for.
   *
   * Does NOT call the provider. That is a foreign HTTP round trip and §3.2
   * keeps it off the request path — the caller enqueues a job, which fills in
   * `checkout_url` and hands it back over the socket or the next poll.
   */
  async openCheckout(input: { userId: string; planCode: string }): Promise<CheckoutRecord> {
    if (!(await this.enabled())) {
      throw new NotImplementedError('Gateway payments');
    }

    return this.db.transaction(async (tx) => {
      const plan = await tx.query<{ id: string; code: string; price_iqd: string }>(
        `SELECT id, code, price_iqd FROM subscription_plans
          WHERE code = $1 AND is_active = TRUE`,
        [input.planCode],
      );
      const found = plan.rows[0];
      if (!found) throw new NotFoundProblem('Subscription plan');

      // Already holds a live subscription. Selling a second one is not a
      // feature, it is taking money for something the driver already has -
      // and `driver_subscriptions_one_active_uq` would refuse it at
      // settlement, AFTER the money moved.
      const live = await this.subscriptions.currentFor(tx, input.userId);
      if (live) {
        throw new ConflictProblem('This driver already holds a live subscription.', {
          expiresAt: live.expiresAt.toISOString(),
        });
      }

      const reference = randomUUID();
      const inserted = await tx.query<Row>(
        `INSERT INTO gateway_payments
           (reference_id, provider, purpose, user_id, amount_iqd, plan_id)
         VALUES ($1, 'WAYL', 'SUBSCRIPTION', $2, $3, $4)
         RETURNING reference_id, status, amount_iqd, checkout_url,
                   expires_at, created_at, settled_at, NULL::text AS plan_code`,
        [reference, input.userId, Number(found.price_iqd), found.id],
      );

      const row = inserted.rows[0];
      // `gateway_payments_one_pending_uq` is the only thing that can refuse
      // this insert, and it refuses precisely the case worth refusing: a driver
      // who tapped twice and would otherwise hold two payable links.
      if (!row) {
        throw new ConflictProblem('A payment for this driver is already open and unpaid.');
      }

      return toRecord({ ...row, plan_code: found.code });
    });
  }

  /** Record the link the provider issued. Called from the job, never a handler. */
  async attachCheckoutUrl(
    reference: string,
    link: { checkoutUrl: string; providerRef: string | null; expiresAt: Date | null },
  ): Promise<void> {
    await this.db.query(
      `UPDATE gateway_payments
          SET checkout_url = $2, provider_ref = $3, expires_at = $4, updated_at = now()
        WHERE reference_id = $1 AND status = 'PENDING'`,
      [reference, link.checkoutUrl, link.providerRef, link.expiresAt],
    );
  }

  /**
   * The provider says this was paid. Grant what was bought and write the money.
   *
   * ## The ledger, and the fee problem
   *
   * CLAUDE.md §6.2 fixes four account types and none of them is "processor
   * fee". Rather than add a fifth — PostgreSQL cannot drop an enum value, so
   * that choice is permanent — the fee is recorded as what it actually is: a
   * reduction of platform revenue, in its own transaction.
   *
   *   1.  DEBIT  MANUAL_ADJUSTMENT   25,000    gross arrived from outside
   *       CREDIT PLATFORM_REVENUE    25,000    the subscription was earned
   *
   *   2.  DEBIT  PLATFORM_REVENUE     1,225    the processor's cut
   *       CREDIT MANUAL_ADJUSTMENT    1,225    paid out to them
   *
   * Both balance. `PLATFORM_REVENUE` nets to 23,775 — what the platform truly
   * keeps — while the gross AND the fee each survive as their own rows, so
   * "what did Wayl cost us this month" is a query and not an estimate. A
   * single net entry would have lost that permanently, and the ledger is
   * append-only so it could never be recovered.
   *
   * The driver's wallet is untouched. They paid a processor, not out of their
   * earnings, and debiting the wallet would charge them twice — the same trap
   * D-020 documents for the cash path.
   */
  async settle(input: {
    reference: string;
    feeIqd: IqdAmount | null;
    providerRef: string | null;
  }): Promise<'SETTLED' | 'ALREADY_SETTLED' | 'UNKNOWN'> {
    return this.db.transaction(async (tx) => {
      // FOR UPDATE: the polling sweep and a webhook can arrive together, and
      // the loser must see the winner's status rather than a stale one.
      const found = await tx.query<{
        id: string;
        user_id: string;
        amount_iqd: string;
        status: string;
        plan_code: string | null;
      }>(
        `SELECT g.id, g.user_id, g.amount_iqd, g.status, p.code AS plan_code
           FROM gateway_payments g
           LEFT JOIN subscription_plans p ON p.id = g.plan_id
          WHERE g.reference_id = $1
          FOR UPDATE OF g`,
        [input.reference],
      );

      const row = found.rows[0];
      if (!row) return 'UNKNOWN';

      // Not an error. A webhook retry, a sweep racing a webhook, and a
      // duplicate delivery all land here, and all three are ordinary.
      if (row.status !== 'PENDING') return 'ALREADY_SETTLED';

      const amountIqd = iqd(Number(row.amount_iqd));
      const now = this.clock.now();

      const transactionId = await this.ledger.write(
        tx,
        [
          {
            accountType: 'MANUAL_ADJUSTMENT',
            accountId: row.user_id,
            direction: 'DEBIT',
            amountIqd,
            description: `Gateway payment received (${input.reference})`,
          },
          {
            accountType: 'PLATFORM_REVENUE',
            accountId: null,
            direction: 'CREDIT',
            amountIqd,
            description: `Subscription ${row.plan_code ?? ''} (gateway)`.trim(),
          },
        ],
      );

      // A separate transaction, because it is a separate event: the platform
      // earned 25,000 and then paid 1,225 to collect it. Skipped entirely when
      // the fee is zero or unreported - the schema forbids a zero-amount row,
      // and a pair of zeroes is not a balanced transaction, it is noise.
      if (input.feeIqd !== null && input.feeIqd > 0) {
        await this.ledger.write(tx, [
          {
            accountType: 'PLATFORM_REVENUE',
            accountId: null,
            direction: 'DEBIT',
            amountIqd: input.feeIqd,
            description: `Payment processor fee (${input.reference})`,
          },
          {
            accountType: 'MANUAL_ADJUSTMENT',
            accountId: row.user_id,
            direction: 'CREDIT',
            amountIqd: input.feeIqd,
            description: `Payment processor fee (${input.reference})`,
          },
        ]);
      }

      await tx.query(
        `UPDATE gateway_payments
            SET status = 'PAID', fee_iqd = $2, provider_ref = COALESCE($3, provider_ref),
                transaction_id = $4, settled_at = $5, checkout_url = NULL, updated_at = now()
          WHERE id = $1`,
        [row.id, input.feeIqd, input.providerRef, transactionId, now],
      );

      // The thing the driver actually bought. In the SAME transaction as the
      // money: a payment with no subscription, or a subscription with no
      // payment, is not a state any retry can repair.
      if (row.plan_code) {
        await this.subscriptions.grant(tx, {
          driverId: row.user_id,
          planCode: row.plan_code,
          // Zero, deliberately. `grant` writes its own wallet-to-revenue pair
          // for a cash sale; the money here has already been recorded above,
          // and letting it write a second pair would count the payment twice.
          chargeIqd: 0,
          note: `gateway ${input.reference}`,
        });
      }

      return 'SETTLED';
    });
  }

  /**
   * Claim a webhook event id, once and only once.
   *
   * Returns false if this event has been seen before, in which case the caller
   * must do nothing and answer 2xx anyway — a provider that gets a 4xx or 5xx
   * retries, and retrying a duplicate forever is worse than acknowledging it.
   *
   * ## Why this exists now and not before
   *
   * `payment_webhook_events` and its UNIQUE `(provider, external_id)` have
   * existed since migration 0004 and NO code had ever read or written them.
   * That was tolerable only because the handler answered 501 before any ledger
   * write — there was nothing to replay INTO. DECISIONS.md D-019 recorded that
   * the dedup had to land in the same change that made a gateway write
   * reachable. This is that change.
   *
   * ## Why the database and not a cache
   *
   * The uniqueness is enforced by the index, so two deliveries arriving on two
   * API instances at the same moment collide at the constraint. An
   * application-level "have I seen this?" check is a read followed by a write,
   * and the whole hazard here is what happens between those two statements.
   *
   * ## What it does and does not fix
   *
   * Wayl's signature carries no timestamp, so a captured request stays
   * cryptographically valid forever. This does not make it invalid — it makes
   * it INERT: the first replay finds the id already recorded and changes
   * nothing. That is the property that actually matters, and it is the only
   * one obtainable without a timestamp to check.
   */
  async claimWebhookEvent(externalId: string, payloadHash: string): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO payment_webhook_events (provider, external_id, payload_hash)
       VALUES ('GATEWAY', $1, $2)
       ON CONFLICT (provider, external_id) DO NOTHING`,
      [externalId, payloadHash],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /** The provider says it will not be paid. No ledger rows: no money moved. */
  async close(reference: string, status: 'FAILED' | 'EXPIRED'): Promise<void> {
    await this.db.query(
      `UPDATE gateway_payments
          SET status = $2, settled_at = $3, checkout_url = NULL, updated_at = now()
        WHERE reference_id = $1 AND status = 'PENDING'`,
      [reference, status, this.clock.now()],
    );
  }

  /** One driver's own attempt. Reads ALY's record, never the provider. */
  async findForUser(userId: string, reference: string): Promise<CheckoutRecord | null> {
    const result = await this.db.query<Row>(
      `SELECT g.reference_id, g.status, g.amount_iqd, g.checkout_url,
              g.expires_at, g.created_at, g.settled_at, p.code AS plan_code
         FROM gateway_payments g
         LEFT JOIN subscription_plans p ON p.id = g.plan_id
        WHERE g.reference_id = $1 AND g.user_id = $2`,
      [reference, userId],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  /** Attempts the reconciliation sweep should ask the provider about. */
  async pending(q: Queryable, limit = 100): Promise<Array<{ reference: string; createdAt: Date }>> {
    const result = await q.query<{ reference_id: string; created_at: Date }>(
      `SELECT reference_id, created_at FROM gateway_payments
        WHERE status = 'PENDING' AND checkout_url IS NOT NULL
        ORDER BY created_at
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((r) => ({ reference: r.reference_id, createdAt: r.created_at }));
  }
}

function toRecord(row: Row): CheckoutRecord {
  return {
    reference: row.reference_id,
    status: row.status,
    amountIqd: iqd(Number(row.amount_iqd)),
    planCode: row.plan_code,
    checkoutUrl: row.checkout_url,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}
