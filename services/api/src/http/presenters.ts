import type { LedgerEntry } from '../ledger/ledger.types.js';
import type { RideRecord } from '../rides/ride.types.js';

/**
 * Wire representations.
 *
 * This file is a privacy boundary, not a formatting convenience.
 *
 * `ACCEPTANCE_CHECKLIST.md` check 5 asks whether a driver can see the rider's
 * phone number after the trip. The answer is enforced by `PublicUser` having no
 * `phone` field AT ALL — not a field that gets filtered, because a filter is a
 * line someone can delete and a missing field is a compile error.
 *
 * The only shapes carrying a phone are `MePresentation` (your own) and the
 * admin ones.
 */

export interface PublicUserPresentation {
  id: string;
  displayName: string;
  rating: number | null;
  vehicle?: { plate: string; model: string; color: string } | null;
}

export interface RidePresentation {
  id: string;
  status: string;
  rider?: PublicUserPresentation;
  driver: PublicUserPresentation | null;
  pickup: { lat: number; lng: number };
  pickupAddress: string | null;
  dropoff: { lat: number; lng: number };
  dropoffAddress: string | null;
  estimatedFareIqd: number;
  finalFareIqd: number | null;
  commissionIqd: number | null;
  estimatedDistanceM: number;
  estimatedDurationS: number;
  actualDistanceM: number | null;
  paymentMethod: string;
  requestedAt: string;
  acceptedAt: string | null;
  driverArrivedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
}

export interface CounterpartyRow {
  id: string;
  display_name: string;
  rating_sum: string | number | null;
  rating_count: string | number | null;
  vehicle_plate?: string | null;
  vehicle_model?: string | null;
  vehicle_color?: string | null;
}

export function presentPublicUser(row: CounterpartyRow): PublicUserPresentation {
  const sum = Number(row.rating_sum ?? 0);
  const count = Number(row.rating_count ?? 0);

  const presentation: PublicUserPresentation = {
    id: row.id,
    displayName: row.display_name,
    // Averaged to one decimal for display. This is a RATING, not money - it is
    // the one place a fractional number is correct.
    rating: count > 0 ? Math.round((sum / count) * 10) / 10 : null,
  };

  if (row.vehicle_plate) {
    presentation.vehicle = {
      plate: row.vehicle_plate,
      model: row.vehicle_model ?? '',
      color: row.vehicle_color ?? '',
    };
  }

  return presentation;
}

export function presentRide(
  ride: RideRecord,
  counterparties: { rider?: CounterpartyRow; driver?: CounterpartyRow } = {},
): RidePresentation {
  const presentation: RidePresentation = {
    id: ride.id,
    status: ride.status,
    driver: counterparties.driver ? presentPublicUser(counterparties.driver) : null,
    pickup: { lat: ride.pickupLat, lng: ride.pickupLng },
    pickupAddress: ride.pickupAddress,
    dropoff: { lat: ride.dropoffLat, lng: ride.dropoffLng },
    dropoffAddress: ride.dropoffAddress,
    estimatedFareIqd: ride.estimatedFareIqd,
    finalFareIqd: ride.finalFareIqd,
    commissionIqd: ride.commissionIqd,
    estimatedDistanceM: ride.estimatedDistanceM,
    estimatedDurationS: ride.estimatedDurationS,
    actualDistanceM: ride.actualDistanceM,
    paymentMethod: ride.paymentMethod,
    requestedAt: ride.requestedAt.toISOString(),
    acceptedAt: iso(ride.acceptedAt),
    driverArrivedAt: iso(ride.driverArrivedAt),
    startedAt: iso(ride.startedAt),
    completedAt: iso(ride.completedAt),
    cancelledAt: iso(ride.cancelledAt),
    cancellationReason: ride.cancellationReason,
  };

  if (counterparties.rider) {
    presentation.rider = presentPublicUser(counterparties.rider);
  }

  return presentation;
}

export function presentLedgerEntry(entry: LedgerEntry): Record<string, unknown> {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    rideId: entry.rideId,
    accountType: entry.accountType,
    direction: entry.direction,
    amountIqd: entry.amountIqd,
    description: entry.description,
    createdAt: entry.createdAt.toISOString(),
  };
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}
