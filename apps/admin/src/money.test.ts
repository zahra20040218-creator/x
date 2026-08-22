import { describe, expect, it } from 'vitest';

import { formatDateTime, formatIqd, isWholeIqd, sumIqd } from './money.js';

/**
 * ACCEPTANCE_CHECKLIST.md check 6 asks the owner to open the admin panel and
 * confirm no amount shows a decimal fraction.
 *
 * That check only means something if the panel would actually show one. These
 * tests exist to prove the panel does NOT quietly round a bad value into
 * looking correct - which would turn check 6 into a test that always passes.
 */
describe('formatIqd', () => {
  it('formats whole dinars with a thousands separator', () => {
    expect(formatIqd(12_500)).toBe('12,500 د.ع');
    expect(formatIqd(500)).toBe('500 د.ع');
    expect(formatIqd(1_000_000)).toBe('1,000,000 د.ع');
    expect(formatIqd(0)).toBe('0 د.ع');
  });

  it('formats a negative balance, which a driver wallet can have', () => {
    expect(formatIqd(-3_000)).toBe('-3,000 د.ع');
  });

  // The point of the whole module.
  it('makes a fractional amount impossible to miss instead of rounding it', () => {
    const rendered = formatIqd(12_500.5);

    expect(rendered).toContain('⚠');
    expect(rendered).toContain('NOT A WHOLE DINAR');
    // Specifically NOT the tidy form that would hide the defect.
    expect(rendered).not.toBe('12,501 د.ع');
    expect(rendered).not.toBe('12,500 د.ع');
  });

  it('never silently rounds any fractional value', () => {
    for (const value of [0.5, 1.1, 12_500.01, 99.999]) {
      expect(formatIqd(value)).toContain('NOT A WHOLE DINAR');
    }
  });

  it('renders a dash for a missing value rather than 0', () => {
    // Showing 0 for "we do not know" is how an operator concludes a driver
    // earned nothing when the field simply failed to load.
    expect(formatIqd(null)).toBe('—');
    expect(formatIqd(undefined)).toBe('—');
    expect(formatIqd(NaN)).toBe('—');
    expect(formatIqd('12500')).toBe('—');
  });
});

describe('isWholeIqd', () => {
  it('accepts integers only', () => {
    expect(isWholeIqd(12_500)).toBe(true);
    expect(isWholeIqd(0)).toBe(true);
    expect(isWholeIqd(-500)).toBe(true);
    expect(isWholeIqd(12.5)).toBe(false);
    expect(isWholeIqd('12500')).toBe(false);
    expect(isWholeIqd(null)).toBe(false);
  });
});

describe('sumIqd', () => {
  // The owner's manual arithmetic in check 6 must match the panel's total.
  it('sums whole dinars exactly', () => {
    expect(sumIqd([3_000, 4_250, 5_500])).toBe(12_750);
    expect(sumIqd([])).toBe(0);
  });

  it('refuses to total a column containing a fraction', () => {
    // Returning a number here would produce a plausible-looking total built
    // from corrupt data, which is worse than showing nothing.
    expect(sumIqd([3_000, 4_250.5])).toBeNull();
    expect(sumIqd([3_000, null])).toBeNull();
  });

  it('handles a realistic five-ride reconciliation', () => {
    const fares = [3_000, 4_250, 7_500, 12_250, 5_750];
    expect(sumIqd(fares)).toBe(32_750);
  });
});

describe('formatDateTime', () => {
  // CLAUDE.md §8 - store UTC, display Asia/Baghdad.
  it('renders a UTC timestamp in Baghdad time', () => {
    // Baghdad is UTC+3 year round (no DST since 2015).
    const rendered = formatDateTime('2026-08-22T09:00:00.000Z');
    expect(rendered).toContain('12:00');
  });

  it('renders a dash for a missing timestamp', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
  });
});
