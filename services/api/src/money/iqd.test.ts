import { describe, expect, it } from 'vitest';

import {
  addIqd,
  assertBpsPrecisionInvariant,
  applyBps,
  formatIqd,
  InvalidMoneyError,
  isIqdAmount,
  iqd,
  MAX_IQD,
  parseIqdFromDb,
  parseSignedIqdFromDb,
  roundUpToMultiple,
  signedIqd,
  subIqd,
} from './iqd.js';

describe('iqd()', () => {
  it('accepts whole non-negative integers', () => {
    expect(iqd(0)).toBe(0);
    expect(iqd(12_500)).toBe(12_500);
    expect(iqd(MAX_IQD)).toBe(MAX_IQD);
  });

  // CLAUDE.md §12.2 - this is the rule the whole module exists to enforce.
  it.each([0.5, 12_500.01, 1 / 3, 2000.0000001])('rejects the fraction %p', (v) => {
    expect(() => iqd(v)).toThrow(InvalidMoneyError);
    expect(() => iqd(v)).toThrow(/not an integer/);
  });

  it.each([NaN, Infinity, -Infinity])('rejects %p', (v) => {
    expect(() => iqd(v)).toThrow(InvalidMoneyError);
  });

  it('rejects negatives', () => {
    expect(() => iqd(-1)).toThrow(/negative/);
  });

  it('rejects amounts beyond MAX_IQD', () => {
    expect(() => iqd(MAX_IQD + 1)).toThrow(/exceeds MAX_IQD/);
  });

  it('rejects values beyond the safe integer range before the range check', () => {
    expect(() => iqd(Number.MAX_SAFE_INTEGER + 2)).toThrow(InvalidMoneyError);
  });

  it.each([null, undefined, '12500', {}, [], true, 12500n])('rejects the non-number %p', (v) => {
    expect(() => iqd(v)).toThrow(/not a number/);
  });
});

describe('signedIqd()', () => {
  it('accepts negatives, which iqd() does not', () => {
    expect(signedIqd(-5_000)).toBe(-5_000);
    expect(() => iqd(-5_000)).toThrow();
  });

  it('rejects fractions in either direction', () => {
    expect(() => signedIqd(-0.5)).toThrow(/not an integer/);
    expect(() => signedIqd(0.5)).toThrow(/not an integer/);
  });

  it('bounds magnitude on both sides', () => {
    expect(() => signedIqd(-MAX_IQD - 1)).toThrow(/magnitude exceeds/);
    expect(() => signedIqd(MAX_IQD + 1)).toThrow(/magnitude exceeds/);
  });
});

describe('isIqdAmount()', () => {
  it('answers without throwing', () => {
    expect(isIqdAmount(1000)).toBe(true);
    expect(isIqdAmount(0)).toBe(true);
    expect(isIqdAmount(10.5)).toBe(false);
    expect(isIqdAmount(-1)).toBe(false);
    expect(isIqdAmount('1000')).toBe(false);
    expect(isIqdAmount(MAX_IQD + 1)).toBe(false);
  });
});

describe('addIqd / subIqd', () => {
  it('adds', () => {
    expect(addIqd(iqd(1_000), iqd(2_500), iqd(500))).toBe(4_000);
  });

  it('adding nothing is zero', () => {
    expect(addIqd()).toBe(0);
  });

  it('subtracts', () => {
    expect(subIqd(iqd(5_000), iqd(1_500))).toBe(3_500);
  });

  it('refuses a subtraction that would go negative', () => {
    expect(() => subIqd(iqd(1_000), iqd(2_000))).toThrow(/negative/);
  });

  it('refuses an addition that overflows MAX_IQD', () => {
    expect(() => addIqd(iqd(MAX_IQD), iqd(1))).toThrow(/exceeds MAX_IQD/);
  });
});

describe('applyBps()', () => {
  // CLAUDE.md §6.5 - the shipped default.
  it('returns zero for the default 0 bps commission', () => {
    expect(applyBps(iqd(12_500), 0)).toBe(0);
  });

  it('computes whole-dinar commission', () => {
    expect(applyBps(iqd(10_000), 1_000)).toBe(1_000); // 10%
    expect(applyBps(iqd(12_500), 1_500)).toBe(1_875); // 15%
  });

  it('rounds half up rather than producing a fraction', () => {
    // 12,345 * 15% = 1851.75 -> 1852, not 1851.75
    expect(applyBps(iqd(12_345), 1_500)).toBe(1_852);
    // Exact .5 case: 10,010 * 5% = 500.5 -> 501
    expect(applyBps(iqd(10_010), 500)).toBe(501);
  });

  it('always returns a whole integer for a large sweep of inputs', () => {
    for (let amount = 0; amount <= 200_000; amount += 137) {
      for (const bps of [0, 1, 250, 999, 1_500, 3_333, 10_000]) {
        const result = applyBps(iqd(amount), bps);
        expect(Number.isInteger(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(amount);
      }
    }
  });

  it('100% commission returns the whole amount', () => {
    expect(applyBps(iqd(7_777), 10_000)).toBe(7_777);
  });

  it('rejects out-of-range or fractional bps', () => {
    expect(() => applyBps(iqd(1_000), -1)).toThrow(/between 0 and 10000/);
    expect(() => applyBps(iqd(1_000), 10_001)).toThrow(/between 0 and 10000/);
    expect(() => applyBps(iqd(1_000), 12.5)).toThrow(/must be an integer/);
  });

  // The module asserts at import that MAX_IQD * 10000 stays exact. This test
  // is the behavioural half of that claim: at the very top of the range the
  // result must still be exact, not merely "close".
  it('stays exact at the top of the supported range', () => {
    expect(MAX_IQD * 10_000).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(applyBps(iqd(MAX_IQD), 10_000)).toBe(MAX_IQD);
    expect(Number.isSafeInteger(applyBps(iqd(MAX_IQD), 9_999))).toBe(true);
  });

  // The float trap this function exists to avoid. A rate like 0.07 is not
  // representable in binary, so `1100 * 0.07` is 77.00000000000001 in IEEE-754.
  // A value like that reaching a money column is a CLAUDE.md §12.2 violation:
  // it renders as "77" in the UI and still poisons every later sum.
  it('does not reproduce the naive float multiplication', () => {
    expect(1_100 * 0.07).not.toBe(77);
    expect(1_100 * 0.07).toBeCloseTo(77);

    expect(applyBps(iqd(1_100), 700)).toBe(77);
    expect(Number.isInteger(applyBps(iqd(1_100), 700))).toBe(true);
  });

  // Not one drifting pair, but every one of them in a realistic fare range.
  // The float path produces hundreds of non-integers here; applyBps produces
  // none. That contrast is the actual claim being made.
  it('is exact across the whole realistic fare range where floats are not', () => {
    let floatDrifts = 0;
    for (let fare = 1_000; fare < 60_000; fare += 100) {
      for (const [bps, rate] of [[700, 0.07], [500, 0.05], [1_200, 0.12]] as const) {
        if (!Number.isInteger(fare * rate)) floatDrifts++;
        expect(Number.isInteger(applyBps(iqd(fare), bps))).toBe(true);
      }
    }
    expect(floatDrifts).toBeGreaterThan(0);
  });
});

describe('roundUpToMultiple()', () => {
  it('rounds up to the next step', () => {
    expect(roundUpToMultiple(iqd(12_437), 250)).toBe(12_500);
    expect(roundUpToMultiple(iqd(12_251), 250)).toBe(12_500);
  });

  it('leaves an exact multiple alone', () => {
    expect(roundUpToMultiple(iqd(12_500), 250)).toBe(12_500);
    expect(roundUpToMultiple(iqd(0), 250)).toBe(0);
  });

  it('never rounds down', () => {
    for (let v = 0; v < 3_000; v += 7) {
      const rounded = roundUpToMultiple(iqd(v), 250);
      expect(rounded).toBeGreaterThanOrEqual(v);
      expect(rounded % 250).toBe(0);
      expect(rounded - v).toBeLessThan(250);
    }
  });

  it('rejects a non-positive or fractional step', () => {
    expect(() => roundUpToMultiple(iqd(100), 0)).toThrow(/positive integer/);
    expect(() => roundUpToMultiple(iqd(100), -5)).toThrow(/positive integer/);
    expect(() => roundUpToMultiple(iqd(100), 2.5)).toThrow(/positive integer/);
  });
});

describe('parseIqdFromDb()', () => {
  // node-postgres returns BIGINT as a string. Treating it as a number by
  // accident gives '100' + 50 === '10050'. This is the guard against that.
  it('parses the string form node-postgres returns for int8', () => {
    expect(parseIqdFromDb('12500')).toBe(12_500);
    expect(parseIqdFromDb('0')).toBe(0);
  });

  it('parses numbers and bigints', () => {
    expect(parseIqdFromDb(12_500)).toBe(12_500);
    expect(parseIqdFromDb(12_500n)).toBe(12_500);
  });

  it('rejects a decimal string, which would mean a NUMERIC column crept in', () => {
    expect(() => parseIqdFromDb('12500.50')).toThrow(/not an integer string/);
  });

  it.each(['', 'abc', '1e5', '12 500', null, undefined, {}])('rejects %p', (v) => {
    expect(() => parseIqdFromDb(v)).toThrow(InvalidMoneyError);
  });

  it('rejects a bigint beyond the safe integer range instead of truncating it', () => {
    expect(() => parseIqdFromDb(9_007_199_254_740_993n)).toThrow(/safe integer range/);
  });
});

describe('parseSignedIqdFromDb()', () => {
  it('parses a negative balance, which a wallet can legitimately have', () => {
    expect(parseSignedIqdFromDb('-3000')).toBe(-3_000);
    expect(parseSignedIqdFromDb(-3_000)).toBe(-3_000);
    expect(parseSignedIqdFromDb(-3_000n)).toBe(-3_000);
  });

  it('rejects decimals and junk', () => {
    expect(() => parseSignedIqdFromDb('-3000.5')).toThrow(/not an integer string/);
    expect(() => parseSignedIqdFromDb(Symbol('x'))).toThrow(InvalidMoneyError);
  });

  it('rejects a bigint beyond the safe range in either direction', () => {
    expect(() => parseSignedIqdFromDb(9_007_199_254_740_993n)).toThrow(/safe integer range/);
    expect(() => parseSignedIqdFromDb(-9_007_199_254_740_993n)).toThrow(/safe integer range/);
  });
});

describe('assertBpsPrecisionInvariant()', () => {
  // The invariant applyBps relies on. It holds at the shipped MAX_IQD, and the
  // point of this test is to show what happens when it stops holding - so that
  // raising MAX_IQD carelessly fails loudly at boot rather than silently
  // corrupting commission months later.
  it('passes at the shipped MAX_IQD', () => {
    expect(() => assertBpsPrecisionInvariant(MAX_IQD)).not.toThrow();
  });

  it('throws once MAX_IQD is raised past the exact-integer point', () => {
    expect(() => assertBpsPrecisionInvariant(Number.MAX_SAFE_INTEGER)).toThrow(/too large/);
    expect(() => assertBpsPrecisionInvariant(1e15)).toThrow(/MAX_IQD \* 10000/);
  });
});

describe('formatIqd()', () => {
  // CLAUDE.md §8 - `12,500 د.ع`, thousands separator, no decimals.
  it('groups thousands and appends the dinar mark', () => {
    expect(formatIqd(iqd(12_500))).toBe('12,500 د.ع');
    expect(formatIqd(iqd(500))).toBe('500 د.ع');
    expect(formatIqd(iqd(1_000_000))).toBe('1,000,000 د.ع');
    expect(formatIqd(iqd(0))).toBe('0 د.ع');
  });

  // The currency mark `د.ع` itself contains a dot, so the assertion has to be
  // made about the NUMERIC part only - otherwise it passes for the wrong reason.
  it('never emits a decimal separator in the numeric part', () => {
    for (const v of [1, 12, 123, 1_234, 12_345, 123_456, 1_234_567]) {
      const numericPart = formatIqd(iqd(v)).replace(' د.ع', '');
      expect(numericPart).not.toMatch(/[.٫]/);
      expect(numericPart).toMatch(/^-?\d{1,3}(,\d{3})*$/);
    }
  });

  it('formats negative balances', () => {
    expect(formatIqd(signedIqd(-12_500))).toBe('-12,500 د.ع');
  });
});
