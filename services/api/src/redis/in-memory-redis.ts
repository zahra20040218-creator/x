/*
 * eslint-disable @typescript-eslint/require-await
 *
 * Every method here is `async` with no `await`, and that is the point rather
 * than an oversight. `require-await` exists to catch a function that was marked
 * async by accident; this class deliberately implements an async interface with
 * synchronous bodies, because running to completion with no suspension point is
 * exactly what reproduces Redis's single-threaded atomicity. Adding an `await`
 * to satisfy the rule would insert a microtask boundary into every
 * read-modify-write and destroy the guarantee the double-accept tests rely on.
 */
/* eslint-disable @typescript-eslint/require-await */

import type { Clock } from '../common/clock.js';
import { SystemClock } from '../common/clock.js';
import type { GeoHit, LatLng, RedisPort, Unsubscribe } from './redis.port.js';

/**
 * An in-process implementation of {@link RedisPort}.
 *
 * Used by unit tests so that concurrency, TTL expiry and offer timeouts can be
 * driven deterministically. It is held honest by `redis.conformance.ts`, which
 * runs the SAME assertions against this and against a real Redis whenever one
 * is reachable.
 *
 * Two properties are deliberate and load-bearing:
 *
 *  - **Single-threaded atomicity.** Every method body runs to completion
 *    synchronously before returning its promise. There is no `await` inside a
 *    read-modify-write, so no interleaving is possible - which is exactly the
 *    guarantee real Redis gives, and exactly what the double-accept test needs
 *    in order to mean anything.
 *
 *  - **Lazy TTL expiry against an injected Clock.** Keys are checked for expiry
 *    on access rather than on a timer, so a test can advance a FakeClock and
 *    observe the claim expire without sleeping.
 */
export class InMemoryRedis implements RedisPort {
  private readonly strings = new Map<string, { value: string; expiresAtMs: number | null }>();
  private readonly geo = new Map<string, Map<string, LatLng>>();
  private readonly zsets = new Map<string, Map<string, number>>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly lists = new Map<string, string[]>();
  private readonly channels = new Map<string, Set<(message: string) => void>>();
  private closed = false;

  constructor(private readonly clock: Clock = new SystemClock()) {}

  // -------------------------------------------------------------------------
  // Expiry
  // -------------------------------------------------------------------------

  private isLive(key: string): boolean {
    const entry = this.strings.get(key);
    if (!entry) return false;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= this.clock.nowMs()) {
      this.strings.delete(key);
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Claims
  // -------------------------------------------------------------------------

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    this.assertOpen();
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new Error(`setIfAbsent requires a positive integer ttlMs, got ${ttlMs}`);
    }
    // Read and write happen with no await between them, so two concurrent
    // callers can never both observe the key as absent.
    if (this.isLive(key)) return false;
    this.strings.set(key, { value, expiresAtMs: this.clock.nowMs() + ttlMs });
    return true;
  }

  async get(key: string): Promise<string | null> {
    this.assertOpen();
    return this.isLive(key) ? (this.strings.get(key)?.value ?? null) : null;
  }

  async compareAndDelete(key: string, expectedValue: string): Promise<boolean> {
    this.assertOpen();
    if (!this.isLive(key)) return false;
    if (this.strings.get(key)?.value !== expectedValue) return false;
    this.strings.delete(key);
    return true;
  }

  async del(key: string): Promise<number> {
    this.assertOpen();
    // Real Redis DEL removes a key of ANY type. An earlier version of this
    // method only touched `strings`, so `del` on a hash silently did nothing -
    // taking a driver offline left their last-known location readable. That is
    // exactly the fake-vs-real divergence the conformance suite exists to
    // catch, so DEL-on-every-type is asserted there too.
    const existed =
      this.isLive(key) ||
      this.geo.has(key) ||
      this.zsets.has(key) ||
      this.hashes.has(key) ||
      this.lists.has(key);

    this.strings.delete(key);
    this.geo.delete(key);
    this.zsets.delete(key);
    this.hashes.delete(key);
    this.lists.delete(key);

    return existed ? 1 : 0;
  }

  async increment(key: string, ttlMs: number): Promise<number> {
    this.assertOpen();
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new Error(`increment requires a positive integer ttlMs, got ${ttlMs}`);
    }

    // Read and write with no await between them, so two concurrent callers
    // cannot both observe the same count.
    if (!this.isLive(key)) {
      this.strings.set(key, { value: '1', expiresAtMs: this.clock.nowMs() + ttlMs });
      return 1;
    }

    const entry = this.strings.get(key)!;
    const next = Number(entry.value) + 1;
    // The expiry is NOT refreshed - see the port's contract.
    entry.value = String(next);
    return next;
  }

  async pttl(key: string): Promise<number> {
    this.assertOpen();
    if (!this.isLive(key)) return -2;
    const entry = this.strings.get(key);
    if (!entry || entry.expiresAtMs === null) return -1;
    return Math.max(0, entry.expiresAtMs - this.clock.nowMs());
  }

  // -------------------------------------------------------------------------
  // Geo
  // -------------------------------------------------------------------------

  async geoAdd(key: string, member: string, position: LatLng): Promise<void> {
    this.assertOpen();
    assertValidPosition(position);
    let set = this.geo.get(key);
    if (!set) {
      set = new Map();
      this.geo.set(key, set);
    }
    set.set(member, { lat: position.lat, lng: position.lng });
  }

  async geoSearch(
    key: string,
    center: LatLng,
    radiusM: number,
    limit: number,
  ): Promise<GeoHit[]> {
    this.assertOpen();
    assertValidPosition(center);
    const set = this.geo.get(key);
    if (!set) return [];

    const hits: GeoHit[] = [];
    for (const [member, position] of set) {
      const distanceM = haversineMeters(center, position);
      if (distanceM <= radiusM) {
        hits.push({ member, distanceM, lat: position.lat, lng: position.lng });
      }
    }
    // Nearest first. Ties broken by member id so the ordering is total and the
    // matching worker is reproducible rather than dependent on insertion order.
    hits.sort((a, b) => a.distanceM - b.distanceM || a.member.localeCompare(b.member));
    return hits.slice(0, limit);
  }

  async geoPosition(key: string, member: string): Promise<LatLng | null> {
    this.assertOpen();
    return this.geo.get(key)?.get(member) ?? null;
  }

  async geoRemove(key: string, ...members: string[]): Promise<number> {
    this.assertOpen();
    const set = this.geo.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) if (set.delete(m)) removed++;
    return removed;
  }

  // -------------------------------------------------------------------------
  // Sorted sets
  // -------------------------------------------------------------------------

  async zAdd(key: string, member: string, score: number): Promise<void> {
    this.assertOpen();
    let set = this.zsets.get(key);
    if (!set) {
      set = new Map();
      this.zsets.set(key, set);
    }
    set.set(member, score);
  }

  async zScore(key: string, member: string): Promise<number | null> {
    this.assertOpen();
    return this.zsets.get(key)?.get(member) ?? null;
  }

  async zRangeByScore(
    key: string,
    min: number,
    max: number,
    limit?: number,
  ): Promise<string[]> {
    this.assertOpen();
    const set = this.zsets.get(key);
    if (!set) return [];
    const members = [...set.entries()]
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([member]) => member);
    return limit === undefined ? members : members.slice(0, limit);
  }

  async zRem(key: string, ...members: string[]): Promise<number> {
    this.assertOpen();
    const set = this.zsets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) if (set.delete(m)) removed++;
    return removed;
  }

  // -------------------------------------------------------------------------
  // Hashes
  // -------------------------------------------------------------------------

  async hSet(key: string, field: string, value: string): Promise<void> {
    this.assertOpen();
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    hash.set(field, value);
  }

  async hSetMany(key: string, fields: Readonly<Record<string, string>>): Promise<void> {
    this.assertOpen();
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    for (const [field, value] of Object.entries(fields)) hash.set(field, value);
  }

  async hGet(key: string, field: string): Promise<string | null> {
    this.assertOpen();
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    this.assertOpen();
    const hash = this.hashes.get(key);
    return hash ? Object.fromEntries(hash) : {};
  }

  async hDel(key: string, ...fields: string[]): Promise<number> {
    this.assertOpen();
    const hash = this.hashes.get(key);
    if (!hash) return 0;
    let removed = 0;
    for (const f of fields) if (hash.delete(f)) removed++;
    return removed;
  }

  // -------------------------------------------------------------------------
  // Lists
  // -------------------------------------------------------------------------

  async rPush(key: string, ...values: string[]): Promise<number> {
    this.assertOpen();
    let list = this.lists.get(key);
    if (!list) {
      list = [];
      this.lists.set(key, list);
    }
    list.push(...values);
    return list.length;
  }

  async lPopCount(key: string, count: number): Promise<string[]> {
    this.assertOpen();
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`lPopCount requires a positive integer count, got ${count}`);
    }
    const list = this.lists.get(key);
    if (!list || list.length === 0) return [];
    return list.splice(0, count);
  }

  async lLen(key: string): Promise<number> {
    this.assertOpen();
    return this.lists.get(key)?.length ?? 0;
  }

  // -------------------------------------------------------------------------
  // Pub/sub
  // -------------------------------------------------------------------------

  async publish(channel: string, message: string): Promise<number> {
    this.assertOpen();
    const handlers = this.channels.get(channel);
    if (!handlers) return 0;
    // Copy before iterating: a handler is allowed to unsubscribe itself.
    for (const handler of [...handlers]) handler(message);
    return handlers.size;
  }

  async subscribe(
    channel: string,
    handler: (message: string) => void,
  ): Promise<Unsubscribe> {
    this.assertOpen();
    let handlers = this.channels.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.channels.set(channel, handlers);
    }
    handlers.add(handler);
    return async () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.channels.delete(channel);
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle + test helpers
  // -------------------------------------------------------------------------

  async ping(): Promise<boolean> {
    return !this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('InMemoryRedis has been closed');
  }

  /** Test helper. Not part of RedisPort. */
  flushAll(): void {
    this.strings.clear();
    this.geo.clear();
    this.zsets.clear();
    this.hashes.clear();
    this.lists.clear();
    this.channels.clear();
    this.closed = false;
  }
}

function assertValidPosition(position: LatLng): void {
  const { lat, lng } = position;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error(`Invalid latitude: ${lat}`);
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error(`Invalid longitude: ${lng}`);
  }
}

const EARTH_RADIUS_M = 6_372_797.560856; // The value Redis itself uses.

export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}
