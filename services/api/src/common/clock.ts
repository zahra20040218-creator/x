/**
 * An injectable clock.
 *
 * Offer timeouts, claim TTLs, idempotency expiry and token lifetimes are all
 * time-dependent, and CLAUDE.md §10 requires the timeout paths to be tested.
 * Testing them against the real clock means either sleeping (slow, flaky) or
 * not testing them (which is how offer-expiry bugs reach production).
 *
 * So time is a dependency, not an ambient global. Production gets SystemClock;
 * tests get FakeClock and advance it explicitly.
 */
export interface Clock {
  now(): Date;
  nowMs(): number;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  nowMs(): number {
    return Date.now();
  }
}

export class FakeClock implements Clock {
  private current: number;

  constructor(start: Date | number = new Date('2026-01-01T00:00:00.000Z')) {
    this.current = typeof start === 'number' ? start : start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  nowMs(): number {
    return this.current;
  }

  /** Move time forward. Negative values are rejected - time does not go back. */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`FakeClock.advance requires a non-negative number, got ${ms}`);
    }
    this.current += ms;
  }

  advanceSeconds(seconds: number): void {
    this.advance(seconds * 1_000);
  }

  set(to: Date | number): void {
    this.current = typeof to === 'number' ? to : to.getTime();
  }
}

export const CLOCK = Symbol('CLOCK');
