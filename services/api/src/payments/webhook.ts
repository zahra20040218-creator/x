import { createHmac, timingSafeEqual } from 'node:crypto';

import type { LedgerCommand } from '../ledger/ledger.types.js';
import { iqd, isIqdAmount } from '../money/iqd.js';

/**
 * Gateway webhook translation.
 *
 * CLAUDE.md §7 is explicit about why this file has this shape:
 *
 *   "the target gateway does not permit webhook testing in its UAT
 *    environment. Design the webhook handler to be independently testable:
 *    pure function (payload, signature) => LedgerCommand[], with a thin HTTP
 *    wrapper. Write its unit tests now even though the integration is stubbed."
 *
 * So everything that can be wrong lives here, in a function with no I/O, no
 * clock, and no database - and is tested now. When the gateway is finally
 * integrated, the part nobody could test in advance is reduced to "does the
 * HTTP request arrive", which is the part that is easy to check by hand.
 *
 * The signature check is the security boundary. This endpoint is
 * unauthenticated by necessity - a payment provider cannot hold a user's bearer
 * token - so the HMAC is the ONLY thing between the open internet and a
 * function that writes ledger entries.
 */

export type WebhookOutcome =
  | { kind: 'REJECTED'; reason: WebhookRejection; status: number }
  | { kind: 'IGNORED'; reason: string }
  | {
      kind: 'ACCEPTED';
      externalId: string;
      rideId: string;
      eventType: 'payment.succeeded' | 'payment.failed' | 'payment.refunded';
      commands: LedgerCommand[];
      payloadHash: string;
    };

export type WebhookRejection =
  | 'MISSING_SIGNATURE'
  | 'BAD_SIGNATURE'
  | 'MALFORMED_PAYLOAD'
  | 'UNSUPPORTED_EVENT'
  | 'INVALID_AMOUNT';

export interface WebhookInput {
  /** The RAW body bytes, exactly as received. */
  rawBody: string;
  signatureHeader: string | undefined;
  secret: string;
}

/**
 * Verify and translate one webhook.
 *
 * Pure: same inputs, same output, always. Whether the resulting commands are
 * actually written - and the replay check against `payment_webhook_events` -
 * is the caller's job, because that needs a database.
 */
export function processWebhook(input: WebhookInput): WebhookOutcome {
  if (!input.signatureHeader) {
    return { kind: 'REJECTED', reason: 'MISSING_SIGNATURE', status: 401 };
  }

  if (!verifySignature(input.rawBody, input.signatureHeader, input.secret)) {
    return { kind: 'REJECTED', reason: 'BAD_SIGNATURE', status: 401 };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { kind: 'REJECTED', reason: 'MALFORMED_PAYLOAD', status: 400 };
  }

  if (typeof payload !== 'object' || payload === null) {
    return { kind: 'REJECTED', reason: 'MALFORMED_PAYLOAD', status: 400 };
  }

  const body = payload as Record<string, unknown>;
  const externalId = body['id'];
  const eventType = body['type'];
  const data = body['data'];

  if (typeof externalId !== 'string' || externalId.length === 0) {
    return { kind: 'REJECTED', reason: 'MALFORMED_PAYLOAD', status: 400 };
  }
  if (typeof eventType !== 'string') {
    return { kind: 'REJECTED', reason: 'MALFORMED_PAYLOAD', status: 400 };
  }
  if (typeof data !== 'object' || data === null) {
    return { kind: 'REJECTED', reason: 'MALFORMED_PAYLOAD', status: 400 };
  }

  const fields = data as Record<string, unknown>;
  const rideId = fields['rideId'];
  const driverId = fields['driverId'];

  if (typeof rideId !== 'string' || typeof driverId !== 'string') {
    return { kind: 'REJECTED', reason: 'MALFORMED_PAYLOAD', status: 400 };
  }

  // An event we do not model is ignored, not rejected. A gateway that gets a
  // 4xx will retry forever, and an unknown event type is not an error - it is
  // a feature we do not use.
  const supported = ['payment.succeeded', 'payment.failed', 'payment.refunded'];
  if (!supported.includes(eventType)) {
    return { kind: 'IGNORED', reason: `unsupported event type: ${eventType}` };
  }

  const payloadHash = hashPayload(input.rawBody);

  if (eventType === 'payment.failed') {
    // No money moved, so no ledger entries. Recorded for the audit trail only.
    return {
      kind: 'ACCEPTED',
      externalId,
      rideId,
      eventType: 'payment.failed',
      commands: [],
      payloadHash,
    };
  }

  const amount = fields['amountIqd'];
  // CLAUDE.md §6.1 - a gateway sending 12500.5 must be rejected, not rounded.
  // This is untrusted input from another company's system.
  if (!isIqdAmount(amount) || amount <= 0) {
    return { kind: 'REJECTED', reason: 'INVALID_AMOUNT', status: 400 };
  }

  const commissionRaw = fields['commissionIqd'] ?? 0;
  if (!isIqdAmount(commissionRaw) || commissionRaw > amount) {
    return { kind: 'REJECTED', reason: 'INVALID_AMOUNT', status: 400 };
  }

  const amountIqd = iqd(amount);
  const commissionIqd = iqd(commissionRaw);
  const driverEarningsIqd = iqd(amountIqd - commissionIqd);

  if (eventType === 'payment.refunded') {
    return {
      kind: 'ACCEPTED',
      externalId,
      rideId,
      eventType: 'payment.refunded',
      // Offsetting entries, never a mutation of the original (CLAUDE.md §6.3).
      commands: buildRefundCommands(driverId, amountIqd, commissionIqd, driverEarningsIqd),
      payloadHash,
    };
  }

  return {
    kind: 'ACCEPTED',
    externalId,
    rideId,
    eventType: 'payment.succeeded',
    commands: buildSettlementCommands(driverId, amountIqd, commissionIqd, driverEarningsIqd),
    payloadHash,
  };
}

/**
 * Gateway settlement, mirroring the cash shape so the ledger reads the same
 * regardless of how the rider paid.
 *
 * For a gateway payment the platform receives the money, so the driver holds no
 * cash - `DRIVER_CASH_HELD` is not used. The rows still net to zero.
 */
function buildSettlementCommands(
  driverId: string,
  amountIqd: ReturnType<typeof iqd>,
  commissionIqd: ReturnType<typeof iqd>,
  driverEarningsIqd: ReturnType<typeof iqd>,
): LedgerCommand[] {
  const commands: LedgerCommand[] = [
    {
      accountType: 'MANUAL_ADJUSTMENT',
      accountId: driverId,
      direction: 'DEBIT',
      amountIqd,
      description: 'Gateway payment received',
    },
  ];

  if (commissionIqd > 0) {
    commands.push({
      accountType: 'PLATFORM_REVENUE',
      accountId: null,
      direction: 'CREDIT',
      amountIqd: commissionIqd,
      description: 'Platform commission (gateway)',
    });
  }

  if (driverEarningsIqd > 0) {
    commands.push({
      accountType: 'DRIVER_WALLET',
      accountId: driverId,
      direction: 'CREDIT',
      amountIqd: driverEarningsIqd,
      description: 'Driver earnings (gateway)',
    });
  }

  return commands;
}

/** The exact mirror of settlement, with every direction reversed. */
function buildRefundCommands(
  driverId: string,
  amountIqd: ReturnType<typeof iqd>,
  commissionIqd: ReturnType<typeof iqd>,
  driverEarningsIqd: ReturnType<typeof iqd>,
): LedgerCommand[] {
  const commands: LedgerCommand[] = [
    {
      accountType: 'MANUAL_ADJUSTMENT',
      accountId: driverId,
      direction: 'CREDIT',
      amountIqd,
      description: 'Gateway payment refunded',
    },
  ];

  if (commissionIqd > 0) {
    commands.push({
      accountType: 'PLATFORM_REVENUE',
      accountId: null,
      direction: 'DEBIT',
      amountIqd: commissionIqd,
      description: 'Platform commission reversed (gateway refund)',
    });
  }

  if (driverEarningsIqd > 0) {
    commands.push({
      accountType: 'DRIVER_WALLET',
      accountId: driverId,
      direction: 'DEBIT',
      amountIqd: driverEarningsIqd,
      description: 'Driver earnings reversed (gateway refund)',
    });
  }

  return commands;
}

/**
 * HMAC-SHA256 over the raw body.
 *
 * Two details are the difference between a real check and decoration:
 *
 *  - It runs over the RAW bytes, not a re-serialised object. `JSON.parse` then
 *    `JSON.stringify` reorders keys and drops whitespace, so the recomputed
 *    signature would never match a legitimate request.
 *  - The comparison is `timingSafeEqual`. A `===` on the hex digest leaks the
 *    correct signature one byte at a time to an attacker who can measure
 *    response times.
 */
export function verifySignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): boolean {
  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;

  if (!/^[0-9a-f]+$/i.test(provided)) return false;

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');

  const providedBuffer = Buffer.from(provided.toLowerCase(), 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');

  // timingSafeEqual throws on a length mismatch, which would itself be a timing
  // signal. Check the length first and fail uniformly.
  if (providedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export function signPayload(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

function hashPayload(rawBody: string): string {
  return createHmac('sha256', 'payload-hash').update(rawBody, 'utf8').digest('hex');
}
