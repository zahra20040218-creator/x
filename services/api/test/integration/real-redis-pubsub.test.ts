import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IoRedisAdapter } from '../../src/redis/ioredis-adapter.js';
import { RedisKeys } from '../../src/redis/redis.port.js';
import { isRealInfraRequested, realRedisUrl } from '../support/real-infra.js';

/**
 * Pub/sub against a real Redis, and the crash it used to cause.
 *
 * ## What this is a regression test for
 *
 * `RealtimeGateway.onMessage` called `redis.subscribe`, which threw
 * `Stream isn't writeable and enableOfflineQueue options is false`. The throw
 * came out of a `socket.on('message')` handler where nothing caught it, so the
 * API process died. Any client connecting to the WebSocket took the server down
 * with it — and the rider app connects on every tracking screen.
 *
 * The cause was `redis.duplicate()`. It copies the parent's options, and the
 * command connection sets `enableOfflineQueue: false` deliberately: a driver
 * location write that queues while Redis is down is worse than one that fails
 * fast. For the SUBSCRIBER that same option is a bug — a freshly duplicated
 * connection is not connected yet, so the very first `subscribe()` is issued
 * before the stream is writeable and is rejected rather than waiting for ready.
 *
 * This needs a real Redis: the in-memory fake has no connection lifecycle, so
 * it cannot reproduce "not connected yet" at all. Every test here would pass
 * against the fake whether the bug were fixed or not.
 */

const RUN = isRealInfraRequested();
const describeReal = RUN ? describe : describe.skip;

describeReal('redis pub/sub on real Redis', () => {
  let url: string;
  const opened: IoRedisAdapter[] = [];

  beforeAll(() => {
    url = realRedisUrl();
  });

  afterAll(async () => {
    for (const adapter of opened) await adapter.close().catch(() => undefined);
  });

  function adapter(): IoRedisAdapter {
    const created = IoRedisAdapter.fromUrl(url);
    opened.push(created);
    return created;
  }

  it('subscribes on a connection that has only just been created', async () => {
    // The exact shape of the crash: construct, then subscribe immediately,
    // before anything has forced the connection to become ready. Before the
    // fix this rejected and killed the process that called it.
    const redis = adapter();
    const channel = RedisKeys.driverChannel('driver-fresh');

    await expect(redis.subscribe(channel, () => {})).resolves.toBeTypeOf('function');
  });

  it('delivers a message published from a different connection', async () => {
    // Two adapters, as the real deployment has: the worker publishes and the
    // API process holds the subscription.
    const publisher = adapter();
    const subscriber = adapter();
    const channel = RedisKeys.driverChannel('driver-crossproc');

    const seen: string[] = [];
    await subscriber.subscribe(channel, (message) => seen.push(message));

    // Redis reports how many subscribers it handed the message to. Zero here
    // would mean the subscription had not taken effect yet, which is a
    // different bug wearing the same symptom.
    const receivers = await publisher.publish(channel, JSON.stringify({ type: 'ride.offer' }));
    expect(receivers).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]!).type).toBe('ride.offer');
  });

  it('publishing immediately after construction does not throw', async () => {
    // The publish side of the same lifecycle question. The worker publishes on
    // a transaction commit callback, which can be the first thing that
    // connection ever does.
    const redis = adapter();

    await expect(
      redis.publish(RedisKeys.driverChannel('driver-early'), 'x'),
    ).resolves.toBeTypeOf('number');
  });

  it('keeps a driver channel separate from a rider channel with the same id', async () => {
    const publisher = adapter();
    const subscriber = adapter();

    const driverSeen: string[] = [];
    const riderSeen: string[] = [];
    await subscriber.subscribe(RedisKeys.driverChannel('same-id'), (m) => driverSeen.push(m));
    await subscriber.subscribe(RedisKeys.riderChannel('same-id'), (m) => riderSeen.push(m));

    await publisher.publish(RedisKeys.driverChannel('same-id'), 'for-the-driver');
    await new Promise((resolve) => setTimeout(resolve, 120));

    // The channels are keyed by role as well as by user. A rider and a driver
    // can share a user id in a test fixture, and in production an admin can be
    // both - neither must see the other's events.
    expect(driverSeen).toEqual(['for-the-driver']);
    expect(riderSeen).toEqual([]);
  });

  it('unsubscribing one handler leaves the others receiving', async () => {
    const publisher = adapter();
    const subscriber = adapter();
    const channel = RedisKeys.riderChannel('shared-channel');

    const first: string[] = [];
    const second: string[] = [];
    const stopFirst = await subscriber.subscribe(channel, (m) => first.push(m));
    await subscriber.subscribe(channel, (m) => second.push(m));

    await stopFirst();
    await publisher.publish(channel, 'after');
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Leaving the Redis channel on the first unsubscribe would silently kill
    // every other listener on the same process - two riders tracking rides
    // would become one.
    expect(first).toEqual([]);
    expect(second).toEqual(['after']);
  });
});
