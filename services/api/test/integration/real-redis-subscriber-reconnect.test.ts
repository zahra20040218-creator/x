import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IoRedisAdapter } from '../../src/redis/ioredis-adapter.js';
import { isRealInfraRequested, realRedisUrl } from '../support/real-infra.js';

/**
 * The subscriber connection must survive losing its connection.
 *
 * ## The bug this exists for
 *
 * A 16-minute soak - 500 held WebSockets plus real ride and location traffic -
 * logged `realtime.subscribe_failed` **215 times**, and every one of those was
 * a driver refused a realtime channel. The message was always the same:
 *
 *     Connection in subscriber mode, only subscriber commands may be used
 *
 * with a stack through ioredis's `_readyCheck`. The ready check works by
 * issuing `INFO`. A connection holding a subscription is in subscriber mode,
 * where the server refuses `INFO` - so every time the subscriber reconnected,
 * the check that exists to confirm the connection is healthy was what broke it.
 *
 * `ensureSubscriber` builds that connection with `duplicate()`, which copies
 * the parent's options, and the parent sets `enableReadyCheck: true` because it
 * is an ordinary command connection where the check is correct. Inheriting it
 * was the defect.
 *
 * ## Why this test needs real Redis and a real disconnect
 *
 * The failure only appears on RECONNECT: a fresh subscriber is not yet in
 * subscriber mode, so the first ready check passes and everything looks fine.
 * It took a saturated Redis under a long soak to surface it, and no unit test
 * with a fake could have - the fake has no notion of subscriber mode, no
 * reconnect, and no `INFO`.
 *
 * So this kills the connection from the server side with `CLIENT KILL`, exactly
 * as an overloaded or restarted Redis would, and then asks the adapter to do
 * the thing that failed: subscribe again and deliver a message.
 */

const RUN = isRealInfraRequested();
const describeReal = RUN ? describe : describe.skip;

describeReal('the subscriber connection, across a disconnect', () => {
  let adapter: IoRedisAdapter;
  let assassin: Redis;

  beforeAll(async () => {
    adapter = IoRedisAdapter.fromUrl(realRedisUrl());
    // A second, ordinary connection, used only to kill the first.
    assassin = new Redis(realRedisUrl());
    await adapter.ping();
  });

  afterAll(async () => {
    await adapter.close();
    assassin.disconnect();
  });

  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Drop every client that is in subscriber mode.
   *
   * `CLIENT KILL TYPE pubsub` names exactly the connection under test and
   * leaves the command and publisher connections alone, so a failure here can
   * only be about the subscriber.
   */
  async function killSubscriberConnections(): Promise<number> {
    const killed = await assassin.client('KILL', 'TYPE', 'pubsub');
    return Number(killed);
  }

  it('resubscribes and still delivers after the connection is killed', async () => {
    const before: string[] = [];
    const unsubscribe = await adapter.subscribe('rt:test:reconnect', (message) => {
      before.push(message);
    });

    await adapter.publish('rt:test:reconnect', 'first');
    await settle(150);
    expect(before).toEqual(['first']);

    // The hiccup.
    const killed = await killSubscriberConnections();
    expect(killed).toBeGreaterThan(0);

    // ioredis reconnects and re-enters subscriber mode on its own. This is the
    // window in which the ready check used to fire INFO and poison the
    // connection.
    await settle(1_500);

    await adapter.publish('rt:test:reconnect', 'second');
    await settle(300);

    // The original subscription must still be live. A driver who was online
    // before a Redis blip is still online after it.
    expect(before).toEqual(['first', 'second']);
    await unsubscribe();
  });

  it('accepts a NEW subscription after the connection is killed', async () => {
    // This is the case the soak actually hit: not an existing subscriber losing
    // messages, but a driver connecting DURING the reconnect window and being
    // refused a channel outright.
    await adapter.subscribe('rt:test:existing', () => {});
    await killSubscriberConnections();

    const seen: string[] = [];
    // No settle first, on purpose - subscribing while the connection is still
    // coming back is exactly what failed.
    const unsubscribe = await adapter.subscribe('rt:test:fresh', (message) => {
      seen.push(message);
    });

    await settle(500);
    await adapter.publish('rt:test:fresh', 'after-the-kill');
    await settle(300);

    expect(seen).toEqual(['after-the-kill']);
    await unsubscribe();
  });

  it('survives being killed repeatedly', async () => {
    // One recovery can be luck. A flapping Redis is the realistic case, and the
    // adapter must not degrade a little further on each round.
    const seen: string[] = [];
    const unsubscribe = await adapter.subscribe('rt:test:flap', (message) => {
      seen.push(message);
    });

    for (let round = 0; round < 3; round += 1) {
      await killSubscriberConnections();
      await settle(1_200);
      await adapter.publish('rt:test:flap', `round-${round}`);
      await settle(300);
    }

    expect(seen).toEqual(['round-0', 'round-1', 'round-2']);
    await unsubscribe();
  });

  it('never lets a ready check reach a subscriber connection', async () => {
    // The direct assertion, in case a future change reintroduces the option by
    // some other route: whatever ioredis does on reconnect, it must not produce
    // a subscriber-mode error.
    const errors: string[] = [];
    const subscriber = (adapter as unknown as { subscriber: Redis | null }).subscriber;
    expect(subscriber).not.toBeNull();
    subscriber!.on('error', (error: Error) => errors.push(error.message));

    await adapter.subscribe('rt:test:noinfo', () => {});
    await killSubscriberConnections();
    await settle(2_000);

    expect(errors.filter((message) => message.includes('subscriber mode'))).toEqual([]);
  });
});
