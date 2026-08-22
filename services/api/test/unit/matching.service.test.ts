import { beforeEach, describe, expect, it } from 'vitest';

import { FakeClock } from '../../src/common/clock.js';
import { FareCalculator } from '../../src/fare/fare-calculator.js';
import { LedgerService } from '../../src/ledger/ledger.service.js';
import { DriverPresenceService } from '../../src/matching/driver-presence.service.js';
import { MatchingService } from '../../src/matching/matching.service.js';
import { RideClaimService } from '../../src/matching/ride-claim.service.js';
import { PlatformConfigService } from '../../src/platform-config/platform-config.service.js';
import { InMemoryRedis } from '../../src/redis/in-memory-redis.js';
import { RideStateMachine } from '../../src/rides/ride-state-machine.js';
import { RideRepository } from '../../src/rides/ride.repository.js';
import { RideService } from '../../src/rides/ride.service.js';
import { FakeDatabase } from '../fakes/fake-database.js';

const RIDER = 'aaaa0000-0000-4000-8000-000000000001';
const NEAR = 'bbbb0000-0000-4000-8000-000000000001';
const MID = 'bbbb0000-0000-4000-8000-000000000002';
const FAR = 'bbbb0000-0000-4000-8000-000000000003';

const TAHRIR = { lat: 33.3061, lng: 44.4213 };
const KARRADA = { lat: 33.2989, lng: 44.4361 };   // ~1.6 km from Tahrir
const ADHAMIYA = { lat: 33.3706, lng: 44.3631 };  // ~8.6 km from Tahrir
const BASRA = { lat: 30.5085, lng: 47.7804 };     // ~500 km - well out of range

const CONFIG = {
  commission_bps: 0,
  fare_base_iqd: 2_000,
  fare_per_km_iqd: 500,
  fare_per_minute_iqd: 50,
  fare_minimum_iqd: 3_000,
  fare_rounding_iqd: 250,
  offer_timeout_seconds: 15,
  search_radius_meters: 5_000,
};

describe('MatchingService', () => {
  let clock: FakeClock;
  let db: FakeDatabase;
  let redis: InMemoryRedis;
  let presence: DriverPresenceService;
  let rideService: RideService;
  let matching: MatchingService;
  let config: PlatformConfigService;

  beforeEach(() => {
    clock = new FakeClock();
    db = new FakeDatabase();
    db.seedConfig(CONFIG);
    redis = new InMemoryRedis(clock);

    presence = new DriverPresenceService(redis, clock, 60);
    config = new PlatformConfigService(clock, 30_000);
    const repository = new RideRepository();

    rideService = new RideService(
      db,
      repository,
      new RideStateMachine(),
      new RideClaimService(redis, 30_000),
      new LedgerService(),
      new FareCalculator(),
      config,
      clock,
    );

    matching = new MatchingService(
      db,
      repository,
      rideService,
      presence,
      config,
      redis,
      clock,
      8,
    );
  });

  async function onlineDriver(id: string, position: { lat: number; lng: number }) {
    db.seedDriver(id, 'ONLINE');
    await presence.goOnline(id, { ...position, recordedAt: clock.now() });
  }

  async function requestRide() {
    return rideService.createRide({ riderId: RIDER, pickup: TAHRIR, dropoff: KARRADA });
  }

  // -------------------------------------------------------------------------

  describe('dispatch', () => {
    it('offers to the nearest eligible driver', async () => {
      await onlineDriver(FAR, ADHAMIYA);
      await onlineDriver(NEAR, KARRADA);
      const ride = await requestRide();

      const result = await matching.dispatch(ride.id);

      expect(result.outcome).toBe('OFFERED');
      expect(result.driverId).toBe(NEAR);
      expect(db.rows('rides')[0]!['status']).toBe('OFFERED');
    });

    it('records a PENDING offer row with a deadline', async () => {
      await onlineDriver(NEAR, KARRADA);
      const ride = await requestRide();

      await matching.dispatch(ride.id);

      const offer = db.rows('ride_offers')[0]!;
      expect(offer['driver_id']).toBe(NEAR);
      expect(offer['status']).toBe('PENDING');
      expect((offer['expires_at'] as Date).getTime()).toBe(
        clock.nowMs() + CONFIG.offer_timeout_seconds * 1_000,
      );
    });

    it('concludes NO_DRIVERS_FOUND when nobody is online', async () => {
      const ride = await requestRide();

      const result = await matching.dispatch(ride.id);

      expect(result.outcome).toBe('NO_DRIVERS_FOUND');
      expect(db.rows('rides')[0]!['status']).toBe('NO_DRIVERS_FOUND');
    });

    it('ignores drivers outside the search radius', async () => {
      await onlineDriver(FAR, BASRA);
      const ride = await requestRide();

      expect((await matching.dispatch(ride.id)).outcome).toBe('NO_DRIVERS_FOUND');
    });

    // Durable eligibility lives in Postgres precisely so a Redis flush cannot
    // make a suspended driver matchable again.
    it('never offers to a suspended driver', async () => {
      await onlineDriver(NEAR, KARRADA);
      db.rows('drivers').find((d) => d['user_id'] === NEAR)!['is_suspended'] = true;
      const ride = await requestRide();

      expect((await matching.dispatch(ride.id)).outcome).toBe('NO_DRIVERS_FOUND');
    });

    it('never offers to a driver already on a trip', async () => {
      await onlineDriver(NEAR, KARRADA);
      db.rows('drivers').find((d) => d['user_id'] === NEAR)!['availability'] = 'ON_TRIP';
      const ride = await requestRide();

      expect((await matching.dispatch(ride.id)).outcome).toBe('NO_DRIVERS_FOUND');
    });

    it('skips an ineligible near driver in favour of an eligible far one', async () => {
      await onlineDriver(NEAR, KARRADA);
      await onlineDriver(MID, ADHAMIYA);
      db.rows('drivers').find((d) => d['user_id'] === NEAR)!['is_suspended'] = true;
      db.seedConfig({ ...CONFIG, search_radius_meters: 20_000 });
      config.invalidate();

      const ride = await requestRide();
      const result = await matching.dispatch(ride.id);

      expect(result.outcome).toBe('OFFERED');
      expect(result.driverId).toBe(MID);
    });

    it('refuses to dispatch a ride that is not REQUESTED', async () => {
      await onlineDriver(NEAR, KARRADA);
      const ride = await requestRide();
      await matching.dispatch(ride.id);

      // Already OFFERED - a second worker must not re-offer it.
      expect((await matching.dispatch(ride.id)).outcome).toBe('NOT_DISPATCHABLE');
    });

    it('is a no-op for a ride that does not exist', async () => {
      expect(
        (await matching.dispatch('11111111-1111-4111-8111-111111111111')).outcome,
      ).toBe('NOT_DISPATCHABLE');
    });
  });

  // -------------------------------------------------------------------------
  // ACCEPTANCE_CHECKLIST.md check 1 step 4, and the "driver declines" e2e path.
  // -------------------------------------------------------------------------

  describe('handleOfferOutcome', () => {
    it('moves to the next candidate when a driver declines', async () => {
      await onlineDriver(NEAR, KARRADA);
      await onlineDriver(MID, ADHAMIYA);
      db.seedConfig({ ...CONFIG, search_radius_meters: 20_000 });
      config.invalidate();

      const ride = await requestRide();
      expect((await matching.dispatch(ride.id)).driverId).toBe(NEAR);

      const next = await matching.handleOfferOutcome(ride.id, 'declined');

      expect(next.outcome).toBe('OFFERED');
      expect(next.driverId).toBe(MID);
      expect(db.rows('rides')[0]!['status']).toBe('OFFERED');
    });

    it('never re-offers the same ride to a driver who already saw it', async () => {
      await onlineDriver(NEAR, KARRADA);
      const ride = await requestRide();
      await matching.dispatch(ride.id);

      // Only one driver exists, and they declined - so the pool is exhausted.
      const next = await matching.handleOfferOutcome(ride.id, 'declined');

      expect(next.outcome).toBe('NO_DRIVERS_FOUND');
      expect(db.rows('rides')[0]!['status']).toBe('NO_DRIVERS_FOUND');
    });

    it('records the full EXPIRED -> REQUESTED -> OFFERED audit trail', async () => {
      await onlineDriver(NEAR, KARRADA);
      await onlineDriver(MID, ADHAMIYA);
      db.seedConfig({ ...CONFIG, search_radius_meters: 20_000 });
      config.invalidate();

      const ride = await requestRide();
      await matching.dispatch(ride.id);
      await matching.handleOfferOutcome(ride.id, 'timeout');

      expect(db.rows('ride_events').map((e) => e['to_state'])).toEqual([
        'REQUESTED',
        'OFFERED',
        'EXPIRED',
        'REQUESTED',
        'OFFERED',
      ]);
    });

    // CLAUDE.md §4 lists EXPIRED as a state, but a ride left sitting in it is
    // invisible to matching and the rider waits forever. See DECISIONS.md D-009.
    it('never leaves the ride resting in EXPIRED', async () => {
      await onlineDriver(NEAR, KARRADA);
      const ride = await requestRide();
      await matching.dispatch(ride.id);
      await matching.handleOfferOutcome(ride.id, 'timeout');

      expect(db.rows('rides')[0]!['status']).not.toBe('EXPIRED');
    });

    it('marks the offer row TIMED_OUT', async () => {
      await onlineDriver(NEAR, KARRADA);
      const ride = await requestRide();
      await matching.dispatch(ride.id);
      await matching.handleOfferOutcome(ride.id, 'timeout');

      expect(db.rows('ride_offers')[0]!['status']).toBe('TIMED_OUT');
    });

    it('is a no-op for a ride that is not currently OFFERED', async () => {
      const ride = await requestRide();
      expect((await matching.handleOfferOutcome(ride.id, 'timeout')).outcome).toBe(
        'NOT_DISPATCHABLE',
      );
    });

    it('walks a chain of declines down to exhaustion', async () => {
      await onlineDriver(NEAR, KARRADA);
      await onlineDriver(MID, ADHAMIYA);
      db.seedConfig({ ...CONFIG, search_radius_meters: 20_000 });
      config.invalidate();

      const ride = await requestRide();
      await matching.dispatch(ride.id);
      await matching.handleOfferOutcome(ride.id, 'declined');
      const final = await matching.handleOfferOutcome(ride.id, 'declined');

      expect(final.outcome).toBe('NO_DRIVERS_FOUND');
      expect(db.rows('ride_offers')).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------

  describe('the outstanding-offer lookup', () => {
    it('reports the driver current offer, and clears it on expiry', async () => {
      await onlineDriver(NEAR, KARRADA);
      const ride = await requestRide();
      await matching.dispatch(ride.id);

      expect(await matching.currentOfferFor(NEAR)).toBe(ride.id);

      await matching.handleOfferOutcome(ride.id, 'timeout');
      expect(await matching.currentOfferFor(NEAR)).toBeNull();
    });

    it('is null for a driver with no offer', async () => {
      expect(await matching.currentOfferFor(NEAR)).toBeNull();
    });
  });

  describe('sweepExpiredOffers', () => {
    it('expires an offer whose deadline passed', async () => {
      await onlineDriver(NEAR, KARRADA);
      const ride = await requestRide();
      await matching.dispatch(ride.id);

      clock.advanceSeconds(CONFIG.offer_timeout_seconds + 1);

      expect(await matching.sweepExpiredOffers()).toEqual([ride.id]);
      expect(db.rows('rides')[0]!['status']).toBe('NO_DRIVERS_FOUND');
    });

    // A driver who force-quits never declines and never accepts. Without the
    // sweeper the ride sits in OFFERED until a human notices.
    it('leaves an offer inside its deadline alone', async () => {
      await onlineDriver(NEAR, KARRADA);
      const ride = await requestRide();
      await matching.dispatch(ride.id);

      clock.advanceSeconds(CONFIG.offer_timeout_seconds - 1);

      expect(await matching.sweepExpiredOffers()).toEqual([]);
      expect(db.rows('rides')[0]!['status']).toBe('OFFERED');
    });

    it('returns nothing when there are no offers at all', async () => {
      expect(await matching.sweepExpiredOffers()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // The full happy path, matching through settlement.
  // -------------------------------------------------------------------------

  describe('end to end', () => {
    it('matches, accepts, drives and settles', async () => {
      await onlineDriver(NEAR, KARRADA);
      const ride = await requestRide();

      const dispatched = await matching.dispatch(ride.id);
      expect(dispatched.driverId).toBe(NEAR);

      await rideService.acceptRide(ride.id, NEAR);
      await rideService.markArrived(ride.id, { type: 'DRIVER', id: NEAR });
      await rideService.startRide(ride.id, { type: 'DRIVER', id: NEAR });
      const { ride: completed, ledgerTransactionId } = await rideService.completeRide(
        ride.id,
        { type: 'DRIVER', id: NEAR },
      );

      expect(completed.status).toBe('COMPLETED');
      expect(db.ledgerNet(ledgerTransactionId)).toBe(0);
      expect(db.walletBalance(NEAR)).toBe(completed.finalFareIqd);
      expect(db.rows('ride_offers')[0]!['status']).toBe('ACCEPTED');
    });

    it('a losing driver in a race still gets no ride', async () => {
      await onlineDriver(NEAR, KARRADA);
      await onlineDriver(MID, ADHAMIYA);
      const ride = await requestRide();
      await matching.dispatch(ride.id);

      const results = await Promise.allSettled([
        rideService.acceptRide(ride.id, NEAR),
        rideService.acceptRide(ride.id, MID),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });
  });
});

/**
 * Branches that the happy-path tests above do not reach.
 *
 * These are not coverage theatre: each one is a real failure mode. A logger
 * that throws, a sweep that hits a wedged ride, and an empty candidate list are
 * all things that happen in production at 3am.
 */
describe('MatchingService - failure and edge branches', () => {
  let clock: FakeClock;
  let db: FakeDatabase;
  let redis: InMemoryRedis;
  let presence: DriverPresenceService;
  let rideService: RideService;
  let matching: MatchingService;
  let logged: Array<{ level: string; payload: Record<string, unknown> }>;

  beforeEach(() => {
    clock = new FakeClock();
    db = new FakeDatabase();
    db.seedConfig(CONFIG);
    redis = new InMemoryRedis(clock);

    presence = new DriverPresenceService(redis, clock, 60);
    const config = new PlatformConfigService(clock, 30_000);
    const repository = new RideRepository();

    rideService = new RideService(
      db,
      repository,
      new RideStateMachine(),
      new RideClaimService(redis, 30_000),
      new LedgerService(),
      new FareCalculator(),
      config,
      clock,
    );

    logged = [];
    const record = (level: string) => (payload: Record<string, unknown>) => {
      logged.push({ level, payload });
    };

    matching = new MatchingService(
      db,
      repository,
      rideService,
      presence,
      config,
      redis,
      clock,
      8,
      { info: record('info'), warn: record('warn') } as never,
    );
  });

  async function requestRide() {
    return rideService.createRide({ riderId: RIDER, pickup: TAHRIR, dropoff: KARRADA });
  }

  it('logs an offer without leaking rider or driver identity', async () => {
    db.seedDriver(NEAR, 'ONLINE');
    await presence.goOnline(NEAR, { ...KARRADA, recordedAt: clock.now() });
    const ride = await requestRide();

    await matching.dispatch(ride.id);

    const offered = logged.find((l) => l.payload['event'] === 'ride.offered');
    expect(offered).toBeDefined();
    // CLAUDE.md §9 - no phone numbers, no names, no exact coordinates.
    const serialised = JSON.stringify(offered!.payload);
    expect(serialised).not.toContain('+964');
    expect(serialised).not.toContain(String(KARRADA.lat));
  });

  it('logs when no eligible driver is available', async () => {
    const ride = await requestRide();
    await matching.dispatch(ride.id);

    expect(logged.some((l) => l.payload['event'] === 'ride.no_drivers_found')).toBe(true);
  });

  // One wedged ride must not stop the sweep for every other ride - otherwise a
  // single bad row freezes matching for the whole city.
  it('continues sweeping after one ride fails, and logs the failure', async () => {
    db.seedDriver(NEAR, 'ONLINE');
    await presence.goOnline(NEAR, { ...KARRADA, recordedAt: clock.now() });
    const ride = await requestRide();
    await matching.dispatch(ride.id);

    clock.advanceSeconds(CONFIG.offer_timeout_seconds + 1);

    // Make the expiry transition fail for this ride.
    db.failOn = (sql) =>
      /^UPDATE rides SET/i.test(sql) ? new Error('deadlock detected') : null;

    const swept = await matching.sweepExpiredOffers();

    expect(swept).toEqual([]);
    expect(logged.some((l) => l.payload['event'] === 'offer.sweep_failed')).toBe(true);
  });

  it('clears the offeree outstanding-offer key when the offer expires', async () => {
    db.seedDriver(NEAR, 'ONLINE');
    db.seedDriver(MID, 'ONLINE');
    await presence.goOnline(NEAR, { ...KARRADA, recordedAt: clock.now() });
    await presence.goOnline(MID, { ...ADHAMIYA, recordedAt: clock.now() });
    db.seedConfig({ ...CONFIG, search_radius_meters: 20_000 });

    const ride = await requestRide();
    await matching.dispatch(ride.id);
    expect(await matching.currentOfferFor(NEAR)).toBe(ride.id);

    await matching.handleOfferOutcome(ride.id, 'timeout');

    // NEAR's key is gone even though the ride went on to MID rather than
    // ending in NO_DRIVERS_FOUND.
    expect(await matching.currentOfferFor(NEAR)).toBeNull();
    expect(await matching.currentOfferFor(MID)).toBe(ride.id);
  });

  it('handles an empty candidate list without querying the database', async () => {
    const ride = await requestRide();
    const before = db.statements.length;

    await matching.dispatch(ride.id);

    // No eligibility query is issued when Redis returned nobody at all.
    expect(
      db.statements.slice(before).some((s) => /SELECT user_id FROM drivers/i.test(s)),
    ).toBe(false);
  });
});
