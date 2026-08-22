import { addIqd, applyBps, iqd, roundUpToMultiple, type IqdAmount } from '../money/iqd.js';

/**
 * Fare arithmetic. Pure, synchronous, no I/O.
 *
 * CLAUDE.md §3.2 forbids a synchronous external call in a request handler, and
 * a routing API call is exactly that. So a quote uses a haversine distance
 * scaled by a road factor rather than a real route. That is deliberately an
 * ESTIMATE, and the contract says so: `POST /fare/estimate` returns
 * `estimatedFareIqd`. Precise routing, if it is ever wanted, belongs in a
 * queued job used for post-trip reconciliation.
 *
 * Every intermediate value is a whole dinar (CLAUDE.md §6.1). There is no point
 * in the pipeline where a fraction exists and is later rounded - rounding
 * happens per component, so the parts always sum to the whole and a driver
 * disputing a fare can be shown arithmetic that adds up exactly.
 */

export interface FareTariff {
  baseIqd: IqdAmount;
  perKmIqd: IqdAmount;
  perMinuteIqd: IqdAmount;
  minimumIqd: IqdAmount;
  /** Final fare is rounded UP to a multiple of this. */
  roundingIqd: number;
}

export interface FareBreakdown {
  baseIqd: IqdAmount;
  distanceIqd: IqdAmount;
  timeIqd: IqdAmount;
  /** How much the minimum-fare floor added, if it applied. */
  minimumAppliedIqd: IqdAmount;
  /** How much rounding up to the nearest step added. */
  roundingIqd: IqdAmount;
}

export interface FareQuote {
  totalIqd: IqdAmount;
  distanceM: number;
  durationS: number;
  breakdown: FareBreakdown;
}

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Straight-line distance underestimates road distance everywhere. 1.35 is a
 * middling value for a dense grid-ish city; Baghdad's river crossings make it
 * optimistic for some trips and pessimistic for others.
 *
 * This is the single least defensible number in the fare path. It is a constant
 * here rather than config because changing it changes every quote at once and
 * should be a reviewed code change - but it is isolated so that the day real
 * trip data exists, it can be replaced by a fitted value with one edit and one
 * test update.
 */
export const ROAD_DISTANCE_FACTOR = 1.35;

/** Average city speed used to turn distance into a duration estimate. */
export const ASSUMED_SPEED_KMH = 25;

const EARTH_RADIUS_M = 6_372_797.560856;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function estimateRoadDistanceM(pickup: LatLng, dropoff: LatLng): number {
  return Math.round(haversineMeters(pickup, dropoff) * ROAD_DISTANCE_FACTOR);
}

export function estimateDurationS(distanceM: number): number {
  const metresPerSecond = (ASSUMED_SPEED_KMH * 1_000) / 3_600;
  return Math.round(distanceM / metresPerSecond);
}

export class FareCalculator {
  /**
   * Quote a fare for a distance and duration.
   *
   * Each component is rounded to a whole dinar on its own. Summing unrounded
   * components and rounding once at the end would produce a total that does not
   * equal the sum of the parts shown to the driver - a small thing that becomes
   * a large argument at the roadside.
   */
  quote(tariff: FareTariff, distanceM: number, durationS: number): FareQuote {
    assertNonNegativeFinite(distanceM, 'distanceM');
    assertNonNegativeFinite(durationS, 'durationS');

    const distanceIqd = iqd(Math.round((distanceM / 1_000) * tariff.perKmIqd));
    const timeIqd = iqd(Math.round((durationS / 60) * tariff.perMinuteIqd));

    const subtotal = addIqd(tariff.baseIqd, distanceIqd, timeIqd);

    const afterMinimum = subtotal < tariff.minimumIqd ? tariff.minimumIqd : subtotal;
    const minimumAppliedIqd = iqd(afterMinimum - subtotal);

    const total = roundUpToMultiple(afterMinimum, tariff.roundingIqd);
    const roundingIqd = iqd(total - afterMinimum);

    return {
      totalIqd: total,
      distanceM: Math.round(distanceM),
      durationS: Math.round(durationS),
      breakdown: {
        baseIqd: tariff.baseIqd,
        distanceIqd,
        timeIqd,
        minimumAppliedIqd,
        roundingIqd,
      },
    };
  }

  /** Quote from two points, estimating distance and duration. */
  quoteForTrip(tariff: FareTariff, pickup: LatLng, dropoff: LatLng): FareQuote {
    const distanceM = estimateRoadDistanceM(pickup, dropoff);
    return this.quote(tariff, distanceM, estimateDurationS(distanceM));
  }

  /**
   * Settle the final fare at trip end.
   *
   * If the driver app reported an odometer distance, the fare is recomputed
   * from it; otherwise the original estimate stands. The estimate is used as a
   * FLOOR either way: a rider was quoted a price and must never be charged more
   * than they agreed to... but they also should not pay less than the quote for
   * a trip that turned out shorter, because the quote is the contract. Charging
   * exactly the quote when the actual is lower would be the other defensible
   * choice; this one is stated explicitly so it is a decision and not an
   * accident. See DECISIONS.md.
   */
  settle(
    tariff: FareTariff,
    estimatedFareIqd: IqdAmount,
    actualDistanceM: number | null,
    actualDurationS: number | null,
  ): IqdAmount {
    if (actualDistanceM === null) return estimatedFareIqd;

    const durationS = actualDurationS ?? estimateDurationS(actualDistanceM);
    const recomputed = this.quote(tariff, actualDistanceM, durationS).totalIqd;

    return recomputed > estimatedFareIqd ? recomputed : estimatedFareIqd;
  }

  /**
   * Split a settled fare into the driver's share and the platform's.
   *
   * CLAUDE.md §6.5: the rate is config with a default of 0. At 0 the platform
   * takes nothing and the driver keeps the whole cash fare, which is the v1
   * shipping configuration.
   */
  splitCommission(
    fareIqd: IqdAmount,
    commissionBps: number,
  ): { commissionIqd: IqdAmount; driverEarningsIqd: IqdAmount } {
    const commissionIqd = applyBps(fareIqd, commissionBps);
    return {
      commissionIqd,
      // Subtraction, not a second percentage calculation. Computing the
      // driver's share independently would let the two halves fail to sum to
      // the fare on a rounding boundary, and the ledger would not balance.
      driverEarningsIqd: iqd(fareIqd - commissionIqd),
    };
  }
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number, got ${value}`);
  }
}
