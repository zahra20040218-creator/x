import { describe, expect, it } from 'vitest';

import { iqd } from '../money/iqd.js';
import {
  ASSUMED_SPEED_KMH,
  estimateDurationS,
  estimateRoadDistanceM,
  FareCalculator,
  haversineMeters,
  ROAD_DISTANCE_FACTOR,
  type FareTariff,
} from './fare-calculator.js';

// The values seeded into platform_config by migration 0001.
const TARIFF: FareTariff = {
  baseIqd: iqd(2_000),
  perKmIqd: iqd(500),
  perMinuteIqd: iqd(50),
  minimumIqd: iqd(3_000),
  roundingIqd: 250,
};

const TAHRIR = { lat: 33.3061, lng: 44.4213 };
const KARRADA = { lat: 33.2989, lng: 44.4361 };

const calc = new FareCalculator();

describe('FareCalculator.quote', () => {
  it('adds base, distance and time', () => {
    // 10 km at 500/km = 5,000; 20 min at 50/min = 1,000; base 2,000 => 8,000.
    const quote = calc.quote(TARIFF, 10_000, 1_200);

    expect(quote.breakdown.baseIqd).toBe(2_000);
    expect(quote.breakdown.distanceIqd).toBe(5_000);
    expect(quote.breakdown.timeIqd).toBe(1_000);
    expect(quote.totalIqd).toBe(8_000);
  });

  it('applies the minimum fare to a very short trip', () => {
    // 200 m, 30 s => 2,000 + 100 + 25 = 2,125, below the 3,000 minimum.
    const quote = calc.quote(TARIFF, 200, 30);

    expect(quote.totalIqd).toBe(3_000);
    expect(quote.breakdown.minimumAppliedIqd).toBe(875);
  });

  it('does not apply the minimum when the fare already exceeds it', () => {
    expect(calc.quote(TARIFF, 10_000, 1_200).breakdown.minimumAppliedIqd).toBe(0);
  });

  it('rounds the total up to the configured step', () => {
    // 3,300 m => 1,650; 8 min => 400; + 2,000 = 4,050 -> 4,250.
    const quote = calc.quote(TARIFF, 3_300, 480);

    expect(quote.totalIqd % TARIFF.roundingIqd).toBe(0);
    expect(quote.totalIqd).toBe(4_250);
    expect(quote.breakdown.roundingIqd).toBe(200);
  });

  // CLAUDE.md §6.1 - the property that matters more than any single example.
  it('produces only whole dinars across a wide sweep of trips', () => {
    for (let distanceM = 0; distanceM <= 60_000; distanceM += 137) {
      for (const durationS of [0, 61, 599, 1_237, 3_600]) {
        const quote = calc.quote(TARIFF, distanceM, durationS);

        for (const value of [
          quote.totalIqd,
          quote.breakdown.baseIqd,
          quote.breakdown.distanceIqd,
          quote.breakdown.timeIqd,
          quote.breakdown.minimumAppliedIqd,
          quote.breakdown.roundingIqd,
        ]) {
          expect(Number.isInteger(value)).toBe(true);
        }
      }
    }
  });

  // If the parts do not sum to the total, a driver disputing a fare is shown
  // arithmetic that does not add up.
  it('always has a breakdown that sums exactly to the total', () => {
    for (let distanceM = 0; distanceM <= 40_000; distanceM += 311) {
      const quote = calc.quote(TARIFF, distanceM, estimateDurationS(distanceM));
      const { baseIqd, distanceIqd, timeIqd, minimumAppliedIqd, roundingIqd } = quote.breakdown;

      expect(baseIqd + distanceIqd + timeIqd + minimumAppliedIqd + roundingIqd).toBe(
        quote.totalIqd,
      );
    }
  });

  it('never quotes below the minimum', () => {
    for (let distanceM = 0; distanceM <= 5_000; distanceM += 50) {
      expect(calc.quote(TARIFF, distanceM, 0).totalIqd).toBeGreaterThanOrEqual(
        TARIFF.minimumIqd,
      );
    }
  });

  it('is monotonic: a longer trip never costs less', () => {
    let previous = 0;
    for (let distanceM = 0; distanceM <= 50_000; distanceM += 250) {
      const total = calc.quote(TARIFF, distanceM, estimateDurationS(distanceM)).totalIqd;
      expect(total).toBeGreaterThanOrEqual(previous);
      previous = total;
    }
  });

  it('quotes the minimum for a zero-distance trip rather than zero', () => {
    // A rider who requests and is driven nowhere still owes the flag-fall;
    // a zero fare would mean a free ride on a mis-reported odometer.
    expect(calc.quote(TARIFF, 0, 0).totalIqd).toBe(3_000);
  });

  it('rejects negative or non-finite inputs', () => {
    expect(() => calc.quote(TARIFF, -1, 60)).toThrow(RangeError);
    expect(() => calc.quote(TARIFF, 100, -1)).toThrow(RangeError);
    expect(() => calc.quote(TARIFF, NaN, 60)).toThrow(RangeError);
    expect(() => calc.quote(TARIFF, Infinity, 60)).toThrow(RangeError);
  });

  it('handles a zero tariff without producing a negative or fractional fare', () => {
    const free: FareTariff = {
      baseIqd: iqd(0),
      perKmIqd: iqd(0),
      perMinuteIqd: iqd(0),
      minimumIqd: iqd(0),
      roundingIqd: 1,
    };
    expect(calc.quote(free, 10_000, 1_200).totalIqd).toBe(0);
  });
});

describe('FareCalculator.quoteForTrip', () => {
  it('quotes a real Baghdad trip in a believable range', () => {
    const quote = calc.quoteForTrip(TARIFF, TAHRIR, KARRADA);

    // ~1.6 km straight line, ~2.2 km by road.
    expect(quote.distanceM).toBeGreaterThan(1_800);
    expect(quote.distanceM).toBeLessThan(2_600);
    expect(quote.totalIqd).toBeGreaterThanOrEqual(3_000);
    expect(quote.totalIqd).toBeLessThan(6_000);
  });

  it('quotes the minimum for pickup and dropoff at the same point', () => {
    expect(calc.quoteForTrip(TARIFF, TAHRIR, TAHRIR).totalIqd).toBe(3_000);
  });
});

describe('distance and duration estimation', () => {
  it('scales the straight line by the road factor', () => {
    const straight = haversineMeters(TAHRIR, KARRADA);
    expect(estimateRoadDistanceM(TAHRIR, KARRADA)).toBe(
      Math.round(straight * ROAD_DISTANCE_FACTOR),
    );
  });

  it('never estimates a road distance shorter than the straight line', () => {
    expect(ROAD_DISTANCE_FACTOR).toBeGreaterThanOrEqual(1);
  });

  it('derives duration from the assumed city speed', () => {
    // 25 km/h => 10 km in 24 minutes.
    expect(ASSUMED_SPEED_KMH).toBe(25);
    expect(estimateDurationS(10_000)).toBe(1_440);
  });
});

describe('FareCalculator.settle', () => {
  it('keeps the estimate when the driver reported no odometer distance', () => {
    expect(calc.settle(TARIFF, iqd(8_000), null, null)).toBe(8_000);
  });

  // The rider agreed to a price. A longer-than-expected route is the platform's
  // problem, not a licence to charge more than was quoted... except that here
  // the quote is a floor and the recompute is used only when it is HIGHER,
  // which is the documented choice - see DECISIONS.md D-004.
  it('uses the estimate as a floor', () => {
    // A much shorter actual trip still bills the quoted fare.
    expect(calc.settle(TARIFF, iqd(8_000), 500, 60)).toBe(8_000);
  });

  it('recomputes upward when the trip ran materially longer', () => {
    const settled = calc.settle(TARIFF, iqd(4_000), 30_000, 3_600);
    expect(settled).toBeGreaterThan(4_000);
    expect(Number.isInteger(settled)).toBe(true);
  });

  it('estimates a duration when only distance was reported', () => {
    const settled = calc.settle(TARIFF, iqd(3_000), 20_000, null);
    expect(settled).toBe(calc.quote(TARIFF, 20_000, estimateDurationS(20_000)).totalIqd);
  });

  it('always settles to a whole dinar', () => {
    for (let d = 0; d <= 40_000; d += 337) {
      expect(Number.isInteger(calc.settle(TARIFF, iqd(5_000), d, null))).toBe(true);
    }
  });
});

describe('FareCalculator.splitCommission', () => {
  // CLAUDE.md §6.5 - the shipped default.
  it('gives the driver everything at the default 0 bps', () => {
    const split = calc.splitCommission(iqd(12_500), 0);
    expect(split.commissionIqd).toBe(0);
    expect(split.driverEarningsIqd).toBe(12_500);
  });

  it('splits at a configured rate', () => {
    const split = calc.splitCommission(iqd(10_000), 1_500);
    expect(split.commissionIqd).toBe(1_500);
    expect(split.driverEarningsIqd).toBe(8_500);
  });

  // This is the property the ledger depends on. If the two halves ever failed
  // to sum to the fare, the double-entry rows would not balance and the DB
  // trigger would reject the whole settlement.
  it('always splits into two parts that sum exactly to the fare', () => {
    // Violations are COLLECTED and asserted once, rather than asserted inside
    // the loop. The coverage is identical - every fare and rate below is still
    // checked against all five properties - but the loop was making roughly
    // 29,000 `expect` calls, and each one carries matcher setup and error
    // message construction. That cost, not the arithmetic, made this the
    // slowest test in the suite; it timed out at 5s whenever the machine was
    // also building an APK.
    //
    // The failure message is better too: it names the exact fare and rate that
    // broke rather than stopping at the first one.
    const broken: string[] = [];

    for (let fare = 250; fare <= 100_000; fare += 137) {
      for (const bps of [0, 1, 333, 500, 1_500, 2_575, 9_999, 10_000]) {
        const { commissionIqd, driverEarningsIqd } = calc.splitCommission(iqd(fare), bps);

        if (commissionIqd + driverEarningsIqd !== fare) {
          broken.push(`fare ${fare} @ ${bps}bps: ${commissionIqd}+${driverEarningsIqd} != ${fare}`);
        }
        if (!Number.isInteger(commissionIqd) || !Number.isInteger(driverEarningsIqd)) {
          broken.push(`fare ${fare} @ ${bps}bps: not whole dinars`);
        }
        if (commissionIqd < 0 || driverEarningsIqd < 0) {
          broken.push(`fare ${fare} @ ${bps}bps: negative half`);
        }
      }
    }

    expect(broken).toEqual([]);
  });

  it('takes the whole fare at 100%', () => {
    const split = calc.splitCommission(iqd(7_777), 10_000);
    expect(split.commissionIqd).toBe(7_777);
    expect(split.driverEarningsIqd).toBe(0);
  });

  it('rejects an out-of-range rate', () => {
    expect(() => calc.splitCommission(iqd(1_000), 10_001)).toThrow();
    expect(() => calc.splitCommission(iqd(1_000), -1)).toThrow();
  });
});
