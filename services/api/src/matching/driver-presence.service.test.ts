import { beforeEach, describe, expect, it } from 'vitest';

import { FakeClock } from '../common/clock.js';
import { InMemoryRedis } from '../redis/in-memory-redis.js';
import { RedisKeys } from '../redis/redis.port.js';
import { DriverPresenceService } from './driver-presence.service.js';

const DRIVER_A = 'aaaa0000-0000-4000-8000-000000000001';
const DRIVER_B = 'aaaa0000-0000-4000-8000-000000000002';
const DRIVER_C = 'aaaa0000-0000-4000-8000-000000000003';

const TAHRIR = { lat: 33.3061, lng: 44.4213 };
const KARRADA = { lat: 33.2989, lng: 44.4361 };
const ADHAMIYA = { lat: 33.3706, lng: 44.3631 };

const PRESENCE_TTL_SECONDS = 60;

describe('DriverPresenceService', () => {
  let clock: FakeClock;
  let redis: InMemoryRedis;
  let presence: DriverPresenceService;

  beforeEach(() => {
    clock = new FakeClock();
    redis = new InMemoryRedis(clock);
    presence = new DriverPresenceService(redis, clock, PRESENCE_TTL_SECONDS);
  });

  const at = (position: { lat: number; lng: number }, extra = {}) => ({
    ...position,
    recordedAt: clock.now(),
    ...extra,
  });

  it('rejects a non-positive presence TTL', () => {
    expect(() => new DriverPresenceService(redis, clock, 0)).toThrow(/positive integer/);
  });

  describe('goOnline', () => {
    it('puts the driver on the map', async () => {
      await presence.goOnline(DRIVER_A, at(TAHRIR));

      expect(await presence.isOnline(DRIVER_A)).toBe(true);
      const nearby = await presence.findNearby(TAHRIR, 5_000, 10);
      expect(nearby.map((d) => d.driverId)).toEqual([DRIVER_A]);
    });

    it('stores the last known position', async () => {
      await presence.goOnline(DRIVER_A, at(TAHRIR, { headingDeg: 90, speedMps: 12 }));

      const position = await presence.lastKnownPosition(DRIVER_A);
      expect(position!.lat).toBeCloseTo(TAHRIR.lat, 4);
      expect(position!.lng).toBeCloseTo(TAHRIR.lng, 4);
      expect(position!.headingDeg).toBe(90);
      expect(position!.speedMps).toBe(12);
    });

    it('is null for a driver who was never online', async () => {
      expect(await presence.lastKnownPosition(DRIVER_A)).toBeNull();
      expect(await presence.isOnline(DRIVER_A)).toBe(false);
    });
  });

  // CLAUDE.md §3.1 - the rule this whole class exists to obey.
  describe('the request path never touches Postgres', () => {
    it('buffers positions in Redis for the batch job instead of writing through', async () => {
      await presence.goOnline(DRIVER_A, at(TAHRIR));
      await presence.recordPosition(DRIVER_A, at(KARRADA));

      expect(await presence.pendingFlushCount()).toBe(1);

      const drained = await presence.drainFlushBuffer(100);
      expect(drained).toHaveLength(1);
      expect(drained[0]!.driverId).toBe(DRIVER_A);
      expect(await presence.pendingFlushCount()).toBe(0);
    });

    it('drains in batches, so one flush cannot pull an unbounded set', async () => {
      await presence.goOnline(DRIVER_A, at(TAHRIR));
      for (let i = 0; i < 10; i++) await presence.recordPosition(DRIVER_A, at(TAHRIR));

      expect(await presence.drainFlushBuffer(4)).toHaveLength(4);
      expect(await presence.pendingFlushCount()).toBe(6);
    });

    it('drops a malformed buffer entry rather than wedging the flush job', async () => {
      await redis.rPush(RedisKeys.locationFlushBuffer, 'not json at all');
      await presence.goOnline(DRIVER_A, at(TAHRIR));
      await presence.recordPosition(DRIVER_A, at(KARRADA));

      const drained = await presence.drainFlushBuffer(100);
      expect(drained).toHaveLength(1);
    });
  });

  // CLAUDE.md §5.3 - "Buffer locations locally when offline and flush on
  // reconnect." Which means batches arrive containing stale samples.
  describe('recordBatch', () => {
    it('accepts a batch and buffers every sample', async () => {
      await presence.goOnline(DRIVER_A, at(TAHRIR));

      const t0 = clock.now();
      const samples = [
        { ...TAHRIR, recordedAt: new Date(t0.getTime() - 120_000) },
        { ...KARRADA, recordedAt: new Date(t0.getTime() - 60_000) },
        { ...ADHAMIYA, recordedAt: t0 },
      ];

      expect(await presence.recordBatch(DRIVER_A, samples)).toBe(3);
      expect(await presence.pendingFlushCount()).toBe(3);
    });

    // The bug this prevents: a reconnecting driver flushes a 20-minute buffer
    // and the rider watches the car jump backwards along the route.
    it('uses only the NEWEST sample as the live position', async () => {
      await presence.goOnline(DRIVER_A, at(ADHAMIYA));

      const t0 = clock.now();
      await presence.recordBatch(DRIVER_A, [
        // Deliberately out of order.
        { ...ADHAMIYA, recordedAt: new Date(t0.getTime() - 120_000) },
        { ...TAHRIR, recordedAt: t0 },
        { ...KARRADA, recordedAt: new Date(t0.getTime() - 60_000) },
      ]);

      const position = await presence.lastKnownPosition(DRIVER_A);
      expect(position!.lat).toBeCloseTo(TAHRIR.lat, 3);
      expect(position!.lng).toBeCloseTo(TAHRIR.lng, 3);
    });

    it('is a no-op for an empty batch', async () => {
      expect(await presence.recordBatch(DRIVER_A, [])).toBe(0);
      expect(await presence.pendingFlushCount()).toBe(0);
    });
  });

  describe('findNearby', () => {
    it('returns candidates nearest first', async () => {
      await presence.goOnline(DRIVER_A, at(ADHAMIYA));
      await presence.goOnline(DRIVER_B, at(KARRADA));

      const nearby = await presence.findNearby(TAHRIR, 20_000, 10);
      expect(nearby.map((d) => d.driverId)).toEqual([DRIVER_B, DRIVER_A]);
      expect(nearby[0]!.distanceM).toBeLessThan(nearby[1]!.distanceM);
    });

    it('excludes drivers outside the radius', async () => {
      await presence.goOnline(DRIVER_A, at(KARRADA));
      await presence.goOnline(DRIVER_B, at(ADHAMIYA));

      expect((await presence.findNearby(TAHRIR, 3_000, 10)).map((d) => d.driverId)).toEqual([
        DRIVER_A,
      ]);
    });

    it('honours the limit', async () => {
      await presence.goOnline(DRIVER_A, at(TAHRIR));
      await presence.goOnline(DRIVER_B, at(KARRADA));
      await presence.goOnline(DRIVER_C, at(ADHAMIYA));

      expect(await presence.findNearby(TAHRIR, 50_000, 2)).toHaveLength(2);
    });

    it('returns whole-metre distances', async () => {
      await presence.goOnline(DRIVER_A, at(KARRADA));
      const [nearest] = await presence.findNearby(TAHRIR, 20_000, 1);
      expect(Number.isInteger(nearest!.distanceM)).toBe(true);
    });

    it('is empty when nobody is online', async () => {
      expect(await presence.findNearby(TAHRIR, 50_000, 10)).toEqual([]);
    });
  });

  describe('goOffline', () => {
    it('takes the driver off the map entirely', async () => {
      await presence.goOnline(DRIVER_A, at(TAHRIR));
      await presence.goOffline(DRIVER_A);

      expect(await presence.isOnline(DRIVER_A)).toBe(false);
      expect(await presence.findNearby(TAHRIR, 50_000, 10)).toEqual([]);
      expect(await presence.lastKnownPosition(DRIVER_A)).toBeNull();
    });

    it('is safe to call for a driver who was never online', async () => {
      await expect(presence.goOffline(DRIVER_A)).resolves.toBeUndefined();
    });
  });

  // Without this, a driver whose phone died stays on the map forever and keeps
  // winning offers nobody answers.
  describe('sweepStale', () => {
    it('evicts a driver who stopped reporting', async () => {
      await presence.goOnline(DRIVER_A, at(TAHRIR));

      clock.advanceSeconds(PRESENCE_TTL_SECONDS + 1);

      expect(await presence.sweepStale()).toEqual([DRIVER_A]);
      expect(await presence.isOnline(DRIVER_A)).toBe(false);
      expect(await presence.findNearby(TAHRIR, 50_000, 10)).toEqual([]);
    });

    it('keeps a driver who is still reporting', async () => {
      await presence.goOnline(DRIVER_A, at(TAHRIR));

      clock.advanceSeconds(PRESENCE_TTL_SECONDS - 5);
      await presence.recordPosition(DRIVER_A, at(TAHRIR));
      clock.advanceSeconds(10);

      expect(await presence.sweepStale()).toEqual([]);
      expect(await presence.isOnline(DRIVER_A)).toBe(true);
    });

    it('evicts only the stale ones', async () => {
      await presence.goOnline(DRIVER_A, at(TAHRIR));

      clock.advanceSeconds(PRESENCE_TTL_SECONDS + 1);
      await presence.goOnline(DRIVER_B, at(KARRADA));

      expect(await presence.sweepStale()).toEqual([DRIVER_A]);
      expect(await presence.isOnline(DRIVER_B)).toBe(true);
    });

    it('is empty when there is nothing stale', async () => {
      expect(await presence.sweepStale()).toEqual([]);
    });

    // Both structures must stay in step - a driver left in the geo set but not
    // the heartbeat set becomes permanently unsweepable.
    it('removes the driver from both the geo set and the heartbeat set', async () => {
      await presence.goOnline(DRIVER_A, at(TAHRIR));
      clock.advanceSeconds(PRESENCE_TTL_SECONDS + 1);
      await presence.sweepStale();

      expect(await redis.geoPosition(RedisKeys.driversOnline, DRIVER_A)).toBeNull();
      expect(await redis.zScore(RedisKeys.driversHeartbeat, DRIVER_A)).toBeNull();
    });
  });
});
