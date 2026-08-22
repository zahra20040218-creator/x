import { Redis } from 'ioredis';

import type { GeoHit, LatLng, RedisPort, Unsubscribe } from './redis.port.js';

/**
 * The production {@link RedisPort}, backed by ioredis.
 *
 * Every method here has a counterpart in InMemoryRedis, and
 * `redis.conformance.ts` asserts they agree. If you change semantics in one,
 * the conformance suite fails until you change the other - which is the point.
 */
export class IoRedisAdapter implements RedisPort {
  /**
   * A connection in subscriber mode cannot issue ordinary commands, so pub/sub
   * needs its own connection. It is created lazily: the API process subscribes,
   * the queue workers mostly do not, and an idle second connection per worker
   * is wasted capacity on a 4-core box.
   */
  private subscriber: Redis | null = null;

  private readonly handlers = new Map<string, Set<(message: string) => void>>();

  constructor(private readonly redis: Redis) {
    // Registered once, in the constructor. Doing it per-subscribe would attach
    // a new listener on every call and re-deliver each message N times.
    this.redis.defineCommand('compareAndDelete', {
      numberOfKeys: 1,
      lua: `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
          return redis.call("DEL", KEYS[1])
        else
          return 0
        end
      `,
    });
  }

  static fromUrl(url: string): IoRedisAdapter {
    return new IoRedisAdapter(
      new Redis(url, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        // A driver location write that queues while Redis is down is worse than
        // one that fails fast: the driver app buffers and retries anyway
        // (CLAUDE.md §5.3), and an unbounded offline queue eats API memory.
        enableOfflineQueue: false,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Claims - CLAUDE.md §5.1
  // -------------------------------------------------------------------------

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new Error(`setIfAbsent requires a positive integer ttlMs, got ${ttlMs}`);
    }
    // This exact command is mandated by CLAUDE.md §5.1. Do not replace it with
    // a GET followed by a SET - that reintroduces the double-accept window.
    const result = await this.redis.set(key, value, 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async compareAndDelete(key: string, expectedValue: string): Promise<boolean> {
    const deleted = await (
      this.redis as Redis & {
        compareAndDelete(key: string, value: string): Promise<number>;
      }
    ).compareAndDelete(key, expectedValue);
    return deleted === 1;
  }

  async del(key: string): Promise<number> {
    return this.redis.del(key);
  }

  async pttl(key: string): Promise<number> {
    return this.redis.pttl(key);
  }

  // -------------------------------------------------------------------------
  // Geo
  // -------------------------------------------------------------------------

  async geoAdd(key: string, member: string, position: LatLng): Promise<void> {
    // Note the argument order: Redis takes longitude FIRST. Getting this
    // backwards puts every Baghdad driver in the Indian Ocean, and the bug is
    // invisible until a search returns nothing.
    await this.redis.geoadd(key, position.lng, position.lat, member);
  }

  async geoSearch(
    key: string,
    center: LatLng,
    radiusM: number,
    limit: number,
  ): Promise<GeoHit[]> {
    const raw = (await this.redis.call(
      'GEOSEARCH',
      key,
      'FROMLONLAT',
      String(center.lng),
      String(center.lat),
      'BYRADIUS',
      String(radiusM),
      'm',
      'ASC',
      'COUNT',
      String(limit),
      'WITHCOORD',
      'WITHDIST',
    )) as Array<[string, string, [string, string]]>;

    return raw.map(([member, distance, [lng, lat]]) => ({
      member,
      distanceM: Number(distance),
      lat: Number(lat),
      lng: Number(lng),
    }));
  }

  async geoPosition(key: string, member: string): Promise<LatLng | null> {
    const result = await this.redis.geopos(key, member);
    const first = result[0];
    if (!first) return null;
    return { lng: Number(first[0]), lat: Number(first[1]) };
  }

  async geoRemove(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    // A geo set IS a sorted set; ZREM is how you remove a member from one.
    return this.redis.zrem(key, ...members);
  }

  // -------------------------------------------------------------------------
  // Sorted sets
  // -------------------------------------------------------------------------

  async zAdd(key: string, member: string, score: number): Promise<void> {
    await this.redis.zadd(key, score, member);
  }

  async zScore(key: string, member: string): Promise<number | null> {
    const score = await this.redis.zscore(key, member);
    return score === null ? null : Number(score);
  }

  async zRangeByScore(
    key: string,
    min: number,
    max: number,
    limit?: number,
  ): Promise<string[]> {
    if (limit === undefined) {
      return this.redis.zrangebyscore(key, min, max);
    }
    return this.redis.zrangebyscore(key, min, max, 'LIMIT', 0, limit);
  }

  async zRem(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return this.redis.zrem(key, ...members);
  }

  // -------------------------------------------------------------------------
  // Hashes
  // -------------------------------------------------------------------------

  async hSet(key: string, field: string, value: string): Promise<void> {
    await this.redis.hset(key, field, value);
  }

  async hGet(key: string, field: string): Promise<string | null> {
    return this.redis.hget(key, field);
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    return this.redis.hgetall(key);
  }

  async hDel(key: string, ...fields: string[]): Promise<number> {
    if (fields.length === 0) return 0;
    return this.redis.hdel(key, ...fields);
  }

  // -------------------------------------------------------------------------
  // Lists
  // -------------------------------------------------------------------------

  async rPush(key: string, ...values: string[]): Promise<number> {
    if (values.length === 0) return this.redis.llen(key);
    return this.redis.rpush(key, ...values);
  }

  async lPopCount(key: string, count: number): Promise<string[]> {
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`lPopCount requires a positive integer count, got ${count}`);
    }
    // LPOP with a count is atomic (Redis >= 6.2). Reading then trimming would
    // drop samples whenever two flush workers overlap.
    const result = await this.redis.lpop(key, count);
    return result ?? [];
  }

  async lLen(key: string): Promise<number> {
    return this.redis.llen(key);
  }

  // -------------------------------------------------------------------------
  // Pub/sub
  // -------------------------------------------------------------------------

  private ensureSubscriber(): Redis {
    if (!this.subscriber) {
      this.subscriber = this.redis.duplicate();
      this.subscriber.on('message', (channel: string, message: string) => {
        const set = this.handlers.get(channel);
        if (!set) return;
        for (const handler of [...set]) handler(message);
      });
    }
    return this.subscriber;
  }

  async publish(channel: string, message: string): Promise<number> {
    return this.redis.publish(channel, message);
  }

  async subscribe(
    channel: string,
    handler: (message: string) => void,
  ): Promise<Unsubscribe> {
    const subscriber = this.ensureSubscriber();

    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await subscriber.subscribe(channel);
    }
    set.add(handler);

    return async () => {
      set.delete(handler);
      // Only leave the Redis channel when the LAST local handler goes away;
      // unsubscribing on the first would silently kill other listeners.
      if (set.size === 0) {
        this.handlers.delete(channel);
        await subscriber.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.quit().catch(() => undefined);
      this.subscriber = null;
    }
    await this.redis.quit().catch(() => undefined);
  }
}
