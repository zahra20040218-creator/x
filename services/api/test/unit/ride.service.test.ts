import { beforeEach, describe, expect, it } from 'vitest';

import { FakeClock } from '../../src/common/clock.js';
import {
  ConflictProblem,
  InvalidRideTransitionError,
  NotFoundProblem,
  RideActorNotPermittedError,
  RideAlreadyClaimedError,
} from '../../src/common/problem.js';
import { FareCalculator } from '../../src/fare/fare-calculator.js';
import { LedgerService } from '../../src/ledger/ledger.service.js';
import { RideClaimService } from '../../src/matching/ride-claim.service.js';
import { PlatformConfigService } from '../../src/platform-config/platform-config.service.js';
import { InMemoryRedis } from '../../src/redis/in-memory-redis.js';
import { RideStateMachine } from '../../src/rides/ride-state-machine.js';
import { RideRepository } from '../../src/rides/ride.repository.js';
import { RideService } from '../../src/rides/ride.service.js';
import type { Actor } from '../../src/rides/ride.types.js';
import { FakeDatabase } from '../fakes/fake-database.js';

const RIDER_A = 'aaaa0000-0000-4000-8000-000000000001';
const RIDER_B = 'aaaa0000-0000-4000-8000-000000000002';
const DRIVER_A = 'bbbb0000-0000-4000-8000-000000000001';
const DRIVER_B = 'bbbb0000-0000-4000-8000-000000000002';
const DRIVER_C = 'bbbb0000-0000-4000-8000-000000000003';
const ADMIN = 'cccc0000-0000-4000-8000-000000000001';

const TAHRIR = { lat: 33.3061, lng: 44.4213 };
const KARRADA = { lat: 33.2989, lng: 44.4361 };

const riderActor = (id = RIDER_A): Actor => ({ type: 'RIDER', id });
const driverActor = (id = DRIVER_A): Actor => ({ type: 'DRIVER', id });
const adminActor = (): Actor => ({ type: 'ADMIN', id: ADMIN });

const DEFAULT_CONFIG = {
  commission_bps: 0,
  fare_base_iqd: 2_000,
  fare_per_km_iqd: 500,
  fare_per_minute_iqd: 50,
  fare_minimum_iqd: 3_000,
  fare_rounding_iqd: 250,
  offer_timeout_seconds: 15,
  search_radius_meters: 5_000,
};

describe('RideService', () => {
  let clock: FakeClock;
  let db: FakeDatabase;
  let redis: InMemoryRedis;
  let claims: RideClaimService;
  let config: PlatformConfigService;
  let service: RideService;

  beforeEach(() => {
    clock = new FakeClock();
    db = new FakeDatabase();
    db.seedConfig(DEFAULT_CONFIG);
    db.seedDriver(DRIVER_A);
    db.seedDriver(DRIVER_B);
    db.seedDriver(DRIVER_C);

    redis = new InMemoryRedis(clock);
    claims = new RideClaimService(redis, 30_000);
    config = new PlatformConfigService(clock, 30_000);

    service = new RideService(
      db,
      new RideRepository(),
      new RideStateMachine(),
      claims,
      new LedgerService(),
      new FareCalculator(),
      config,
      clock,
    );
  });

  async function createRide(riderId = RIDER_A) {
    return service.createRide({ riderId, pickup: TAHRIR, dropoff: KARRADA });
  }

  /**
   * Create a ride and put it in front of the given drivers.
   *
   * The offer step is NOT optional: the state machine has no
   * REQUESTED -> ACCEPTED rule (CLAUDE.md 4), so a ride must be OFFERED before
   * any driver can accept it. In production the matching worker does this.
   */
  async function offeredRide(...drivers: string[]) {
    const ride = await createRide();
    await service.offerRideTo(ride.id, drivers[0] ?? DRIVER_A);
    return ride;
  }

  /** Drive a ride to IN_PROGRESS with the given driver. */
  async function rideInProgress(driverId = DRIVER_A) {
    const ride = await offeredRide(driverId);
    await service.acceptRide(ride.id, driverId);
    await service.markArrived(ride.id, driverActor(driverId));
    await service.startRide(ride.id, driverActor(driverId));
    return ride;
  }

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  describe('createRide', () => {
    it('creates a REQUESTED ride with a whole-dinar fare', async () => {
      const ride = await createRide();

      expect(ride.status).toBe('REQUESTED');
      expect(ride.riderId).toBe(RIDER_A);
      expect(ride.driverId).toBeNull();
      expect(Number.isInteger(ride.estimatedFareIqd)).toBe(true);
      expect(ride.estimatedFareIqd).toBeGreaterThanOrEqual(3_000);
    });

    it('writes exactly one ride_events row', async () => {
      await createRide();
      expect(db.rows('ride_events')).toHaveLength(1);
    });

    // CLAUDE.md §6.5 - the rate is frozen at creation so a mid-trip config
    // change cannot alter terms a driver already accepted.
    it('snapshots the commission rate onto the ride', async () => {
      expect((await createRide()).commissionBpsSnapshot).toBe(0);

      db.seedConfig({ ...DEFAULT_CONFIG, commission_bps: 1_500 });
      config.invalidate();

      expect((await createRide(RIDER_B)).commissionBpsSnapshot).toBe(1_500);
    });

    it('refuses a second live ride for the same rider', async () => {
      await createRide();
      await expect(createRide()).rejects.toThrow(ConflictProblem);
      await expect(createRide()).rejects.toThrow(/already have a ride in progress/);
    });

    it('allows a new ride once the previous one is cancelled', async () => {
      const first = await createRide();
      await service.cancelRide(first.id, riderActor());
      await expect(createRide()).resolves.toBeDefined();
    });

    it('rolls back the event row when the insert fails', async () => {
      db.failNextWrite = new Error('disk full');
      await expect(createRide()).rejects.toThrow('disk full');

      expect(db.rows('rides')).toHaveLength(0);
      expect(db.rows('ride_events')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // ACCEPTANCE_CHECKLIST.md check 4 - end to end this time
  // -------------------------------------------------------------------------

  describe('acceptRide - the double-accept case', () => {
    it('lets exactly one of three simultaneous drivers accept', async () => {
      const ride = await offeredRide(DRIVER_A);

      const results = await Promise.allSettled([
        service.acceptRide(ride.id, DRIVER_A),
        service.acceptRide(ride.id, DRIVER_B),
        service.acceptRide(ride.id, DRIVER_C),
      ]);

      const accepted = results.filter((r) => r.status === 'fulfilled');
      expect(accepted).toHaveLength(1);

      for (const rejected of results.filter((r) => r.status === 'rejected')) {
        expect(rejected.reason).toBeInstanceOf(RideAlreadyClaimedError);
      }

      // And the persisted ride names exactly one of them.
      const stored = db.rows('rides')[0]!;
      expect(stored['status']).toBe('ACCEPTED');
      expect([DRIVER_A, DRIVER_B, DRIVER_C]).toContain(stored['driver_id']);
    });

    it('lets exactly one of twenty simultaneous drivers accept', async () => {
      const ride = await offeredRide(DRIVER_A);
      const drivers = Array.from({ length: 20 }, (_, i) => `driver-${i}`);
      for (const d of drivers) db.seedDriver(d);

      const results = await Promise.allSettled(
        drivers.map((d) => service.acceptRide(ride.id, d)),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    it('marks the ride ACCEPTED and puts the driver ON_TRIP', async () => {
      const ride = await offeredRide();
      const accepted = await service.acceptRide(ride.id, DRIVER_A);

      expect(accepted.status).toBe('ACCEPTED');
      expect(accepted.driverId).toBe(DRIVER_A);
      expect(accepted.acceptedAt).not.toBeNull();

      const driver = db.rows('drivers').find((d) => d['user_id'] === DRIVER_A);
      expect(driver!['availability']).toBe('ON_TRIP');
    });

    it('a second driver gets 409, not a silent overwrite', async () => {
      const ride = await offeredRide();
      await service.acceptRide(ride.id, DRIVER_A);

      await expect(service.acceptRide(ride.id, DRIVER_B)).rejects.toThrow(
        RideAlreadyClaimedError,
      );
      expect(db.rows('rides')[0]!['driver_id']).toBe(DRIVER_A);
    });

    it('releases the claim when the transaction fails, so another driver can take it', async () => {
      const ride = await offeredRide();
      db.failNextWrite = new Error('deadlock detected');

      await expect(service.acceptRide(ride.id, DRIVER_A)).rejects.toThrow('deadlock detected');

      expect(await claims.currentHolder(ride.id)).toBeNull();
      await expect(service.acceptRide(ride.id, DRIVER_B)).resolves.toBeDefined();
    });

    it('404s for a ride that does not exist', async () => {
      await expect(
        service.acceptRide('11111111-1111-4111-8111-111111111111', DRIVER_A),
      ).rejects.toThrow(NotFoundProblem);
    });

    it('refuses to accept a ride that is already in progress', async () => {
      const ride = await rideInProgress();
      await expect(service.acceptRide(ride.id, DRIVER_B)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Driver transitions and authorisation
  // -------------------------------------------------------------------------

  describe('driver transitions', () => {
    it('walks arrived -> start -> complete', async () => {
      const ride = await offeredRide();
      await service.acceptRide(ride.id, DRIVER_A);

      expect((await service.markArrived(ride.id, driverActor())).status).toBe('DRIVER_ARRIVED');
      expect((await service.startRide(ride.id, driverActor())).status).toBe('IN_PROGRESS');
      expect((await service.completeRide(ride.id, driverActor())).ride.status).toBe('COMPLETED');
    });

    // ACCEPTANCE_CHECKLIST.md check 5.
    it('refuses a driver acting on another driver ride', async () => {
      const ride = await offeredRide();
      await service.acceptRide(ride.id, DRIVER_A);

      await expect(service.markArrived(ride.id, driverActor(DRIVER_B))).rejects.toThrow(
        RideActorNotPermittedError,
      );
    });

    // Asserted on a ride that is actually IN_PROGRESS. On an ACCEPTED ride the
    // transition check fires first and you get 409 rather than 403 - which is
    // correct, but proves nothing about actor authorisation.
    it('refuses another driver completing a trip in progress', async () => {
      const ride = await rideInProgress(DRIVER_A);

      await expect(service.completeRide(ride.id, driverActor(DRIVER_B))).rejects.toThrow(
        RideActorNotPermittedError,
      );
      expect(db.rows('ledger_entries')).toHaveLength(0);
    });

    it('refuses an out-of-order transition with 409', async () => {
      const ride = await offeredRide();
      await service.acceptRide(ride.id, DRIVER_A);

      // Cannot start before arriving.
      await expect(service.startRide(ride.id, driverActor())).rejects.toThrow(
        InvalidRideTransitionError,
      );
    });

    it('refuses to complete a ride that never started', async () => {
      const ride = await offeredRide();
      await service.acceptRide(ride.id, DRIVER_A);
      await expect(service.completeRide(ride.id, driverActor())).rejects.toThrow(
        InvalidRideTransitionError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Visibility - ACCEPTANCE_CHECKLIST.md check 5
  // -------------------------------------------------------------------------

  describe('visibility', () => {
    it('lets the owning rider read their ride', async () => {
      const ride = await createRide();
      expect((await service.getRideFor(ride.id, riderActor())).id).toBe(ride.id);
    });

    // 404 rather than 403 - see DECISIONS.md D-007. A 403 would confirm the
    // ride id is real, which is an oracle over other people's trips.
    it('gives another rider a 404, not a 403', async () => {
      const ride = await createRide();

      await expect(service.getRideFor(ride.id, riderActor(RIDER_B))).rejects.toThrow(
        NotFoundProblem,
      );
      try {
        await service.getRideFor(ride.id, riderActor(RIDER_B));
      } catch (error) {
        expect((error as NotFoundProblem).status).toBe(404);
      }
    });

    it('gives an unassigned driver a 404', async () => {
      const ride = await offeredRide();
      await service.acceptRide(ride.id, DRIVER_A);

      await expect(service.getRideFor(ride.id, driverActor(DRIVER_B))).rejects.toThrow(
        NotFoundProblem,
      );
    });

    it('lets the assigned driver read it', async () => {
      const ride = await offeredRide();
      await service.acceptRide(ride.id, DRIVER_A);
      expect((await service.getRideFor(ride.id, driverActor())).id).toBe(ride.id);
    });

    it('lets an admin read any ride', async () => {
      const ride = await createRide();
      expect((await service.getRideFor(ride.id, adminActor())).id).toBe(ride.id);
    });

    it('never returns another rider rides in the list', async () => {
      await createRide(RIDER_A);
      await createRide(RIDER_B);

      const mine = await service.listMyRides(riderActor(RIDER_A));
      expect(mine).toHaveLength(1);
      expect(mine[0]!.riderId).toBe(RIDER_A);
    });

    it('clamps the page size regardless of what the caller asks for', async () => {
      // 60 finished rides for one rider; only one may be live at a time.
      for (let i = 0; i < 60; i++) {
        const ride = await createRide();
        await service.cancelRide(ride.id, riderActor());
      }

      expect(await service.listMyRides(riderActor(), { limit: 10_000 })).toHaveLength(50);
      expect(await service.listMyRides(riderActor(), { limit: 5 })).toHaveLength(5);
      // A zero or negative page size floors at 1 rather than returning nothing.
      expect(await service.listMyRides(riderActor(), { limit: 0 })).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Settlement - ACCEPTANCE_CHECKLIST.md check 6
  // -------------------------------------------------------------------------

  describe('completeRide - settlement', () => {
    it('settles with a balanced ledger transaction', async () => {
      const ride = await rideInProgress();
      const { ride: completed, ledgerTransactionId } = await service.completeRide(
        ride.id,
        driverActor(),
      );

      expect(completed.status).toBe('COMPLETED');
      expect(completed.finalFareIqd).not.toBeNull();
      expect(db.ledgerNet(ledgerTransactionId)).toBe(0);
      expect(db.rows('ledger_entries').length).toBeGreaterThanOrEqual(2);
    });

    it('writes exactly one payment row for the settled amount', async () => {
      const ride = await rideInProgress();
      const { ride: completed } = await service.completeRide(ride.id, driverActor());

      const payments = db.rows('payments');
      expect(payments).toHaveLength(1);
      expect(payments[0]!['amount_iqd']).toBe(String(completed.finalFareIqd));
      expect(payments[0]!['status']).toBe('CONFIRMED');
    });

    // CLAUDE.md §6.5 default: the driver keeps the whole fare.
    it('credits the driver the whole fare at zero commission', async () => {
      const ride = await rideInProgress();
      const { ride: completed } = await service.completeRide(ride.id, driverActor());

      expect(completed.commissionIqd).toBe(0);
      expect(db.walletBalance(DRIVER_A)).toBe(completed.finalFareIqd);
    });

    it('splits correctly when a commission is configured', async () => {
      db.seedConfig({ ...DEFAULT_CONFIG, commission_bps: 1_500 });
      config.invalidate();

      const ride = await rideInProgress();
      const { ride: completed, ledgerTransactionId } = await service.completeRide(
        ride.id,
        driverActor(),
      );

      const fare = completed.finalFareIqd!;
      const commission = completed.commissionIqd!;

      expect(commission).toBeGreaterThan(0);
      expect(db.walletBalance(DRIVER_A)).toBe(fare - commission);
      expect(db.ledgerNet(ledgerTransactionId)).toBe(0);
    });

    // The reason the snapshot exists: an admin raising the rate mid-trip must
    // not change what the driver was promised when they accepted.
    it('settles at the snapshotted rate, not a rate changed mid-trip', async () => {
      const ride = await rideInProgress();

      db.seedConfig({ ...DEFAULT_CONFIG, commission_bps: 5_000 });
      config.invalidate();

      const { ride: completed } = await service.completeRide(ride.id, driverActor());

      expect(completed.commissionIqd).toBe(0);
      expect(db.walletBalance(DRIVER_A)).toBe(completed.finalFareIqd);
    });

    it('every money value is a whole integer', async () => {
      const ride = await rideInProgress();
      const { ride: completed } = await service.completeRide(ride.id, driverActor());

      expect(Number.isInteger(completed.finalFareIqd)).toBe(true);
      expect(Number.isInteger(completed.commissionIqd)).toBe(true);
      for (const entry of db.rows('ledger_entries')) {
        expect(Number.isInteger(Number(entry['amount_iqd']))).toBe(true);
      }
    });

    it('recomputes upward when the driver reports a much longer trip', async () => {
      const ride = await rideInProgress();
      const { ride: completed } = await service.completeRide(ride.id, driverActor(), 40_000);

      expect(completed.finalFareIqd!).toBeGreaterThan(ride.estimatedFareIqd);
      expect(completed.actualDistanceM).toBe(40_000);
    });

    it('never charges less than the quoted fare', async () => {
      const ride = await rideInProgress();
      const { ride: completed } = await service.completeRide(ride.id, driverActor(), 10);

      expect(completed.finalFareIqd).toBe(ride.estimatedFareIqd);
    });

    // A retried completion must not settle twice.
    it('is idempotent - completing twice does not double-settle', async () => {
      const ride = await rideInProgress();
      const first = await service.completeRide(ride.id, driverActor());
      const ledgerRowsAfterFirst = db.rows('ledger_entries').length;
      const walletAfterFirst = db.walletBalance(DRIVER_A);

      const second = await service.completeRide(ride.id, driverActor());

      expect(second.ride.status).toBe('COMPLETED');
      expect(second.ride.finalFareIqd).toBe(first.ride.finalFareIqd);
      expect(db.rows('ledger_entries')).toHaveLength(ledgerRowsAfterFirst);
      expect(db.walletBalance(DRIVER_A)).toBe(walletAfterFirst);
      expect(db.rows('payments')).toHaveLength(1);
    });

    it('puts the driver back ONLINE and releases the claim', async () => {
      const ride = await rideInProgress();
      await service.completeRide(ride.id, driverActor());

      expect(db.rows('drivers').find((d) => d['user_id'] === DRIVER_A)!['availability']).toBe(
        'ONLINE',
      );
      expect(await claims.currentHolder(ride.id)).toBeNull();
    });

    // The whole point of doing settlement in one transaction.
    it('writes nothing at all when the ledger write fails', async () => {
      const ride = await rideInProgress();

      // Let the status UPDATE, the event and the payment through; fail only on
      // the ledger insert, which is the last write in the settlement.
      db.failOn = (sql) =>
        /^INSERT INTO ledger_entries/i.test(sql) ? new Error('ledger write failed') : null;

      await expect(service.completeRide(ride.id, driverActor())).rejects.toThrow();

      const stored = db.rows('rides')[0]!;
      expect(stored['status']).toBe('IN_PROGRESS');
      expect(stored['final_fare_iqd']).toBeNull();
      expect(db.rows('payments')).toHaveLength(0);
      expect(db.rows('ledger_entries')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  describe('cancelRide', () => {
    it('a rider cancel produces CANCELLED_BY_RIDER', async () => {
      const ride = await createRide();
      expect((await service.cancelRide(ride.id, riderActor())).status).toBe(
        'CANCELLED_BY_RIDER',
      );
    });

    it('a driver cancel produces CANCELLED_BY_DRIVER', async () => {
      const ride = await offeredRide();
      await service.acceptRide(ride.id, DRIVER_A);
      expect((await service.cancelRide(ride.id, driverActor())).status).toBe(
        'CANCELLED_BY_DRIVER',
      );
    });

    // A rider must not be able to cause a CANCELLED_BY_DRIVER and skew the
    // driver's cancellation rate.
    it('derives the target state from the caller role, not from input', async () => {
      const ride = await offeredRide();
      await service.acceptRide(ride.id, DRIVER_A);
      const cancelled = await service.cancelRide(ride.id, riderActor());
      expect(cancelled.status).toBe('CANCELLED_BY_RIDER');
    });

    it('an admin aborting a running trip produces CANCELLED_IN_TRIP', async () => {
      const ride = await rideInProgress();
      expect((await service.cancelRide(ride.id, adminActor())).status).toBe(
        'CANCELLED_IN_TRIP',
      );
    });

    it('a driver cannot cancel a trip already under way', async () => {
      const ride = await rideInProgress();
      await expect(service.cancelRide(ride.id, driverActor())).rejects.toThrow(
        InvalidRideTransitionError,
      );
    });

    it('releases the claim and frees the driver', async () => {
      const ride = await offeredRide();
      await service.acceptRide(ride.id, DRIVER_A);
      await service.cancelRide(ride.id, driverActor(), 'rider not at pickup');

      expect(await claims.currentHolder(ride.id)).toBeNull();
      expect(db.rows('drivers').find((d) => d['user_id'] === DRIVER_A)!['availability']).toBe(
        'ONLINE',
      );
    });

    it('records the reason', async () => {
      const ride = await createRide();
      const cancelled = await service.cancelRide(ride.id, riderActor(), 'changed my mind');
      expect(cancelled.cancellationReason).toBe('changed my mind');
    });

    it('refuses to cancel a completed ride', async () => {
      const ride = await rideInProgress();
      await service.completeRide(ride.id, driverActor());
      await expect(service.cancelRide(ride.id, riderActor())).rejects.toThrow(
        InvalidRideTransitionError,
      );
    });

    it('another rider cannot cancel this rider ride', async () => {
      const ride = await createRide();
      await expect(service.cancelRide(ride.id, riderActor(RIDER_B))).rejects.toThrow(
        RideActorNotPermittedError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  describe('audit trail', () => {
    // CLAUDE.md §4 - every transition writes exactly one ride_events row.
    it('records one event per transition, in order', async () => {
      const ride = await rideInProgress();
      await service.completeRide(ride.id, driverActor());

      const events = db.rows('ride_events').filter((e) => e['ride_id'] === ride.id);
      expect(events.map((e) => e['to_state'])).toEqual([
        'REQUESTED',
        'OFFERED',
        'ACCEPTED',
        'DRIVER_ARRIVED',
        'IN_PROGRESS',
        'COMPLETED',
      ]);
    });

    it('records who did it', async () => {
      const ride = await offeredRide();
      await service.acceptRide(ride.id, DRIVER_A);

      const accepted = db.rows('ride_events').find((e) => e['to_state'] === 'ACCEPTED')!;
      expect(accepted['actor_type']).toBe('DRIVER');
      expect(accepted['actor_id']).toBe(DRIVER_A);
    });

    it('writes no event for a rejected transition', async () => {
      const ride = await createRide();
      const before = db.rows('ride_events').length;

      await expect(service.startRide(ride.id, driverActor())).rejects.toThrow();

      expect(db.rows('ride_events')).toHaveLength(before);
    });
  });
});
