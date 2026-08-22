import { beforeEach, describe, expect, it } from 'vitest';

import { RedisKeys, type RedisPort } from './redis.port.js';

/**
 * ONE suite, run against BOTH implementations.
 *
 * The whole value of testing matching against an in-memory Redis rests on the
 * fake behaving like the real thing. Asserting that in prose is worthless; this
 * file asserts it executably. `in-memory-redis.test.ts` runs it against the
 * fake on every `pnpm test`; `test/integration/ioredis-conformance.test.ts`
 * runs the identical assertions against a real Redis whenever TEST_REDIS_URL is
 * set, and CI sets it.
 *
 * If the two ever diverge, the unit tests that depend on the fake are no longer
 * evidence about production - so a divergence has to fail the build, loudly.
 */

export interface ConformanceHarness {
  /** A fresh, empty RedisPort. */
  redis: RedisPort;
  /**
   * Move time forward by `ms` in whatever way this implementation requires:
   * the fake advances an injected clock, the real one actually waits.
   */
  advance(ms: number): Promise<void>;
  cleanup(): Promise<void>;
}

const RIDE_ID = '11111111-1111-4111-8111-111111111111';
const DRIVER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DRIVER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DRIVER_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// Real Baghdad coordinates, so the distances in these tests are realistic.
const TAHRIR_SQUARE = { lat: 33.3061, lng: 44.4213 };
const KARRADA = { lat: 33.2989, lng: 44.4361 };
const ADHAMIYA = { lat: 33.3706, lng: 44.3631 };

export function runRedisConformance(
  implementationName: string,
  createHarness: () => Promise<ConformanceHarness>,
): void {
  describe(`RedisPort conformance: ${implementationName}`, () => {
    let harness: ConformanceHarness;
    let redis: RedisPort;

    beforeEach(async () => {
      harness = await createHarness();
      redis = harness.redis;
      return async () => {
        await harness.cleanup();
      };
    });

    // -----------------------------------------------------------------------
    // Claims - CLAUDE.md §5.1. This is the section that matters most.
    // -----------------------------------------------------------------------

    describe('setIfAbsent (the atomic claim)', () => {
      it('grants the key to the first caller only', async () => {
        const key = RedisKeys.rideClaim(RIDE_ID);
        expect(await redis.setIfAbsent(key, DRIVER_A, 30_000)).toBe(true);
        expect(await redis.setIfAbsent(key, DRIVER_B, 30_000)).toBe(false);
        expect(await redis.get(key)).toBe(DRIVER_A);
      });

      it('does not let a losing caller overwrite the winner', async () => {
        const key = RedisKeys.rideClaim(RIDE_ID);
        await redis.setIfAbsent(key, DRIVER_A, 30_000);
        await redis.setIfAbsent(key, DRIVER_B, 30_000);
        await redis.setIfAbsent(key, DRIVER_C, 30_000);
        expect(await redis.get(key)).toBe(DRIVER_A);
      });

      // The scenario from ACCEPTANCE_CHECKLIST.md check 4: three drivers tap
      // "accept" at the same instant. Exactly one may win.
      it('yields exactly one winner when many callers race', async () => {
        const key = RedisKeys.rideClaim(RIDE_ID);
        const contenders = Array.from({ length: 50 }, (_, i) => `driver-${i}`);

        const results = await Promise.all(
          contenders.map((driverId) => redis.setIfAbsent(key, driverId, 30_000)),
        );

        expect(results.filter(Boolean)).toHaveLength(1);

        const winnerIndex = results.indexOf(true);
        expect(await redis.get(key)).toBe(contenders[winnerIndex]);
      });

      it('lets a new claimant in once the TTL lapses', async () => {
        const key = RedisKeys.rideClaim(RIDE_ID);
        expect(await redis.setIfAbsent(key, DRIVER_A, 100)).toBe(true);

        await harness.advance(150);

        expect(await redis.get(key)).toBeNull();
        expect(await redis.setIfAbsent(key, DRIVER_B, 30_000)).toBe(true);
        expect(await redis.get(key)).toBe(DRIVER_B);
      });

      it('rejects a non-positive or fractional ttl instead of setting no expiry', async () => {
        const key = RedisKeys.rideClaim(RIDE_ID);
        await expect(redis.setIfAbsent(key, DRIVER_A, 0)).rejects.toThrow();
        await expect(redis.setIfAbsent(key, DRIVER_A, -1)).rejects.toThrow();
        await expect(redis.setIfAbsent(key, DRIVER_A, 1.5)).rejects.toThrow();
        // A claim with no TTL would wedge the ride forever if the holder died.
        expect(await redis.get(key)).toBeNull();
      });
    });

    describe('compareAndDelete (safe claim release)', () => {
      it('releases only when the caller still holds the claim', async () => {
        const key = RedisKeys.rideClaim(RIDE_ID);
        await redis.setIfAbsent(key, DRIVER_A, 30_000);

        expect(await redis.compareAndDelete(key, DRIVER_B)).toBe(false);
        expect(await redis.get(key)).toBe(DRIVER_A);

        expect(await redis.compareAndDelete(key, DRIVER_A)).toBe(true);
        expect(await redis.get(key)).toBeNull();
      });

      // The reason release is compare-and-delete rather than DEL: driver A's
      // claim expires, driver B legitimately claims the ride, and only then
      // does A's release arrive. A plain DEL would drop B's live claim.
      it('does not delete a claim that a different driver has since acquired', async () => {
        const key = RedisKeys.rideClaim(RIDE_ID);
        await redis.setIfAbsent(key, DRIVER_A, 100);
        await harness.advance(150);
        await redis.setIfAbsent(key, DRIVER_B, 30_000);

        expect(await redis.compareAndDelete(key, DRIVER_A)).toBe(false);
        expect(await redis.get(key)).toBe(DRIVER_B);
      });

      it('is false for a key that does not exist', async () => {
        expect(await redis.compareAndDelete('nope', DRIVER_A)).toBe(false);
      });
    });

    // Regression cover for a real fake-vs-real divergence: DEL removes a key of
    // ANY type, not just a string. Taking a driver offline deletes their
    // last-known-location HASH, and a DEL that only handled strings left that
    // hash readable after they went offline.
    describe('del across every key type', () => {
      it('deletes a string key', async () => {
        await redis.setIfAbsent('k', 'v', 30_000);
        expect(await redis.del('k')).toBe(1);
        expect(await redis.get('k')).toBeNull();
      });

      it('deletes a hash key', async () => {
        const key = RedisKeys.driverLocation(DRIVER_A);
        await redis.hSet(key, 'lat', '33.3');
        expect(await redis.del(key)).toBe(1);
        expect(await redis.hGetAll(key)).toEqual({});
      });

      it('deletes a list key', async () => {
        await redis.rPush('list', 'a', 'b');
        expect(await redis.del('list')).toBe(1);
        expect(await redis.lLen('list')).toBe(0);
      });

      it('deletes a sorted set key', async () => {
        await redis.zAdd('zset', DRIVER_A, 1);
        expect(await redis.del('zset')).toBe(1);
        expect(await redis.zScore('zset', DRIVER_A)).toBeNull();
      });

      it('deletes a geo key', async () => {
        await redis.geoAdd('geo', DRIVER_A, TAHRIR_SQUARE);
        expect(await redis.del('geo')).toBe(1);
        expect(await redis.geoPosition('geo', DRIVER_A)).toBeNull();
      });

      it('reports 0 for a key that does not exist', async () => {
        expect(await redis.del('never-existed')).toBe(0);
      });
    });

    describe('pttl', () => {
      it('reports -2 for a missing key and a positive remainder for a live one', async () => {
        expect(await redis.pttl('missing')).toBe(-2);
        await redis.setIfAbsent('k', 'v', 30_000);
        const remaining = await redis.pttl('k');
        expect(remaining).toBeGreaterThan(0);
        expect(remaining).toBeLessThanOrEqual(30_000);
      });
    });

    // -----------------------------------------------------------------------
    // Geo - CLAUDE.md §3.1
    // -----------------------------------------------------------------------

    describe('geo', () => {
      it('finds members within the radius and orders them nearest first', async () => {
        await redis.geoAdd(RedisKeys.driversOnline, DRIVER_A, KARRADA);
        await redis.geoAdd(RedisKeys.driversOnline, DRIVER_B, ADHAMIYA);

        const hits = await redis.geoSearch(RedisKeys.driversOnline, TAHRIR_SQUARE, 20_000, 10);

        expect(hits.map((h) => h.member)).toEqual([DRIVER_A, DRIVER_B]);
        expect(hits[0]!.distanceM).toBeLessThan(hits[1]!.distanceM);
      });

      it('excludes members outside the radius', async () => {
        await redis.geoAdd(RedisKeys.driversOnline, DRIVER_A, KARRADA);   // ~1.7 km
        await redis.geoAdd(RedisKeys.driversOnline, DRIVER_B, ADHAMIYA);  // ~9 km

        const hits = await redis.geoSearch(RedisKeys.driversOnline, TAHRIR_SQUARE, 3_000, 10);

        expect(hits.map((h) => h.member)).toEqual([DRIVER_A]);
      });

      it('honours the count limit', async () => {
        await redis.geoAdd(RedisKeys.driversOnline, DRIVER_A, KARRADA);
        await redis.geoAdd(RedisKeys.driversOnline, DRIVER_B, ADHAMIYA);
        await redis.geoAdd(RedisKeys.driversOnline, DRIVER_C, TAHRIR_SQUARE);

        const hits = await redis.geoSearch(RedisKeys.driversOnline, TAHRIR_SQUARE, 50_000, 2);
        expect(hits).toHaveLength(2);
        expect(hits[0]!.member).toBe(DRIVER_C);
      });

      it('returns distances that match the real-world separation', async () => {
        await redis.geoAdd(RedisKeys.driversOnline, DRIVER_A, KARRADA);
        const [hit] = await redis.geoSearch(RedisKeys.driversOnline, TAHRIR_SQUARE, 20_000, 1);

        // Tahrir Square to Karrada is roughly 1.6 km. The tolerance is wide
        // because Redis geohashing and haversine disagree by a few metres; it
        // is narrow enough to catch a swapped lat/lng, which would be km out.
        expect(hit!.distanceM).toBeGreaterThan(1_400);
        expect(hit!.distanceM).toBeLessThan(1_900);
      });

      it('round-trips a position without swapping latitude and longitude', async () => {
        await redis.geoAdd(RedisKeys.driversOnline, DRIVER_A, TAHRIR_SQUARE);
        const position = await redis.geoPosition(RedisKeys.driversOnline, DRIVER_A);

        expect(position!.lat).toBeCloseTo(TAHRIR_SQUARE.lat, 3);
        expect(position!.lng).toBeCloseTo(TAHRIR_SQUARE.lng, 3);
      });

      it('updates a member in place rather than duplicating it', async () => {
        await redis.geoAdd(RedisKeys.driversOnline, DRIVER_A, ADHAMIYA);
        await redis.geoAdd(RedisKeys.driversOnline, DRIVER_A, KARRADA);

        const hits = await redis.geoSearch(RedisKeys.driversOnline, TAHRIR_SQUARE, 50_000, 10);
        expect(hits.filter((h) => h.member === DRIVER_A)).toHaveLength(1);
        expect(hits[0]!.distanceM).toBeLessThan(3_000);
      });

      it('removes members, so an offline driver stops being matchable', async () => {
        await redis.geoAdd(RedisKeys.driversOnline, DRIVER_A, KARRADA);
        expect(await redis.geoRemove(RedisKeys.driversOnline, DRIVER_A)).toBe(1);
        expect(await redis.geoSearch(RedisKeys.driversOnline, TAHRIR_SQUARE, 50_000, 10)).toEqual([]);
        expect(await redis.geoRemove(RedisKeys.driversOnline, DRIVER_A)).toBe(0);
      });

      it('returns an empty list for an unknown key rather than throwing', async () => {
        expect(await redis.geoSearch('drivers:nowhere', TAHRIR_SQUARE, 5_000, 10)).toEqual([]);
        expect(await redis.geoPosition('drivers:nowhere', DRIVER_A)).toBeNull();
      });
    });

    // -----------------------------------------------------------------------
    // Sorted sets (heartbeat / staleness sweep)
    // -----------------------------------------------------------------------

    describe('sorted sets', () => {
      it('stores and reads back a score', async () => {
        await redis.zAdd(RedisKeys.driversHeartbeat, DRIVER_A, 1_000);
        expect(await redis.zScore(RedisKeys.driversHeartbeat, DRIVER_A)).toBe(1_000);
        expect(await redis.zScore(RedisKeys.driversHeartbeat, DRIVER_B)).toBeNull();
      });

      it('overwrites the score on re-add, which is what a heartbeat does', async () => {
        await redis.zAdd(RedisKeys.driversHeartbeat, DRIVER_A, 1_000);
        await redis.zAdd(RedisKeys.driversHeartbeat, DRIVER_A, 2_000);
        expect(await redis.zScore(RedisKeys.driversHeartbeat, DRIVER_A)).toBe(2_000);
      });

      it('ranges by score, inclusive at both ends, ordered by score', async () => {
        await redis.zAdd(RedisKeys.driversHeartbeat, DRIVER_A, 1_000);
        await redis.zAdd(RedisKeys.driversHeartbeat, DRIVER_B, 2_000);
        await redis.zAdd(RedisKeys.driversHeartbeat, DRIVER_C, 3_000);

        expect(await redis.zRangeByScore(RedisKeys.driversHeartbeat, 0, 2_000))
          .toEqual([DRIVER_A, DRIVER_B]);
        expect(await redis.zRangeByScore(RedisKeys.driversHeartbeat, 2_000, 3_000))
          .toEqual([DRIVER_B, DRIVER_C]);
        expect(await redis.zRangeByScore(RedisKeys.driversHeartbeat, 0, 5_000, 1))
          .toEqual([DRIVER_A]);
      });

      it('removes members', async () => {
        await redis.zAdd(RedisKeys.driversHeartbeat, DRIVER_A, 1_000);
        expect(await redis.zRem(RedisKeys.driversHeartbeat, DRIVER_A)).toBe(1);
        expect(await redis.zRem(RedisKeys.driversHeartbeat, DRIVER_A)).toBe(0);
      });

      it('returns an empty range for an unknown key', async () => {
        expect(await redis.zRangeByScore('nope', 0, 100)).toEqual([]);
      });
    });

    // -----------------------------------------------------------------------
    // Hashes
    // -----------------------------------------------------------------------

    describe('hashes', () => {
      it('sets, gets and deletes fields', async () => {
        const key = RedisKeys.driverLocation(DRIVER_A);
        await redis.hSet(key, 'lat', '33.3061');
        await redis.hSet(key, 'lng', '44.4213');

        expect(await redis.hGet(key, 'lat')).toBe('33.3061');
        expect(await redis.hGetAll(key)).toEqual({ lat: '33.3061', lng: '44.4213' });

        expect(await redis.hDel(key, 'lat')).toBe(1);
        expect(await redis.hGet(key, 'lat')).toBeNull();
        expect(await redis.hDel(key, 'lat')).toBe(0);
      });

      it('returns an empty object for an unknown key', async () => {
        expect(await redis.hGetAll('nope')).toEqual({});
        expect(await redis.hGet('nope', 'field')).toBeNull();
      });
    });

    // -----------------------------------------------------------------------
    // Lists (the 30s location flush buffer)
    // -----------------------------------------------------------------------

    describe('lists', () => {
      it('pushes to the tail and pops from the head in FIFO order', async () => {
        await redis.rPush(RedisKeys.locationFlushBuffer, 'a', 'b', 'c');
        expect(await redis.lLen(RedisKeys.locationFlushBuffer)).toBe(3);
        expect(await redis.lPopCount(RedisKeys.locationFlushBuffer, 2)).toEqual(['a', 'b']);
        expect(await redis.lPopCount(RedisKeys.locationFlushBuffer, 2)).toEqual(['c']);
        expect(await redis.lPopCount(RedisKeys.locationFlushBuffer, 2)).toEqual([]);
      });

      it('pops atomically, so two overlapping flush workers never see the same sample', async () => {
        await redis.rPush(RedisKeys.locationFlushBuffer, ...Array.from({ length: 100 }, (_, i) => `s${i}`));

        const batches = await Promise.all([
          redis.lPopCount(RedisKeys.locationFlushBuffer, 40),
          redis.lPopCount(RedisKeys.locationFlushBuffer, 40),
          redis.lPopCount(RedisKeys.locationFlushBuffer, 40),
        ]);

        const all = batches.flat();
        expect(all).toHaveLength(100);
        expect(new Set(all).size).toBe(100);
      });

      it('reports zero length for an unknown key', async () => {
        expect(await redis.lLen('nope')).toBe(0);
      });
    });

    // -----------------------------------------------------------------------
    // Pub/sub
    // -----------------------------------------------------------------------

    describe('pub/sub', () => {
      it('delivers a message to a subscriber of that channel only', async () => {
        const riderMessages: string[] = [];
        const driverMessages: string[] = [];

        await redis.subscribe(RedisKeys.riderChannel('r1'), (m) => riderMessages.push(m));
        await redis.subscribe(RedisKeys.driverChannel('d1'), (m) => driverMessages.push(m));

        await redis.publish(RedisKeys.riderChannel('r1'), 'for-the-rider');
        await harness.advance(50);

        expect(riderMessages).toEqual(['for-the-rider']);
        expect(driverMessages).toEqual([]);
      });

      it('stops delivering after unsubscribe', async () => {
        const received: string[] = [];
        const unsubscribe = await redis.subscribe(RedisKeys.riderChannel('r1'), (m) =>
          received.push(m),
        );

        await redis.publish(RedisKeys.riderChannel('r1'), 'one');
        await harness.advance(50);
        await unsubscribe();
        await redis.publish(RedisKeys.riderChannel('r1'), 'two');
        await harness.advance(50);

        expect(received).toEqual(['one']);
      });

      it('delivers to every subscriber of the same channel', async () => {
        const a: string[] = [];
        const b: string[] = [];
        await redis.subscribe('shared', (m) => a.push(m));
        await redis.subscribe('shared', (m) => b.push(m));

        await redis.publish('shared', 'hello');
        await harness.advance(50);

        expect(a).toEqual(['hello']);
        expect(b).toEqual(['hello']);
      });
    });

    describe('ping', () => {
      it('answers true while the connection is usable', async () => {
        expect(await redis.ping()).toBe(true);
      });
    });
  });
}
