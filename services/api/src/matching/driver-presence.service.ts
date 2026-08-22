import type { Clock } from '../common/clock.js';
import { RedisKeys, type LatLng, type RedisPort } from '../redis/redis.port.js';

/**
 * Where drivers are. CLAUDE.md §3.1:
 *
 *   "Driver locations live in Redis only. Write to GEOADD drivers:online.
 *    Never write a location update to PostgreSQL on the request path."
 *
 * A geo set has no per-member TTL, which is the problem this class exists to
 * solve. Without one, a driver whose phone dies stays on the map forever and
 * keeps winning offers nobody answers - the rider waits out the full offer
 * timeout for a driver who is not there.
 *
 * So liveness is tracked in a parallel sorted set scored by last-heartbeat
 * timestamp, and `sweepStale` evicts members that stopped reporting. Two
 * structures kept in step, which is worth the cost because the alternative is
 * ghost drivers.
 */

export interface DriverPosition extends LatLng {
  accuracyM?: number | undefined;
  headingDeg?: number | undefined;
  speedMps?: number | undefined;
  recordedAt: Date;
}

export interface NearbyDriver {
  driverId: string;
  distanceM: number;
  lat: number;
  lng: number;
}

export class DriverPresenceService {
  constructor(
    private readonly redis: RedisPort,
    private readonly clock: Clock,
    private readonly presenceTtlSeconds: number,
  ) {
    if (!Number.isInteger(presenceTtlSeconds) || presenceTtlSeconds <= 0) {
      throw new Error(
        `presenceTtlSeconds must be a positive integer, got ${presenceTtlSeconds}`,
      );
    }
  }

  /**
   * Put a driver on the map, or move them.
   *
   * Also serves as the heartbeat: a driver reporting a position is by
   * definition alive, so there is no separate keep-alive call to forget.
   */
  async goOnline(driverId: string, position: DriverPosition): Promise<void> {
    await this.redis.geoAdd(RedisKeys.driversOnline, driverId, position);
    await this.redis.zAdd(RedisKeys.driversHeartbeat, driverId, this.clock.nowMs());
    await this.writeLastKnown(driverId, position);
  }

  /**
   * Record a position for a driver already online.
   *
   * Writes to Redis ONLY. The Postgres history table is written by the 30s
   * batch flush job (CLAUDE.md §3.1); a write here would put the request path
   * in front of a disk.
   */
  async recordPosition(driverId: string, position: DriverPosition): Promise<void> {
    await this.redis.geoAdd(RedisKeys.driversOnline, driverId, position);
    await this.redis.zAdd(RedisKeys.driversHeartbeat, driverId, this.clock.nowMs());
    await this.writeLastKnown(driverId, position);

    // Queue for the flush job. A list, not a Postgres INSERT.
    await this.redis.rPush(
      RedisKeys.locationFlushBuffer,
      JSON.stringify({
        driverId,
        lat: position.lat,
        lng: position.lng,
        accuracyM: position.accuracyM ?? null,
        headingDeg: position.headingDeg ?? null,
        speedMps: position.speedMps ?? null,
        recordedAt: position.recordedAt.toISOString(),
      }),
    );
  }

  /**
   * Accept a batch of buffered samples.
   *
   * The driver app buffers while offline and flushes on reconnect
   * (CLAUDE.md §5.3), so a batch commonly contains stale samples. Only the
   * NEWEST sample updates the live position - replaying an old one would
   * teleport the driver backwards on the rider's map.
   */
  async recordBatch(driverId: string, samples: DriverPosition[]): Promise<number> {
    if (samples.length === 0) return 0;

    const sorted = [...samples].sort(
      (a, b) => a.recordedAt.getTime() - b.recordedAt.getTime(),
    );
    const newest = sorted.at(-1)!;

    // Everything goes to the history buffer...
    for (const sample of sorted) {
      await this.redis.rPush(
        RedisKeys.locationFlushBuffer,
        JSON.stringify({
          driverId,
          lat: sample.lat,
          lng: sample.lng,
          accuracyM: sample.accuracyM ?? null,
          headingDeg: sample.headingDeg ?? null,
          speedMps: sample.speedMps ?? null,
          recordedAt: sample.recordedAt.toISOString(),
        }),
      );
    }

    // ...but only the newest becomes "where this driver is now".
    await this.redis.geoAdd(RedisKeys.driversOnline, driverId, newest);
    await this.redis.zAdd(RedisKeys.driversHeartbeat, driverId, this.clock.nowMs());
    await this.writeLastKnown(driverId, newest);

    return sorted.length;
  }

  async goOffline(driverId: string): Promise<void> {
    await this.redis.geoRemove(RedisKeys.driversOnline, driverId);
    await this.redis.zRem(RedisKeys.driversHeartbeat, driverId);
    await this.redis.del(RedisKeys.driverLocation(driverId));
  }

  async isOnline(driverId: string): Promise<boolean> {
    return (await this.redis.zScore(RedisKeys.driversHeartbeat, driverId)) !== null;
  }

  async lastKnownPosition(driverId: string): Promise<DriverPosition | null> {
    const hash = await this.redis.hGetAll(RedisKeys.driverLocation(driverId));
    if (!hash['lat'] || !hash['lng']) return null;

    return {
      lat: Number(hash['lat']),
      lng: Number(hash['lng']),
      accuracyM: hash['accuracyM'] ? Number(hash['accuracyM']) : undefined,
      headingDeg: hash['headingDeg'] ? Number(hash['headingDeg']) : undefined,
      speedMps: hash['speedMps'] ? Number(hash['speedMps']) : undefined,
      recordedAt: new Date(hash['recordedAt'] ?? this.clock.now()),
    };
  }

  /** Nearest-first candidates within the radius. */
  async findNearby(
    center: LatLng,
    radiusM: number,
    limit: number,
  ): Promise<NearbyDriver[]> {
    const hits = await this.redis.geoSearch(RedisKeys.driversOnline, center, radiusM, limit);
    return hits.map((hit) => ({
      driverId: hit.member,
      distanceM: Math.round(hit.distanceM),
      lat: hit.lat,
      lng: hit.lng,
    }));
  }

  /**
   * Evict drivers who have stopped reporting.
   *
   * Run from the scheduled maintenance job. Returns the evicted ids so the
   * caller can also mark them OFFLINE in Postgres.
   */
  async sweepStale(): Promise<string[]> {
    const cutoff = this.clock.nowMs() - this.presenceTtlSeconds * 1_000;
    const stale = await this.redis.zRangeByScore(RedisKeys.driversHeartbeat, 0, cutoff);
    if (stale.length === 0) return [];

    await this.redis.geoRemove(RedisKeys.driversOnline, ...stale);
    await this.redis.zRem(RedisKeys.driversHeartbeat, ...stale);
    for (const driverId of stale) {
      await this.redis.del(RedisKeys.driverLocation(driverId));
    }
    return stale;
  }

  /** Drain the flush buffer. Called by the 30s batch job (CLAUDE.md §3.1). */
  async drainFlushBuffer(batchSize: number): Promise<BufferedSample[]> {
    const raw = await this.redis.lPopCount(RedisKeys.locationFlushBuffer, batchSize);

    const parsed: BufferedSample[] = [];
    for (const item of raw) {
      const sample = parseBufferedSample(item);
      // A malformed entry is dropped, not thrown on: the flush job runs every
      // 30s forever, and one bad row must not wedge it permanently. The live
      // position in the geo set is unaffected either way.
      if (sample) parsed.push(sample);
    }
    return parsed;
  }

  async pendingFlushCount(): Promise<number> {
    return this.redis.lLen(RedisKeys.locationFlushBuffer);
  }

  private async writeLastKnown(driverId: string, position: DriverPosition): Promise<void> {
    const key = RedisKeys.driverLocation(driverId);
    await this.redis.hSet(key, 'lat', String(position.lat));
    await this.redis.hSet(key, 'lng', String(position.lng));
    await this.redis.hSet(key, 'recordedAt', position.recordedAt.toISOString());
    if (position.accuracyM !== undefined) {
      await this.redis.hSet(key, 'accuracyM', String(position.accuracyM));
    }
    if (position.headingDeg !== undefined) {
      await this.redis.hSet(key, 'headingDeg', String(position.headingDeg));
    }
    if (position.speedMps !== undefined) {
      await this.redis.hSet(key, 'speedMps', String(position.speedMps));
    }
  }
}

/** One buffered location sample awaiting the 30s flush into Postgres. */
export interface BufferedSample {
  driverId: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  headingDeg: number | null;
  speedMps: number | null;
  recordedAt: string;
}

/**
 * Parse a buffer entry, returning null for anything malformed.
 *
 * Validated rather than cast: the buffer is JSON in Redis, and `JSON.parse`
 * yields `any`. Trusting it would let a corrupted entry reach an INSERT with a
 * string where a coordinate belongs.
 */
function parseBufferedSample(raw: string): BufferedSample | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;

  if (typeof candidate['driverId'] !== 'string') return null;
  if (typeof candidate['lat'] !== 'number' || !Number.isFinite(candidate['lat'])) return null;
  if (typeof candidate['lng'] !== 'number' || !Number.isFinite(candidate['lng'])) return null;
  if (typeof candidate['recordedAt'] !== 'string') return null;

  const optionalNumber = (key: string): number | null => {
    const v = candidate[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };

  return {
    driverId: candidate['driverId'],
    lat: candidate['lat'],
    lng: candidate['lng'],
    accuracyM: optionalNumber('accuracyM'),
    headingDeg: optionalNumber('headingDeg'),
    speedMps: optionalNumber('speedMps'),
    recordedAt: candidate['recordedAt'],
  };
}
