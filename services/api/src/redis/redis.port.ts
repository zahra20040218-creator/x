/**
 * The narrow Redis surface this system uses.
 *
 * Why a port at all, rather than passing `ioredis` around:
 *
 * 1. CLAUDE.md §5.1 fixes the matching algorithm to a specific Redis primitive
 *    (`SET key value NX PX ttl`). That primitive deserves a named method with a
 *    documented contract, not a stringly-typed call repeated at three call
 *    sites with slightly different argument orders.
 *
 * 2. The correctness core must be testable at 95% (CLAUDE.md §10) including the
 *    concurrent case. Driving true interleaving against a real Redis from a
 *    unit test is slow and non-deterministic; against an in-memory
 *    implementation it is exact and repeatable.
 *
 * The obvious risk of (2) is that the tests end up proving the fake correct
 * rather than the system. That risk is addressed directly: both
 * implementations are run against ONE shared conformance suite
 * (`redis.conformance.ts`). When a real Redis is available the suite runs twice
 * and any divergence between fake and real fails the build.
 */

export interface GeoHit {
  member: string;
  distanceM: number;
  lat: number;
  lng: number;
}

export interface LatLng {
  lat: number;
  lng: number;
}

export type Unsubscribe = () => Promise<void>;

export interface RedisPort {
  // -------------------------------------------------------------------------
  // Claims - CLAUDE.md §5.1
  // -------------------------------------------------------------------------

  /**
   * `SET key value NX PX ttlMs`.
   *
   * Returns true only for the caller that created the key. This is the entire
   * basis of "two drivers must never accept the same ride": the winner is
   * whoever gets `true`, decided inside Redis, single-threaded, with no
   * read-then-write window for a second caller to slip into.
   */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;

  get(key: string): Promise<string | null>;

  /**
   * Delete the key only if it still holds `expectedValue` (Lua compare-and-
   * delete).
   *
   * A plain DEL would be wrong: between the holder deciding to release and the
   * DEL landing, the key may have expired and been re-acquired by a different
   * driver. A plain DEL would then delete somebody else's live claim.
   */
  compareAndDelete(key: string, expectedValue: string): Promise<boolean>;

  del(key: string): Promise<number>;

  /** Milliseconds remaining. -2 if the key is gone, -1 if it has no expiry. */
  pttl(key: string): Promise<number>;

  /**
   * Atomically increment a counter, setting its expiry on FIRST creation only.
   *
   * Used for rate limiting. The atomicity and the "first creation only" part
   * are both load-bearing: a GET-then-SET would let two concurrent requests
   * both read the same count, and refreshing the TTL on every increment would
   * turn a fixed window into a sliding one that never expires under sustained
   * load - the limiter would lock a caller out permanently.
   */
  increment(key: string, ttlMs: number): Promise<number>;

  // -------------------------------------------------------------------------
  // Driver presence - CLAUDE.md §3.1 (locations live in Redis ONLY)
  // -------------------------------------------------------------------------

  geoAdd(key: string, member: string, position: LatLng): Promise<void>;

  /** Nearest-first, capped. Used to pick matching candidates. */
  geoSearch(key: string, center: LatLng, radiusM: number, limit: number): Promise<GeoHit[]>;

  geoPosition(key: string, member: string): Promise<LatLng | null>;

  geoRemove(key: string, ...members: string[]): Promise<number>;

  // -------------------------------------------------------------------------
  // Heartbeats. A geo set has no per-member TTL, so liveness is tracked in a
  // parallel sorted set scored by last-seen timestamp, and a sweeper evicts
  // members that stopped reporting. Without this a driver whose phone died
  // stays on the map forever and keeps winning offers nobody answers.
  // -------------------------------------------------------------------------

  zAdd(key: string, member: string, score: number): Promise<void>;
  zScore(key: string, member: string): Promise<number | null>;
  zRangeByScore(key: string, min: number, max: number, limit?: number): Promise<string[]>;
  zRem(key: string, ...members: string[]): Promise<number>;

  // -------------------------------------------------------------------------
  // Last-known location payloads (heading, speed, accuracy, timestamp).
  // -------------------------------------------------------------------------

  hSet(key: string, field: string, value: string): Promise<void>;
  hGet(key: string, field: string): Promise<string | null>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hDel(key: string, ...fields: string[]): Promise<number>;

  // -------------------------------------------------------------------------
  // Location flush buffer - CLAUDE.md §3.1: a background job drains this into
  // Postgres every 30s in batches. Nothing on the request path touches PG.
  // -------------------------------------------------------------------------

  rPush(key: string, ...values: string[]): Promise<number>;
  /** Pop up to `count` items from the head, atomically. Returns [] when empty. */
  lPopCount(key: string, count: number): Promise<string[]>;
  lLen(key: string): Promise<number>;

  // -------------------------------------------------------------------------
  // Realtime fan-out. With more than one API process, a WebSocket client is
  // connected to exactly one of them, so state changes must cross processes.
  // -------------------------------------------------------------------------

  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, handler: (message: string) => void): Promise<Unsubscribe>;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const REDIS = Symbol('REDIS');

// ---------------------------------------------------------------------------
// Key naming. Centralised so that a typo cannot silently create a second,
// empty namespace that reads as "no drivers online".
// ---------------------------------------------------------------------------

export const RedisKeys = {
  /** Geo set of every online driver. CLAUDE.md §3.1 names this exactly. */
  driversOnline: 'drivers:online',

  /** Sorted set: driverId -> last heartbeat epoch ms. */
  driversHeartbeat: 'drivers:heartbeat',

  /** Hash of a driver's last known location payload. */
  driverLocation: (driverId: string) => `driver:${driverId}:location`,

  /** The claim key from CLAUDE.md §5.1, verbatim. */
  rideClaim: (rideId: string) => `ride:${rideId}:claim`,

  /** Drivers already offered this ride, so the loop does not re-offer. */
  rideOfferedDrivers: (rideId: string) => `ride:${rideId}:offered`,

  /** The driver's current outstanding offer. */
  driverCurrentOffer: (driverId: string) => `driver:${driverId}:offer`,

  /** Buffer drained into Postgres by the 30s flush job. */
  locationFlushBuffer: 'locations:flush',

  /** Realtime channels. Derived from the token's user id, never from input. */
  riderChannel: (userId: string) => `rt:rider:${userId}`,
  driverChannel: (userId: string) => `rt:driver:${userId}`,
} as const;
