/**
 * Whole Iraqi Dinars. CLAUDE.md §6.1 / §12.2.
 *
 * IQD has no practically-used subunit, so an amount is always an integer. The
 * danger this module exists to remove is not "someone writes 12.5" - that is
 * obvious and easy to spot in review. It is the silent kind:
 *
 *   fare * 0.15                 -> 1875.0000000000002
 *   Math.round(a / b) * b       -> fine
 *   a / b * b                   -> drifts
 *   JSON.parse('{"x": 1e21}')   -> beyond safe integers, comparisons lie
 *
 * Every one of those produces a number that still passes `typeof x === 'number'`
 * and still renders as something plausible in the UI, and only shows up as a
 * dispute with a driver months later.
 *
 * So amounts are a BRANDED type. A plain `number` cannot be passed where an
 * `IqdAmount` is expected; it has to go through `iqd()`, which throws on
 * anything that is not a safe non-negative integer. The brand is erased at
 * runtime - there is no wrapper object and no allocation.
 */

declare const IQD_BRAND: unique symbol;

/** A whole, non-negative, safe-integer amount of Iraqi Dinars. */
export type IqdAmount = number & { readonly [IQD_BRAND]: 'IQD' };

/**
 * A signed amount, for corrections and adjustments that may be negative.
 * Deliberately a different type: a wallet ADJUSTMENT can be negative, a ride
 * FARE cannot, and the type system should not let one be used as the other.
 */
export type SignedIqdAmount = number & { readonly [IQD_BRAND]: 'IQD_SIGNED' };

export class InvalidMoneyError extends Error {
  constructor(
    readonly value: unknown,
    readonly reason: string,
  ) {
    super(`Invalid IQD amount (${reason}): ${String(value)}`);
    this.name = 'InvalidMoneyError';
  }
}

/**
 * The largest amount the system will accept, ~100 billion IQD. Far above any
 * real fare or wallet balance, far below Number.MAX_SAFE_INTEGER, so that
 * repeated addition can never approach the precision cliff.
 */
export const MAX_IQD = 100_000_000_000;

/**
 * Module invariant, checked once at import.
 *
 * `applyBps` multiplies an amount by up to 10,000 before dividing. That product
 * must stay inside the exact-integer range or commission silently loses
 * precision. At the current MAX_IQD the worst case is 1e15, comfortably under
 * 2^53-1 ~ 9.007e15 - so there is no reachable overflow to guard at call time,
 * and adding a per-call check would be untestable dead code.
 *
 * Instead the assumption is asserted here. If someone later raises MAX_IQD past
 * the safe point, the process fails at boot with this message rather than
 * producing quietly wrong commission months later.
 */
if (MAX_IQD * 10_000 > Number.MAX_SAFE_INTEGER) {
  throw new Error(
    `MAX_IQD (${MAX_IQD}) is too large: MAX_IQD * 10000 must stay within ` +
      `Number.MAX_SAFE_INTEGER for applyBps() to be exact.`,
  );
}

function assertUsableNumber(value: unknown): asserts value is number {
  if (typeof value !== 'number') throw new InvalidMoneyError(value, 'not a number');
  if (Number.isNaN(value)) throw new InvalidMoneyError(value, 'NaN');
  if (!Number.isFinite(value)) throw new InvalidMoneyError(value, 'not finite');
  if (!Number.isInteger(value)) throw new InvalidMoneyError(value, 'not an integer - IQD has no subunit');
  if (!Number.isSafeInteger(value)) throw new InvalidMoneyError(value, 'beyond safe integer range');
}

/** Construct a non-negative IQD amount. Throws on fractions, NaN, or overflow. */
export function iqd(value: unknown): IqdAmount {
  assertUsableNumber(value);
  if (value < 0) throw new InvalidMoneyError(value, 'negative');
  if (value > MAX_IQD) throw new InvalidMoneyError(value, `exceeds MAX_IQD (${MAX_IQD})`);
  return value as IqdAmount;
}

/** Construct a signed IQD amount, for corrections that may be negative. */
export function signedIqd(value: unknown): SignedIqdAmount {
  assertUsableNumber(value);
  if (value > MAX_IQD || value < -MAX_IQD) {
    throw new InvalidMoneyError(value, `magnitude exceeds MAX_IQD (${MAX_IQD})`);
  }
  return value as SignedIqdAmount;
}

export const ZERO_IQD = 0 as IqdAmount;

/** Type guard that does not throw - for validating untrusted input. */
export function isIqdAmount(value: unknown): value is IqdAmount {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_IQD
  );
}

export function addIqd(...amounts: IqdAmount[]): IqdAmount {
  let total = 0;
  for (const a of amounts) total += a;
  return iqd(total);
}

/** Subtraction that refuses to go negative - use `signedIqd` arithmetic if it may. */
export function subIqd(a: IqdAmount, b: IqdAmount): IqdAmount {
  return iqd(a - b);
}

/**
 * Multiply an amount by a basis-points rate and round HALF-UP to a whole dinar.
 *
 * Used for commission (CLAUDE.md §6.5). Implemented purely in integers:
 * `floor((amount * bps + 5000) / 10000)`. Never `amount * 0.15`, which would
 * reintroduce the float this module exists to keep out. Exactness of the
 * intermediate product is guaranteed by the MAX_IQD invariant above.
 */
export function applyBps(amount: IqdAmount, bps: number): IqdAmount {
  if (!Number.isInteger(bps)) throw new InvalidMoneyError(bps, 'bps must be an integer');
  if (bps < 0 || bps > 10_000) throw new InvalidMoneyError(bps, 'bps must be between 0 and 10000');

  // Exactness of this product is guaranteed by the MAX_IQD invariant above.
  return iqd(Math.floor((amount * bps + 5_000) / 10_000));
}

/**
 * Round UP to the next multiple of `step`. Fares are quoted in round numbers
 * because drivers are paid in cash and cannot make change for 12,437 dinars.
 */
export function roundUpToMultiple(amount: IqdAmount, step: number): IqdAmount {
  if (!Number.isInteger(step) || step < 1) {
    throw new InvalidMoneyError(step, 'rounding step must be a positive integer');
  }
  return iqd(Math.ceil(amount / step) * step);
}

/**
 * Parse a BIGINT column value coming back from `pg`.
 *
 * node-postgres returns int8 as a STRING by default, precisely so that large
 * values are not silently mangled into floats. Passing that string into
 * arithmetic gives string concatenation ('100' + 50 === '10050'), which is the
 * single most likely way a money bug enters this codebase. This function is the
 * only sanctioned way to turn a DB money value into a number.
 */
export function parseIqdFromDb(value: unknown): IqdAmount {
  if (typeof value === 'number') return iqd(value);
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new InvalidMoneyError(value, 'bigint beyond safe integer range');
    }
    return iqd(Number(value));
  }
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) throw new InvalidMoneyError(value, 'not an integer string');
    return iqd(Number(value));
  }
  throw new InvalidMoneyError(value, 'unsupported database money representation');
}

/** Signed variant of {@link parseIqdFromDb}, for balances that may be negative. */
export function parseSignedIqdFromDb(value: unknown): SignedIqdAmount {
  if (typeof value === 'number') return signedIqd(value);
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new InvalidMoneyError(value, 'bigint beyond safe integer range');
    }
    return signedIqd(Number(value));
  }
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) throw new InvalidMoneyError(value, 'not an integer string');
    return signedIqd(Number(value));
  }
  throw new InvalidMoneyError(value, 'unsupported database money representation');
}

/**
 * Display form: `12,500 د.ع` (CLAUDE.md §8).
 *
 * The API does NOT return formatted money - it returns integers, and the app
 * formats them. This lives here only so that the admin panel and any server-
 * rendered output use the same rule, and so the format has one test.
 */
export function formatIqd(amount: IqdAmount | SignedIqdAmount): string {
  const sign = amount < 0 ? '-' : '';
  const digits = Math.abs(amount).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped} د.ع`;
}
