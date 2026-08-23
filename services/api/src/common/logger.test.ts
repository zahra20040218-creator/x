import { describe, expect, it } from 'vitest';

import {
  currentRequestContext,
  newRequestId,
  redact,
  runWithRequestContext,
} from './logger.js';

/**
 * CLAUDE.md §9: "Never log phone numbers, exact coordinates, or full names."
 *
 * The way PII actually reaches logs is never `logger.info(phone)` - that gets
 * caught in review. It is `logger.info({ user })` where `user` happens to carry
 * a phone three refactors later. So these tests are mostly about nesting.
 */

const PHONE = '+9647700000001';

/**
 * An Iraqi mobile number in any of the forms redaction has to survive.
 *
 * Used instead of `toContain('964')` throughout this file. The substring form
 * is the reason a PII assertion elsewhere in this repo silently stopped testing
 * anything, so it is not used here.
 */
const PHONE_PATTERN = /\+?964\d{9,}/;

describe('redact', () => {
  it('removes a phone at the top level', () => {
    expect(redact({ phone: PHONE })).toEqual({ phone: '[redacted]' });
  });

  it.each([
    'phone', 'phone_e164', 'phoneE164', 'phoneNumber', 'msisdn',
    'displayName', 'display_name', 'fullName', 'name',
    'password', 'token', 'accessToken', 'refreshToken', 'firebaseIdToken',
    'authorization', 'idempotencyKey', 'jwt', 'secret', 'apiKey', 'signature',
  ])('removes the sensitive key %s', (key) => {
    expect(redact({ [key]: 'sensitive-value' })).toEqual({ [key]: '[redacted]' });
  });

  // The case that actually happens.
  it('removes a phone nested several levels deep', () => {
    const logged = redact({
      event: 'ride.accepted',
      ride: { id: 'r1', rider: { id: 'u1', phone: PHONE, displayName: 'Ahmed Ali' } },
    });

    // Matched as a PHONE NUMBER, not the substring '964'. A bare substring
    // check passes or fails on three digits that appear by chance in ids and
    // timestamps, so it tests luck rather than redaction.
    expect(JSON.stringify(logged)).not.toMatch(PHONE_PATTERN);
    expect(JSON.stringify(logged)).not.toContain('Ahmed');
  });

  it('removes a phone inside an array of objects', () => {
    const logged = redact({ drivers: [{ phone: PHONE }, { phone: PHONE }] });
    expect(JSON.stringify(logged)).not.toMatch(PHONE_PATTERN);
  });

  // Coordinates are coarsened rather than dropped: ~110 m is enough to debug a
  // matching problem and not enough to find someone's house.
  it('coarsens coordinates to three decimal places', () => {
    expect(redact({ lat: 33.30612345, lng: 44.42137654 })).toEqual({
      lat: 33.306,
      lng: 44.421,
    });
  });

  it('coarsens every coordinate spelling', () => {
    expect(redact({ latitude: 33.30612345, longitude: 44.42137654 })).toEqual({
      latitude: 33.306,
      longitude: 44.421,
    });
  });

  it('coarsens coordinates nested inside a ride payload', () => {
    const logged = redact({ ride: { pickup: { lat: 33.3061234, lng: 44.4213765 } } }) as {
      ride: { pickup: { lat: number; lng: number } };
    };
    expect(logged.ride.pickup.lat).toBe(33.306);
  });

  it('leaves a non-numeric coordinate alone rather than crashing', () => {
    expect(redact({ lat: 'unknown' })).toEqual({ lat: 'unknown' });
  });

  it('keeps non-sensitive fields intact', () => {
    expect(redact({ rideId: 'r1', status: 'ACCEPTED', fareIqd: 12_500 })).toEqual({
      rideId: 'r1',
      status: 'ACCEPTED',
      fareIqd: 12_500,
    });
  });

  it('serialises an Error without losing the message', () => {
    const logged = redact(new Error('boom')) as { name: string; message: string };
    expect(logged.name).toBe('Error');
    expect(logged.message).toBe('boom');
  });

  it('passes primitives and null through', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(42)).toBe(42);
    expect(redact('plain')).toBe('plain');
  });

  it('stops at a depth limit instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
    expect(JSON.stringify(redact(cyclic))).toContain('[max-depth]');
  });

  it('caps very long arrays so one log line cannot be unbounded', () => {
    const logged = redact({ items: Array.from({ length: 500 }, (_, i) => i) }) as {
      items: number[];
    };
    expect(logged.items.length).toBeLessThanOrEqual(50);
  });

  // The end-to-end property, stated the way the acceptance checklist asks it.
  it('never emits a recognisable Iraqi phone number for any nesting shape', () => {
    const shapes: unknown[] = [
      { phone: PHONE },
      { user: { phone: PHONE } },
      { a: { b: { c: { phone: PHONE } } } },
      { list: [{ phone: PHONE }] },
      { req: { body: { phone: PHONE } } },
    ];

    for (const shape of shapes) {
      expect(JSON.stringify(redact(shape))).not.toMatch(/\+?964\d{9,}/);
    }
  });

  // An honest limitation, asserted so nobody assumes otherwise: a phone that
  // arrives under a key this module does not know about is NOT redacted.
  it('does NOT catch a phone hidden under an unrecognised key', () => {
    const logged = redact({ contactDetail: PHONE });
    // Asserts the WHOLE number survives, not that three digits appear. If this
    // ever starts passing for the wrong reason the limitation has changed and
    // the comment above it has gone stale.
    expect(JSON.stringify(logged)).toContain(PHONE);
  });
});

describe('request context', () => {
  it('makes the request id available to nested calls', () => {
    const requestId = newRequestId();
    runWithRequestContext({ requestId, userId: 'u1', role: 'RIDER' }, () => {
      const inner = () => currentRequestContext();
      expect(inner()?.requestId).toBe(requestId);
      expect(inner()?.role).toBe('RIDER');
    });
  });

  it('is undefined outside a request', () => {
    expect(currentRequestContext()).toBeUndefined();
  });

  it('does not leak between sibling contexts', () => {
    runWithRequestContext({ requestId: 'a' }, () => {
      expect(currentRequestContext()?.requestId).toBe('a');
    });
    runWithRequestContext({ requestId: 'b' }, () => {
      expect(currentRequestContext()?.requestId).toBe('b');
    });
    expect(currentRequestContext()).toBeUndefined();
  });

  it('generates distinct request ids', () => {
    const ids = new Set(Array.from({ length: 100 }, newRequestId));
    expect(ids.size).toBe(100);
  });
});
