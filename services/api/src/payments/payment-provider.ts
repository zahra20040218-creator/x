import { NotImplementedError } from '../common/problem.js';
import type { Queryable } from '../db/db.port.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { signedIqd, type IqdAmount } from '../money/iqd.js';

/**
 * CLAUDE.md §7 - "Build the interface. Do not integrate a live gateway."
 *
 * The shape below is the one the constitution specifies, with one addition:
 * every method takes a `Queryable`. Payment and ledger writes must land in the
 * SAME transaction as the ride's status change (CLAUDE.md §4), and a provider
 * that opened its own connection could not participate in that.
 *
 * The test of whether this abstraction is worth anything is the stated one:
 * adding ZainCash later must mean implementing three methods and adding a
 * webhook controller, and nothing else changing.
 */

export interface PaymentContext {
  rideId: string;
  driverId: string;
  riderId: string;
  /** Basis points, snapshotted onto the ride at creation (CLAUDE.md §6.5). */
  commissionBps: number;
  commissionIqd: IqdAmount;
  /**
   * When the transfer happened, from the caller's injected clock.
   *
   * Not `now()` in SQL. Time is a dependency in this codebase (see
   * `common/clock.ts`) precisely so timeout and settlement paths can be tested
   * without sleeping, and a provider that read the database clock would put one
   * timestamp outside that discipline - the one on the money.
   */
  confirmedAt: Date;
}

export interface PaymentResult {
  paymentId: string;
  status: PaymentStatus;
  ledgerTransactionId: string;
  providerRef: string | null;
}

export interface RefundResult {
  refundId: string;
  status: PaymentStatus;
  ledgerTransactionId: string;
}

export type PaymentStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REFUNDED';

export interface PaymentProvider {
  readonly name: 'CASH' | 'GATEWAY';

  charge(
    q: Queryable,
    rideId: string,
    amountIqd: IqdAmount,
    ctx: PaymentContext,
  ): Promise<PaymentResult>;

  refund(q: Queryable, paymentId: string, amountIqd: IqdAmount): Promise<RefundResult>;

  getStatus(q: Queryable, paymentId: string): Promise<PaymentStatus>;
}

/**
 * Cash. Fully implemented and used in production from day one (CLAUDE.md §7).
 *
 * "Charging" cash does not move money - the rider hands notes to the driver.
 * What it does is record that the transfer happened and write the double-entry
 * rows that make the platform's claim on the commission real.
 */
export class CashProvider implements PaymentProvider {
  readonly name = 'CASH' as const;

  constructor(private readonly ledger: LedgerService) {}

  async charge(
    q: Queryable,
    rideId: string,
    amountIqd: IqdAmount,
    ctx: PaymentContext,
  ): Promise<PaymentResult> {
    const result = await q.query<{ id: string }>(
      // CONFIRMED immediately: the driver has the notes in hand by the time
      // this runs. There is no pending state for cash.
      `INSERT INTO payments (ride_id, provider, status, amount_iqd, confirmed_by, confirmed_at)
       VALUES ($1, 'CASH', 'CONFIRMED', $2, $3, $4)
       RETURNING id`,
      [rideId, amountIqd, ctx.driverId, ctx.confirmedAt],
    );

    const ledgerTransactionId = await this.ledger.recordRideSettlement(q, {
      rideId,
      driverId: ctx.driverId,
      fareIqd: amountIqd,
      commissionIqd: ctx.commissionIqd,
    });

    return {
      paymentId: result.rows[0]!.id,
      status: 'CONFIRMED',
      ledgerTransactionId,
      providerRef: null,
    };
  }

  /**
   * A cash refund is the driver handing notes back. The platform cannot make
   * that happen, only record it - as a NEW offsetting ledger transaction, never
   * by touching the original rows (CLAUDE.md §6.3).
   */
  async refund(
    q: Queryable,
    paymentId: string,
    amountIqd: IqdAmount,
  ): Promise<RefundResult> {
    const payment = await q.query<{ ride_id: string; amount_iqd: string; confirmed_by: string }>(
      'SELECT ride_id, amount_iqd, confirmed_by FROM payments WHERE id = $1',
      [paymentId],
    );
    const row = payment.rows[0];
    if (!row) throw new Error(`Payment ${paymentId} not found.`);

    if (amountIqd > Number(row.amount_iqd)) {
      throw new Error(
        `Refund of ${amountIqd} exceeds the payment of ${row.amount_iqd} on ${paymentId}.`,
      );
    }

    const ledgerTransactionId = await this.ledger.correct(q, {
      driverId: row.confirmed_by,
      // Through signedIqd, not a cast: a refund is the one place a money value
      // is legitimately negative, and it still has to be a validated integer.
      amountIqd: signedIqd(-Number(amountIqd)),
      reason: `Cash refund for payment ${paymentId}`,
      rideId: row.ride_id,
    });

    return { refundId: paymentId, status: 'REFUNDED', ledgerTransactionId };
  }

  async getStatus(q: Queryable, paymentId: string): Promise<PaymentStatus> {
    const result = await q.query<{ status: PaymentStatus }>(
      'SELECT status FROM payments WHERE id = $1',
      [paymentId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Payment ${paymentId} not found.`);
    return row.status;
  }
}

/**
 * The gateway. CLAUDE.md §7: a stub that throws `NotImplementedError`.
 *
 * It exists so that the seam is real and exercised. What makes adding ZainCash
 * a three-method change rather than a rewrite is that the webhook translation
 * is already a pure function (`webhook.ts`) with its own tests, and the ledger
 * commands it produces are the same shape `CashProvider` already writes.
 */
export class GatewayProvider implements PaymentProvider {
  readonly name = 'GATEWAY' as const;

  // Written as `Promise.reject` rather than `async` + `throw`: the bodies have
  // nothing to await, and marking them async purely to throw is what
  // require-await exists to flag. Behaviour is identical for any caller.
  charge(): Promise<PaymentResult> {
    return Promise.reject(new NotImplementedError('Gateway payment'));
  }

  refund(): Promise<RefundResult> {
    return Promise.reject(new NotImplementedError('Gateway refund'));
  }

  getStatus(): Promise<PaymentStatus> {
    return Promise.reject(new NotImplementedError('Gateway payment status'));
  }
}

export class PaymentProviderRegistry {
  private readonly providers = new Map<string, PaymentProvider>();

  constructor(providers: PaymentProvider[]) {
    for (const provider of providers) this.providers.set(provider.name, provider);
  }

  get(name: 'CASH' | 'GATEWAY'): PaymentProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new NotImplementedError(`Payment provider ${name}`);
    return provider;
  }
}
