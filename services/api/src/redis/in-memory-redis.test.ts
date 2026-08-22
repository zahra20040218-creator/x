import { describe, expect, it } from 'vitest';

import { FakeClock } from '../common/clock.js';
import { haversineMeters, InMemoryRedis } from './in-memory-redis.js';
import { runRedisConformance } from './redis.conformance.js';

// The shared contract, run against the fake. The identical assertions run
// against a real Redis in test/integration/ioredis-conformance.test.ts.
runRedisConformance('InMemoryRedis', async () => {
  const clock = new FakeClock();
  const redis = new InMemoryRedis(clock);
  return {
    redis,
    // Advancing an injected clock rather than sleeping is what lets the TTL and
    // offer-timeout tests be exact instead of flaky.
    advance: async (ms: number) => {
      clock.advance(ms);
      // Let any queued microtasks (pub/sub handlers) settle.
      await Promise.resolve();
    },
    cleanup: async () => {
      await redis.close();
    },
  };
});

// Behaviour specific to the fake, not part of the shared contract.
describe('InMemoryRedis specifics', () => {
  it('refuses further commands once closed', async () => {
    const redis = new InMemoryRedis(new FakeClock());
    await redis.close();
    await expect(redis.get('k')).rejects.toThrow(/closed/);
    expect(await redis.ping()).toBe(false);
  });

  it('flushAll resets every data structure', async () => {
    const redis = new InMemoryRedis(new FakeClock());
    await redis.setIfAbsent('k', 'v', 1_000);
    await redis.geoAdd('g', 'm', { lat: 33.3, lng: 44.4 });
    await redis.zAdd('z', 'm', 1);
    await redis.hSet('h', 'f', 'v');
    await redis.rPush('l', 'a');

    redis.flushAll();

    expect(await redis.get('k')).toBeNull();
    expect(await redis.geoSearch('g', { lat: 33.3, lng: 44.4 }, 1_000, 10)).toEqual([]);
    expect(await redis.zScore('z', 'm')).toBeNull();
    expect(await redis.hGetAll('h')).toEqual({});
    expect(await redis.lLen('l')).toBe(0);
  });

  it('rejects an out-of-range coordinate rather than storing nonsense', async () => {
    const redis = new InMemoryRedis(new FakeClock());
    await expect(redis.geoAdd('g', 'm', { lat: 91, lng: 44 })).rejects.toThrow(/latitude/);
    await expect(redis.geoAdd('g', 'm', { lat: 33, lng: 181 })).rejects.toThrow(/longitude/);
    await expect(redis.geoAdd('g', 'm', { lat: NaN, lng: 44 })).rejects.toThrow(/latitude/);
  });

  it('rejects a non-positive lPopCount', async () => {
    const redis = new InMemoryRedis(new FakeClock());
    await expect(redis.lPopCount('l', 0)).rejects.toThrow(/positive integer/);
  });
});

describe('haversineMeters', () => {
  it('is zero for identical points', () => {
    expect(haversineMeters({ lat: 33.3, lng: 44.4 }, { lat: 33.3, lng: 44.4 })).toBe(0);
  });

  it('matches a known Baghdad distance', () => {
    // Tahrir Square -> Adhamiya, about 8.6 km.
    const d = haversineMeters({ lat: 33.3061, lng: 44.4213 }, { lat: 33.3706, lng: 44.3631 });
    expect(d).toBeGreaterThan(8_000);
    expect(d).toBeLessThan(9_500);
  });

  it('is symmetric', () => {
    const a = { lat: 33.3061, lng: 44.4213 };
    const b = { lat: 33.2989, lng: 44.4361 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });

  // A swapped lat/lng is the classic geo bug and it is silent - the call
  // succeeds, and the driver simply is not where they say they are. Comparing
  // two swapped-pair *distances* does not show this well (they can come out
  // similar by coincidence). What shows it is where the point LANDS: Baghdad
  // read backwards is ~1,500 km away, in Kazakhstan.
  it('places a coordinate over a thousand kilometres away when lat/lng are swapped', () => {
    const baghdad = { lat: 33.3061, lng: 44.4213 };
    const swapped = { lat: 44.4213, lng: 33.3061 };

    expect(haversineMeters(baghdad, swapped)).toBeGreaterThan(1_000_000);
  });

  // The consequence in this system: a driver stored with swapped coordinates
  // falls outside every search radius and silently receives no offers ever.
  it('excludes a swapped-coordinate driver from a city-sized search', async () => {
    const redis = new InMemoryRedis(new FakeClock());
    const baghdad = { lat: 33.3061, lng: 44.4213 };

    await redis.geoAdd('drivers:online', 'correct', baghdad);
    await redis.geoAdd('drivers:online', 'swapped', { lat: baghdad.lng, lng: baghdad.lat });

    const hits = await redis.geoSearch('drivers:online', baghdad, 50_000, 10);
    expect(hits.map((h) => h.member)).toEqual(['correct']);
  });
});
