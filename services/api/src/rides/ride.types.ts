import type { IqdAmount } from '../money/iqd.js';

/** CLAUDE.md §4. Mirrors the `ride_status` enum in the database exactly. */
export const RIDE_STATUSES = [
  'REQUESTED',
  'OFFERED',
  'ACCEPTED',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED_BY_RIDER',
  'CANCELLED_BY_DRIVER',
  'CANCELLED_IN_TRIP',
  'EXPIRED',
  'NO_DRIVERS_FOUND',
] as const;

export type RideStatus = (typeof RIDE_STATUSES)[number];

export const ACTOR_TYPES = ['RIDER', 'DRIVER', 'ADMIN', 'SYSTEM'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** States from which no transition is permitted. */
export const TERMINAL_STATUSES: ReadonlySet<RideStatus> = new Set<RideStatus>([
  'COMPLETED',
  'CANCELLED_BY_RIDER',
  'CANCELLED_BY_DRIVER',
  'CANCELLED_IN_TRIP',
  'NO_DRIVERS_FOUND',
]);

/**
 * States in which a ride occupies its rider and (once assigned) its driver.
 * Used by the "one live ride" guards and mirrored by the partial unique indexes
 * in the schema.
 */
export const ACTIVE_STATUSES: ReadonlySet<RideStatus> = new Set<RideStatus>([
  'REQUESTED',
  'OFFERED',
  'ACCEPTED',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
]);

/** States in which the driver is committed to this ride and is `ON_TRIP`. */
export const DRIVER_ENGAGED_STATUSES: ReadonlySet<RideStatus> = new Set<RideStatus>([
  'ACCEPTED',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
]);

export function isTerminal(status: RideStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface Actor {
  type: ActorType;
  /** Absent only for SYSTEM. */
  id?: string;
}

/** The minimum a transition needs to know about the ride it is moving. */
export interface RideSnapshot {
  id: string;
  status: RideStatus;
  riderId: string;
  driverId: string | null;
}

export interface RideRecord extends RideSnapshot {
  pickupLat: number;
  pickupLng: number;
  pickupAddress: string | null;
  dropoffLat: number;
  dropoffLng: number;
  dropoffAddress: string | null;
  estimatedFareIqd: IqdAmount;
  finalFareIqd: IqdAmount | null;
  commissionBpsSnapshot: number;
  commissionIqd: IqdAmount | null;
  estimatedDistanceM: number;
  estimatedDurationS: number;
  actualDistanceM: number | null;
  paymentMethod: 'CASH' | 'GATEWAY';
  requestedAt: Date;
  acceptedAt: Date | null;
  driverArrivedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
}

export interface RideEvent {
  rideId: string;
  fromState: RideStatus | null;
  toState: RideStatus;
  actorType: ActorType;
  actorId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}
