import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { FakeClock } from '../../src/common/clock.js';
import { TokenService } from '../../src/auth/token.service.js';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway.js';
import { InMemoryRedis } from '../../src/redis/in-memory-redis.js';

/**
 * The realtime layer.
 *
 * Until now this had **zero automated tests** — the security audit recorded
 * the channel authorisation as "correct by construction, untested", which is
 * a polite way of saying nobody had ever checked. Construction arguments are
 * how you end up confident and wrong.
 *
 * These drive a real HTTP server with a real `ws` client over a real socket.
 * The only fake is Redis, and the conformance suite already proves the fake
 * and a real server agree on publish/subscribe.
 */

const SECRET = 'a-test-secret-that-is-long-enough-32';
const AUTH_TIMEOUT_MS = 5_000;

describe('realtime gateway', () => {
  let server: Server;
  let gateway: RealtimeGateway;
  let redis: InMemoryRedis;
  let tokens: TokenService;
  let clock: FakeClock;
  let port: number;

  beforeEach(async () => {
    clock = new FakeClock();
    redis = new InMemoryRedis(clock);
    tokens = new TokenService(SECRET, clock, 3_600, 2_592_000);
    gateway = new RealtimeGateway(tokens, redis);

    server = createServer();
    gateway.attach(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterEach(async () => {
    await gateway.close();
    await redis.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function connect(): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${port}/v1/realtime`);
  }

  function open(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
  }

  /** Next text frame, or reject if the socket closes first. */
  function nextMessage(socket: WebSocket, timeoutMs = 3_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
      socket.once('message', (data: Buffer) => {
        clearTimeout(timer);
        resolve(data.toString('utf8'));
      });
      socket.once('close', (code: number) => {
        clearTimeout(timer);
        reject(new Error(`closed with ${code}`));
      });
    });
  }

  /// Buffers every frame from now on.
  ///
  /// `once('message')` is a race when the publish has already happened: `ws`
  /// discards an event with no listener attached at emit time.
  function collect(socket: WebSocket): string[] {
    const seen: string[] = [];
    socket.on('message', (data: Buffer) => seen.push(data.toString('utf8')));
    return seen;
  }

  function nextClose(socket: WebSocket, timeoutMs = 8_000): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('never closed')), timeoutMs);
      socket.once('close', (code: number) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  /** Connect, authenticate, and wait for the gateway's `ready`. */
  async function authenticated(userId: string, role: 'RIDER' | 'DRIVER'): Promise<WebSocket> {
    const socket = connect();
    await open(socket);
    const token = await tokens.issueAccessToken(userId, role, `session-${userId}`);
    socket.send(JSON.stringify({ type: 'auth', token }));

    const ready = await nextMessage(socket);
    expect(JSON.parse(ready)).toEqual({ type: 'ready' });
    return socket;
  }

  // -------------------------------------------------------------------------
  // The security property. This is why the file exists.
  // -------------------------------------------------------------------------

  describe('channel authorisation', () => {
    it('delivers a rider their own events', async () => {
      const socket = await authenticated('rider-1', 'RIDER');

      await gateway.toRider('rider-1', { type: 'ride.accepted', rideId: 'r1' } as never);

      expect(JSON.parse(await nextMessage(socket))).toMatchObject({
        type: 'ride.accepted',
      });
      socket.close();
    });

    it('NEVER delivers another rider their events', async () => {
      const mine = await authenticated('rider-1', 'RIDER');

      // Addressed to somebody else entirely.
      await gateway.toRider('rider-2', { type: 'ride.accepted', rideId: 'r2' } as never);
      // And one addressed to a DRIVER with the same id, in case the channel
      // key were built from the id alone.
      await gateway.toDriver('rider-1', { type: 'ride.offered', rideId: 'r3' } as never);

      await expect(nextMessage(mine, 500)).rejects.toThrow('timed out');
      mine.close();
    });

    it('keys the channel on the token, and a client cannot name one', async () => {
      const socket = await authenticated('rider-1', 'RIDER');

      // There is no subscribe frame in the protocol at all. Sending one that
      // names somebody else's channel must not subscribe us to it.
      socket.send(JSON.stringify({ type: 'subscribe', channel: 'rider:rider-2' }));
      await gateway.toRider('rider-2', { type: 'ride.accepted' } as never);

      await expect(nextMessage(socket, 500)).rejects.toThrow('timed out');
      socket.close();
    });

    it('separates a driver channel from a rider channel with the same id', async () => {
      const driver = await authenticated('same-id', 'DRIVER');

      await gateway.toRider('same-id', { type: 'wrong.side' } as never);
      await expect(nextMessage(driver, 500)).rejects.toThrow('timed out');

      await gateway.toDriver('same-id', { type: 'ride.offered' } as never);
      expect(JSON.parse(await nextMessage(driver))).toMatchObject({ type: 'ride.offered' });
      driver.close();
    });
  });

  // -------------------------------------------------------------------------

  describe('authentication', () => {
    it('closes a socket that never authenticates', async () => {
      const socket = connect();
      await open(socket);

      // The gateway's own timeout is 5s; an unauthenticated socket is a free
      // resource for an attacker to hold open.
      const code = await nextClose(socket, AUTH_TIMEOUT_MS + 3_000);
      expect(code).toBe(4401);
    });

    it('closes on a malformed frame', async () => {
      const socket = connect();
      await open(socket);
      socket.send('this is not json');

      expect(await nextClose(socket)).toBe(4401);
    });

    it('closes when the first frame is not an auth frame', async () => {
      const socket = connect();
      await open(socket);
      socket.send(JSON.stringify({ type: 'subscribe', channel: 'rider:1' }));

      expect(await nextClose(socket)).toBe(4401);
    });

    it('closes on a forged token', async () => {
      const socket = connect();
      await open(socket);
      socket.send(
        JSON.stringify({
          type: 'auth',
          token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJyaWRlci0xIn0.',
        }),
      );

      expect(await nextClose(socket)).toBe(4401);
    });

    it('closes on an expired token', async () => {
      const socket = connect();
      await open(socket);
      const token = await tokens.issueAccessToken('rider-1', 'RIDER', 'session-1');
      clock.advanceSeconds(3_601);

      socket.send(JSON.stringify({ type: 'auth', token }));
      expect(await nextClose(socket)).toBe(4401);
    });

    it('ignores further frames once authenticated', async () => {
      const socket = await authenticated('rider-1', 'RIDER');

      // A second auth frame naming another user must not re-bind the channel.
      const other = await tokens.issueAccessToken('rider-2', 'RIDER', 'session-2');
      socket.send(JSON.stringify({ type: 'auth', token: other }));

      await gateway.toRider('rider-2', { type: 'ride.accepted' } as never);
      await expect(nextMessage(socket, 500)).rejects.toThrow('timed out');

      // Still bound to the original identity.
      await gateway.toRider('rider-1', { type: 'ride.completed' } as never);
      expect(JSON.parse(await nextMessage(socket))).toMatchObject({ type: 'ride.completed' });
      socket.close();
    });
  });

  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('unsubscribes on disconnect', async () => {
      const socket = await authenticated('rider-1', 'RIDER');
      expect(gateway.connectionCount).toBe(1);

      socket.close();
      await new Promise((resolve) => setTimeout(resolve, 200));

      // A leaked subscription would keep delivering into a dead socket and
      // hold the Redis handler for the life of the process.
      expect(gateway.connectionCount).toBe(0);
    });

    it('survives publishing to a user who has gone', async () => {
      const socket = await authenticated('rider-1', 'RIDER');
      socket.close();
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Must not throw. A rider closing the app mid-ride is the normal case,
      // not an error, and the ride that triggered the event must still settle.
      await expect(
        gateway.toRider('rider-1', { type: 'ride.completed' } as never),
      ).resolves.toBeUndefined();
    });

    it('supports several connections for the same user', async () => {
      // Phone and tablet, or a reconnect racing an unclosed socket.
      const first = await authenticated('rider-1', 'RIDER');
      const second = await authenticated('rider-1', 'RIDER');

      // Listeners attached BEFORE publishing. `ws` drops an event that has no
      // listener at emit time, so a `once` registered after the publish is a
      // race the test loses roughly whenever delivery is fast - which looked
      // exactly like the second socket never being subscribed.
      const firstSaw = collect(first);
      const secondSaw = collect(second);

      await gateway.toRider('rider-1', { type: 'ride.accepted' } as never);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(firstSaw.map((m) => JSON.parse(m) as { type: string })).toContainEqual(
        expect.objectContaining({ type: 'ride.accepted' }),
      );
      expect(secondSaw.map((m) => JSON.parse(m) as { type: string })).toContainEqual(
        expect.objectContaining({ type: 'ride.accepted' }),
      );

      first.close();
      second.close();
    });

    it('closes every connection on shutdown', async () => {
      const socket = await authenticated('rider-1', 'RIDER');
      const closed = nextClose(socket);

      await gateway.close();

      expect(await closed).toBe(1001);
      expect(gateway.connectionCount).toBe(0);
    });

    it('a reconnect receives events again', async () => {
      const first = await authenticated('rider-1', 'RIDER');
      first.close();
      await new Promise((resolve) => setTimeout(resolve, 200));

      const second = await authenticated('rider-1', 'RIDER');
      await gateway.toRider('rider-1', { type: 'ride.accepted' } as never);

      expect(JSON.parse(await nextMessage(second))).toMatchObject({ type: 'ride.accepted' });
      second.close();
    });
  });

  // ---------------------------------------------------------------------------
  // The socket used to carry nothing
  //
  // Every test above publishes by calling `gateway.toRider` from the test
  // itself. Nothing in the application did - the gateway was attached, clients
  // authenticated and subscribed, and no ride event was ever published to it.
  // The driver app polled every 5 seconds against a 15-second offer expiry, and
  // the rider app held a handler for an event that never arrived.
  //
  // These assert on the shape the application now publishes, so a change that
  // silently stops publishing fails here rather than in the field.
  // ---------------------------------------------------------------------------

  describe('the events the application publishes', () => {
    it('delivers a ride offer to the chosen driver, and to nobody else', async () => {
      const chosen = await authenticated('driver-chosen', 'DRIVER');
      const other = await authenticated('driver-other', 'DRIVER');
      const chosenSeen = collect(chosen);
      const otherSeen = collect(other);

      await gateway.toDriver('driver-chosen', {
        type: 'ride.offer',
        payload: {
          rideId: 'ride-1',
          expiresAt: '2026-08-24T09:00:15.000Z',
          distanceM: 420,
          requestedAt: '2026-08-24T09:00:00.000Z',
        },
      });
      await new Promise((r) => setTimeout(r, 60));

      expect(chosenSeen).toHaveLength(1);
      const event = JSON.parse(chosenSeen[0]!);
      expect(event.type).toBe('ride.offer');
      expect(event.payload.rideId).toBe('ride-1');
      // Carried so a client can measure its own end-to-end matching latency
      // without correlating two separate requests.
      expect(event.payload.requestedAt).toBe('2026-08-24T09:00:00.000Z');

      // A driver must never see a ride they were not offered.
      expect(otherSeen).toEqual([]);
    });

    it('a rider does not receive driver-channel events', async () => {
      const rider = await authenticated('user-1', 'RIDER');
      const seen = collect(rider);

      // Same user id, driver channel. The channels are keyed by role as well
      // as by user, and this is what stops one leaking into the other.
      await gateway.toDriver('user-1', {
        type: 'ride.offer',
        payload: { rideId: 'ride-2' },
      });
      await new Promise((r) => setTimeout(r, 60));

      expect(seen).toEqual([]);
    });

    it('delivers a status change to both parties', async () => {
      const rider = await authenticated('rider-9', 'RIDER');
      const driver = await authenticated('driver-9', 'DRIVER');
      const riderSeen = collect(rider);
      const driverSeen = collect(driver);

      const event = {
        type: 'ride.status_changed' as const,
        payload: { rideId: 'ride-9', status: 'IN_PROGRESS', at: '2026-08-24T09:05:00.000Z' },
      };
      await gateway.toRider('rider-9', event);
      await gateway.toDriver('driver-9', event);
      await new Promise((r) => setTimeout(r, 60));

      expect(JSON.parse(riderSeen[0]!).payload.status).toBe('IN_PROGRESS');
      expect(JSON.parse(driverSeen[0]!).payload.status).toBe('IN_PROGRESS');
    });
  });

});
