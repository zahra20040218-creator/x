import { describe, expect, it } from 'vitest';

import { isBalanced, netOf } from '../ledger/ledger.types.js';
import { processWebhook, signPayload, verifySignature } from './webhook.js';

/**
 * CLAUDE.md §7: "Write its unit tests now even though the integration is
 * stubbed", because the target gateway does not allow webhook testing in UAT.
 *
 * These are therefore the ONLY tests this code will get before it faces real
 * money, which is why they cover the malicious cases as thoroughly as the
 * happy one.
 */

const SECRET = 'test-webhook-secret-at-least-16-chars';
const DRIVER = 'dddd0000-0000-4000-8000-000000000001';
const RIDE = 'rrrr0000-0000-4000-8000-000000000001';

function webhook(body: unknown, options: { secret?: string; signature?: string } = {}) {
  const rawBody = JSON.stringify(body);
  return processWebhook({
    rawBody,
    signatureHeader: options.signature ?? signPayload(rawBody, options.secret ?? SECRET),
    secret: SECRET,
  });
}

const succeeded = (overrides: Record<string, unknown> = {}) => ({
  id: 'evt_1',
  type: 'payment.succeeded',
  data: { rideId: RIDE, driverId: DRIVER, amountIqd: 12_500, commissionIqd: 0, ...overrides },
});

describe('verifySignature', () => {
  it('accepts a correct signature', () => {
    const body = '{"a":1}';
    expect(verifySignature(body, signPayload(body, SECRET), SECRET)).toBe(true);
  });

  it('accepts a bare hex digest without the sha256= prefix', () => {
    const body = '{"a":1}';
    const bare = signPayload(body, SECRET).replace('sha256=', '');
    expect(verifySignature(body, bare, SECRET)).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    const body = '{"a":1}';
    expect(verifySignature(body, signPayload(body, 'wrong-secret'), SECRET)).toBe(false);
  });

  it('rejects a signature for different content', () => {
    expect(verifySignature('{"a":1}', signPayload('{"a":2}', SECRET), SECRET)).toBe(false);
  });

  // A single flipped byte must fail. This is the check that stops an attacker
  // brute-forcing the digest.
  it('rejects a signature with one byte changed', () => {
    const body = '{"a":1}';
    const valid = signPayload(body, SECRET).replace('sha256=', '');
    const tampered = (valid[0] === 'a' ? 'b' : 'a') + valid.slice(1);
    expect(verifySignature(body, tampered, SECRET)).toBe(false);
  });

  it.each(['', 'not-hex', 'sha256=', 'sha256=zzzz', 'deadbeef'])(
    'rejects the malformed signature %p',
    (signature) => {
      expect(verifySignature('{"a":1}', signature, SECRET)).toBe(false);
    },
  );

  // The signature is computed over the RAW bytes. Re-serialising the parsed
  // object reorders keys, so a correct signature would stop matching.
  it('is sensitive to key order in the raw body', () => {
    const a = '{"x":1,"y":2}';
    const b = '{"y":2,"x":1}';
    expect(verifySignature(b, signPayload(a, SECRET), SECRET)).toBe(false);
  });

  it('is sensitive to whitespace in the raw body', () => {
    const compact = '{"x":1}';
    const spaced = '{ "x": 1 }';
    expect(verifySignature(spaced, signPayload(compact, SECRET), SECRET)).toBe(false);
  });
});

describe('processWebhook - rejection', () => {
  // The endpoint is unauthenticated by necessity, so the HMAC is the ONLY thing
  // between the open internet and a function that writes ledger entries.
  it('rejects a missing signature with 401', () => {
    const result = processWebhook({
      rawBody: JSON.stringify(succeeded()),
      signatureHeader: undefined,
      secret: SECRET,
    });
    expect(result).toEqual({ kind: 'REJECTED', reason: 'MISSING_SIGNATURE', status: 401 });
  });

  it('rejects a forged signature with 401', () => {
    const result = webhook(succeeded(), { secret: 'attacker-secret' });
    expect(result.kind).toBe('REJECTED');
    expect(result).toMatchObject({ reason: 'BAD_SIGNATURE', status: 401 });
  });

  // Signature FIRST, parsing second: an unsigned request must not be able to
  // probe the parser for differences in behaviour.
  it('checks the signature before it parses the body', () => {
    const result = processWebhook({
      rawBody: 'this is not json',
      signatureHeader: 'sha256=deadbeef',
      secret: SECRET,
    });
    expect(result).toMatchObject({ reason: 'BAD_SIGNATURE' });
  });

  it('rejects a correctly signed but unparseable body with 400', () => {
    const rawBody = 'not json at all';
    const result = processWebhook({
      rawBody,
      signatureHeader: signPayload(rawBody, SECRET),
      secret: SECRET,
    });
    expect(result).toMatchObject({ reason: 'MALFORMED_PAYLOAD', status: 400 });
  });

  it.each([
    [{ type: 'payment.succeeded', data: {} }, 'no id'],
    [{ id: 'evt_1', data: {} }, 'no type'],
    [{ id: 'evt_1', type: 'payment.succeeded' }, 'no data'],
    [{ id: '', type: 'payment.succeeded', data: {} }, 'empty id'],
    [{ id: 'evt_1', type: 'payment.succeeded', data: { rideId: RIDE } }, 'no driverId'],
    [{ id: 'evt_1', type: 'payment.succeeded', data: { driverId: DRIVER } }, 'no rideId'],
    [{ id: 5, type: 'payment.succeeded', data: {} }, 'non-string id'],
    ['just a string', 'not an object'],
    [null, 'null'],
  ] as Array<[unknown, string]>)('rejects a payload with %s', (body: unknown, _description: string) => {
    expect(webhook(body)).toMatchObject({ reason: 'MALFORMED_PAYLOAD', status: 400 });
  });

  // CLAUDE.md §6.1 / §12.2. This is untrusted input from another company's
  // system, and a fraction here would be a float in a money path.
  it.each([12_500.5, -1, 0, '12500', null, NaN, Infinity, 1e21])(
    'rejects the invalid amount %p',
    (amountIqd) => {
      expect(webhook(succeeded({ amountIqd }))).toMatchObject({
        reason: 'INVALID_AMOUNT',
        status: 400,
      });
    },
  );

  it('rejects a commission larger than the amount', () => {
    expect(webhook(succeeded({ amountIqd: 10_000, commissionIqd: 12_000 }))).toMatchObject({
      reason: 'INVALID_AMOUNT',
    });
  });

  it('rejects a fractional commission', () => {
    expect(webhook(succeeded({ commissionIqd: 12.5 }))).toMatchObject({
      reason: 'INVALID_AMOUNT',
    });
  });
});

describe('processWebhook - ignored', () => {
  // A gateway that receives a 4xx retries forever. An event we do not model is
  // not an error, so it must not be answered with one.
  it('ignores an unmodelled event type rather than rejecting it', () => {
    const result = webhook({
      id: 'evt_1',
      type: 'customer.updated',
      data: { rideId: RIDE, driverId: DRIVER },
    });
    expect(result.kind).toBe('IGNORED');
  });
});

describe('processWebhook - payment.succeeded', () => {
  it('produces balanced ledger commands', () => {
    const result = webhook(succeeded({ amountIqd: 10_000, commissionIqd: 1_500 }));

    expect(result.kind).toBe('ACCEPTED');
    if (result.kind !== 'ACCEPTED') return;

    expect(isBalanced(result.commands)).toBe(true);
    expect(netOf(result.commands)).toBe(0);
    expect(result.rideId).toBe(RIDE);
    expect(result.externalId).toBe('evt_1');
  });

  it('credits the driver the whole amount at zero commission', () => {
    const result = webhook(succeeded({ amountIqd: 12_500, commissionIqd: 0 }));
    if (result.kind !== 'ACCEPTED') throw new Error('expected ACCEPTED');

    const wallet = result.commands.find((c) => c.accountType === 'DRIVER_WALLET');
    expect(wallet!.amountIqd).toBe(12_500);
    expect(wallet!.direction).toBe('CREDIT');

    // A zero-amount row is forbidden by the schema, so there must be no
    // PLATFORM_REVENUE command at all.
    expect(result.commands.find((c) => c.accountType === 'PLATFORM_REVENUE')).toBeUndefined();
    expect(isBalanced(result.commands)).toBe(true);
  });

  it('splits between the driver and the platform', () => {
    const result = webhook(succeeded({ amountIqd: 10_000, commissionIqd: 1_500 }));
    if (result.kind !== 'ACCEPTED') throw new Error('expected ACCEPTED');

    expect(
      result.commands.find((c) => c.accountType === 'DRIVER_WALLET')!.amountIqd,
    ).toBe(8_500);
    expect(
      result.commands.find((c) => c.accountType === 'PLATFORM_REVENUE')!.amountIqd,
    ).toBe(1_500);
  });

  it('never names an account holder on PLATFORM_REVENUE', () => {
    const result = webhook(succeeded({ amountIqd: 10_000, commissionIqd: 1_000 }));
    if (result.kind !== 'ACCEPTED') throw new Error('expected ACCEPTED');

    expect(
      result.commands.find((c) => c.accountType === 'PLATFORM_REVENUE')!.accountId,
    ).toBeNull();
  });

  it('balances for the whole plausible input space', () => {
    for (let amount = 250; amount <= 100_000; amount += 1_111) {
      for (const bps of [0, 500, 1_500, 10_000]) {
        const commission = Math.floor((amount * bps + 5_000) / 10_000);
        const result = webhook(succeeded({ amountIqd: amount, commissionIqd: commission }));

        if (result.kind !== 'ACCEPTED') throw new Error(`unexpected ${result.kind}`);
        expect(netOf(result.commands)).toBe(0);
        expect(result.commands.length).toBeGreaterThanOrEqual(2);
        expect(result.commands.every((c) => Number.isInteger(c.amountIqd))).toBe(true);
        expect(result.commands.every((c) => c.amountIqd > 0)).toBe(true);
      }
    }
  });

  it('treats a missing commission as zero', () => {
    const result = webhook({
      id: 'evt_1',
      type: 'payment.succeeded',
      data: { rideId: RIDE, driverId: DRIVER, amountIqd: 5_000 },
    });
    if (result.kind !== 'ACCEPTED') throw new Error('expected ACCEPTED');

    expect(result.commands.find((c) => c.accountType === 'DRIVER_WALLET')!.amountIqd).toBe(
      5_000,
    );
  });
});

describe('processWebhook - payment.failed', () => {
  // No money moved, so no ledger entries - but the event is still recorded so
  // an operator can see the attempt.
  it('produces no ledger commands', () => {
    const result = webhook({
      id: 'evt_2',
      type: 'payment.failed',
      data: { rideId: RIDE, driverId: DRIVER },
    });

    expect(result.kind).toBe('ACCEPTED');
    if (result.kind !== 'ACCEPTED') return;
    expect(result.commands).toEqual([]);
    expect(result.eventType).toBe('payment.failed');
  });
});

describe('processWebhook - payment.refunded', () => {
  it('exactly reverses the settlement', () => {
    const settlement = webhook(succeeded({ amountIqd: 10_000, commissionIqd: 1_500 }));
    const refund = webhook({
      id: 'evt_3',
      type: 'payment.refunded',
      data: { rideId: RIDE, driverId: DRIVER, amountIqd: 10_000, commissionIqd: 1_500 },
    });

    if (settlement.kind !== 'ACCEPTED' || refund.kind !== 'ACCEPTED') {
      throw new Error('expected both ACCEPTED');
    }

    expect(netOf(refund.commands)).toBe(0);

    // Same accounts and amounts, every direction flipped.
    for (const original of settlement.commands) {
      const reversed = refund.commands.find(
        (c) => c.accountType === original.accountType && c.amountIqd === original.amountIqd,
      );
      expect(reversed).toBeDefined();
      expect(reversed!.direction).not.toBe(original.direction);
    }
  });

  // CLAUDE.md §6.3 - a refund is new offsetting rows, never an edit.
  it('produces only new entries, never an instruction to modify one', () => {
    const refund = webhook({
      id: 'evt_3',
      type: 'payment.refunded',
      data: { rideId: RIDE, driverId: DRIVER, amountIqd: 10_000, commissionIqd: 0 },
    });

    if (refund.kind !== 'ACCEPTED') throw new Error('expected ACCEPTED');
    expect(refund.commands.every((c) => c.amountIqd > 0)).toBe(true);
    expect(isBalanced(refund.commands)).toBe(true);
  });
});

describe('replay protection support', () => {
  // The caller dedupes on (provider, externalId) against payment_webhook_events.
  // This function's job is to surface a stable id and hash for it to use.
  it('returns a stable external id and payload hash for identical payloads', () => {
    const first = webhook(succeeded());
    const second = webhook(succeeded());

    if (first.kind !== 'ACCEPTED' || second.kind !== 'ACCEPTED') {
      throw new Error('expected ACCEPTED');
    }
    expect(first.externalId).toBe(second.externalId);
    expect(first.payloadHash).toBe(second.payloadHash);
  });

  it('returns a different hash when the payload differs', () => {
    const a = webhook(succeeded({ amountIqd: 10_000 }));
    const b = webhook(succeeded({ amountIqd: 11_000 }));

    if (a.kind !== 'ACCEPTED' || b.kind !== 'ACCEPTED') throw new Error('expected ACCEPTED');
    expect(a.payloadHash).not.toBe(b.payloadHash);
  });
});
