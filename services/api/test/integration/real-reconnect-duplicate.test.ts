import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { TokenService } from '../../src/auth/token.service.js';
import { SystemClock } from '../../src/common/clock.js';
import { isUniqueViolationOn } from '../../src/db/db.port.js';
import type { PgDatabase } from '../../src/db/pg-database.js';
import { RideClaimService } from '../../src/matching/ride-claim.service.js';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway.js';
import { RideStateMachine } from '../../src/rides/ride-state-machine.js';
import {
  assertRealDatabase,
  assertRealRedis,
  createRealDatabase,
  createRealRedis,
  isRealInfraRequested,
  truncateAll,
  type RealRedis,
} from '../support/real-infra.js';

/**
 * What survives a driver dropping off the network mid-offer.
 *
 * ## Why this is not already covered
 *
 * `realtime.e2e.test.ts` has a test called "a reconnect receives events again".
 * It proves the TRANSPORT recovers: close a socket, open another, publish, and
 * the frame arrives. That is worth having and it is not this.
 *
 * It says nothing about the state left behind by the disconnect. A driver on a
 * Baghdad mobile network drops constantly, and each drop happens at some point
 * in a sequence that has already written rows:
 *
 *   offer written  ->  socket dies  ->  app reopens  ->  app asks "what now?"
 *
 * The questions that decides are all domain questions, not socket questions.
 * Does the resync hand back the same offer, or a second one? Can the ride now
 * be won twice - once by the driver who reconnected and once by whoever it was
 * re-offered to while they were away? Can an offer the app was still holding on
 * screen be accepted after the ride has already been completed by someone else?
 *
 * Every one of those is a duplicate-dispatch or a double-paid ride, and none of
 * them is reachable from a test whose only fake is the socket.
 *
 * ## Why real infrastructure
 *
 * Three of the guarantees below do not exist anywhere except in the real
 * services, so asserting them against the fakes would prove nothing:
 *
 *   - `ride_offers_ride_driver_uq` is a PostgreSQL constraint. It is the thing
 *     that makes a duplicate offer row impossible; the fake does not enforce it.
 *   - `SET NX PX` serialising a stampede is a real-Redis property. The fake has
 *     diverged from real Redis before in this project.
 *   - Concurrent transaction visibility is exactly where `FakeDatabase` is
 *     known to be wrong (D-15: a rollback restores a snapshot and erases a
 *     committed write).
 *
 * So these run only under `REAL_INFRA=1`, and `assertReal*` fails the run
 * rather than letting it quietly report green against a fake.
 */

const RUN = isRealInfraRequested();
const describeReal = RUN ? describe : describe.skip;

const SECRET = 'a-test-secret-that-is-long-enough-32';

// Fixed ids so a failure names a row instead of a UUID nobody can look up.
const RIDER = '11111111-1111-4111-8111-111111111111';
const DRIVER_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const DRIVER_B = 'bbbbbbbb-1111-4111-8111-111111111111';

describeReal('a driver who drops off the network mid-offer', () => {
  let db: PgDatabase;
  let redis: RealRedis;
  let gateway: RealtimeGateway;
  let claims: RideClaimService;
  let machine: RideStateMachine;
  let tokens: TokenService;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    db = createRealDatabase(10);
    redis = createRealRedis();
    // If this run is not actually against the real services, fail here rather
    // than report a green suite that proved none of the above.
    assertRealDatabase(db);
    assertRealRedis(redis.adapter);

    const clock = new SystemClock();
    tokens = new TokenService(SECRET, clock, 3_600, 2_592_000);
    claims = new RideClaimService(redis.adapter, 30_000);
    machine = new RideStateMachine();

    gateway = new RealtimeGateway(tokens, redis.adapter);
    server = createServer();
    gateway.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterAll(async () => {
    await gateway.close();
    await redis.close();
    await db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    await truncateAll(db);
    await redis.flush();

    await db.query(
      `INSERT INTO users (id, role, phone_e164, display_name)
       VALUES ($1,'RIDER','+9647700000001','راكب'),
              ($2,'DRIVER','+9647700000002','سائق أ'),
              ($3,'DRIVER','+9647700000003','سائق ب')`,
      [RIDER, DRIVER_A, DRIVER_B],
    );
    await db.query(`INSERT INTO riders (user_id) VALUES ($1)`, [RIDER]);
    await db.query(
      `INSERT INTO drivers (user_id, vehicle_plate, vehicle_model, vehicle_color)
       VALUES ($1,'11111','Corolla','أبيض'), ($2,'22222','Corolla','أسود')`,
      [DRIVER_A, DRIVER_B],
    );
  });

  afterEach(() => {
    // A leaked socket keeps the gateway's connection map populated and makes
    // the next test's "who received it" assertion meaningless.
    for (const socket of sockets.splice(0)) {
      if (socket.readyState === WebSocket.OPEN) socket.close();
    }
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function createRide(status = 'OFFERED'): Promise<string> {
    const completed = status === 'COMPLETED';
    const result = await db.query<{ id: string }>(
      `INSERT INTO rides
         (rider_id, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
          estimated_fare_iqd, estimated_distance_m, estimated_duration_s,
          driver_id, final_fare_iqd, commission_iqd, accepted_at, started_at, completed_at)
       VALUES ($1, $2::ride_status, 33.3061, 44.4213, 33.2989, 44.4361, 5000, 1500, 300,
               $3, $4, $5, $6, $6, $6)
       RETURNING id`,
      [
        RIDER,
        status,
        completed ? DRIVER_A : null,
        completed ? 5000 : null,
        completed ? 0 : null,
        completed ? new Date() : null,
      ],
    );
    return result.rows[0]!.id;
  }

  /** One PENDING offer, expiring far enough out that nothing expires mid-test. */
  async function offerTo(
    rideId: string,
    driverId: string,
    { expiresInMs = 60_000, status = 'PENDING' } = {},
  ): Promise<string> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO ride_offers (ride_id, driver_id, status, distance_m, expires_at)
       VALUES ($1, $2, $3::offer_status, 420, now() + ($4 || ' milliseconds')::interval)
       RETURNING id`,
      [rideId, driverId, status, String(expiresInMs)],
    );
    return result.rows[0]!.id;
  }

  /**
   * The query the driver app's resync actually runs.
   *
   * Copied from `driver.controller.ts`'s `GET /driver/offers/current` rather
   * than paraphrased: if that guard changes, this must fail, and a paraphrase
   * would keep passing.
   */
  function resync(rideId: string, driverId: string) {
    return db.query<{ id: string; distance_m: number }>(
      `SELECT id, distance_m, expires_at FROM ride_offers
        WHERE ride_id = $1 AND driver_id = $2 AND status = 'PENDING'`,
      [rideId, driverId],
    );
  }

  async function authenticated(userId: string, role: 'DRIVER' | 'RIDER'): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime`);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    const token = await tokens.issueAccessToken(userId, role, `session-${userId}`);
    socket.send(JSON.stringify({ type: 'auth', token }));

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('never became ready')), 3_000);
      socket.once('message', (data: Buffer) => {
        clearTimeout(timer);
        expect(JSON.parse(data.toString('utf8'))).toEqual({ type: 'ready' });
        resolve();
      });
    });
    return socket;
  }

  /** Buffer every frame from now on - `once` would drop one already in flight. */
  function collect(socket: WebSocket): string[] {
    const seen: string[] = [];
    socket.on('message', (data: Buffer) => seen.push(data.toString('utf8')));
    return seen;
  }

  const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

  const offerEvent = (rideId: string) =>
    ({
      type: 'ride.offer',
      payload: { rideId, expiresAt: new Date(Date.now() + 60_000).toISOString(), distanceM: 420 },
    }) as never;

  /**
   * `acceptRide`'s two real guards, in one transaction, exactly as the service
   * orders them: the Redis claim on the outside, then the PENDING-offer check
   * and the state machine inside a single `FOR UPDATE`.
   *
   * The full `RideService.acceptRide` needs the whole DI graph. What matters
   * for every scenario below is which guard rejects a stale or duplicate
   * accept, so this reproduces the guards against the real services and leaves
   * the wiring to the e2e suite.
   */
  async function accept(rideId: string, driverId: string): Promise<'ACCEPTED'> {
    return claims.withClaim(rideId, driverId, () =>
      db.transaction(async (tx) => {
        const ride = await tx.query<{ status: string; driver_id: string | null }>(
          `SELECT status, driver_id FROM rides WHERE id = $1 FOR UPDATE`,
          [rideId],
        );
        const current = ride.rows[0];
        if (!current) throw new Error('NO_RIDE');

        // The offer must still be PENDING and must belong to this driver.
        const offer = await tx.query(
          `SELECT driver_id FROM ride_offers
            WHERE ride_id = $1 AND driver_id = $2 AND status = 'PENDING'
            LIMIT 1`,
          [rideId, driverId],
        );
        if (offer.rows.length === 0) throw new Error('NO_PENDING_OFFER');

        // Throws InvalidRideTransitionError for anything that is not a legal
        // move from the ride's current state.
        machine.validate({
          ride: { ...current, id: rideId, status: current.status, driverId },
          to: 'ACCEPTED',
          actor: { type: 'DRIVER', id: driverId },
        } as never);

        const updated = await tx.query(
          `UPDATE rides SET status='ACCEPTED', driver_id=$2, accepted_at=now()
            WHERE id=$1 AND status='OFFERED'`,
          [rideId, driverId],
        );
        if (updated.rowCount !== 1) throw new Error('LOST_THE_RACE');

        await tx.query(
          `UPDATE ride_offers SET status='ACCEPTED', responded_at=now()
            WHERE ride_id=$1 AND driver_id=$2`,
          [rideId, driverId],
        );
        return 'ACCEPTED' as const;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Reconnect and resync
  // -------------------------------------------------------------------------

  describe('reconnect and resync', () => {
    it('hands back the one offer it already had, not a second one', async () => {
      const rideId = await createRide();
      const offerId = await offerTo(rideId, DRIVER_A);

      const first = await authenticated(DRIVER_A, 'DRIVER');
      await gateway.toDriver(DRIVER_A, offerEvent(rideId));
      await settle();
      first.close();
      await settle();

      // Reconnect, then ask the server what is outstanding.
      await authenticated(DRIVER_A, 'DRIVER');
      const outstanding = await resync(rideId, DRIVER_A);

      expect(outstanding.rows).toHaveLength(1);
      expect(outstanding.rows[0]!.id).toBe(offerId);
    });

    it('cannot write a second offer row for the same ride and driver', async () => {
      const rideId = await createRide();
      await offerTo(rideId, DRIVER_A);

      // This is what a re-dispatch after a disconnect would attempt. The
      // constraint is the reason a duplicate offer is impossible rather than
      // merely unlikely, so it is asserted directly.
      let violated = false;
      try {
        await offerTo(rideId, DRIVER_A);
      } catch (error) {
        violated = isUniqueViolationOn(error, 'ride_offers_ride_driver_uq');
      }

      expect(violated).toBe(true);
      const rows = await db.query(
        `SELECT id FROM ride_offers WHERE ride_id=$1 AND driver_id=$2`,
        [rideId, DRIVER_A],
      );
      expect(rows.rows).toHaveLength(1);
    });

    it('delivers the offer once to the live socket and never to the dead one', async () => {
      const rideId = await createRide();
      await offerTo(rideId, DRIVER_A);

      const dead = await authenticated(DRIVER_A, 'DRIVER');
      const deadSaw = collect(dead);
      dead.close();
      await settle();

      const live = await authenticated(DRIVER_A, 'DRIVER');
      const liveSaw = collect(live);

      await gateway.toDriver(DRIVER_A, offerEvent(rideId));
      await settle();

      // Exactly one copy. Two would be a duplicate offer sheet on the driver's
      // screen, which is how a driver ends up accepting the same ride twice.
      const offers = liveSaw.filter((frame) => JSON.parse(frame).type === 'ride.offer');
      expect(offers).toHaveLength(1);
      expect(JSON.parse(offers[0]!).payload.rideId).toBe(rideId);
      expect(deadSaw).toHaveLength(0);
    });

    it('does not double up when the app reconnects twice in a row', async () => {
      const rideId = await createRide();
      await offerTo(rideId, DRIVER_A);

      // A flapping network: connect, drop, connect, drop, connect.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const socket = await authenticated(DRIVER_A, 'DRIVER');
        await settle(50);
        socket.close();
        await settle(50);
      }
      const final = await authenticated(DRIVER_A, 'DRIVER');
      const saw = collect(final);

      await gateway.toDriver(DRIVER_A, offerEvent(rideId));
      await settle();

      expect(saw.filter((f) => JSON.parse(f).type === 'ride.offer')).toHaveLength(1);
      expect((await resync(rideId, DRIVER_A)).rows).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // One winner, across the disconnect
  // -------------------------------------------------------------------------

  describe('one winner', () => {
    it('refuses the second accept when the app retries after reconnecting', async () => {
      const rideId = await createRide();
      await offerTo(rideId, DRIVER_A);

      // The everyday version: the driver taps accept, the reply is lost with
      // the connection, the app reconnects and sends it again.
      await expect(accept(rideId, DRIVER_A)).resolves.toBe('ACCEPTED');
      await expect(accept(rideId, DRIVER_A)).rejects.toThrow(/NO_PENDING_OFFER/);

      // Note which guard caught it. The Redis claim did NOT: re-claiming a ride
      // you already hold is deliberately treated as acquired, so a same-driver
      // retry passes straight through it. The offer no longer being PENDING is
      // what makes the retry safe, and that is worth pinning down - a change
      // that moved the offer update out of the transaction would break this
      // and nothing else would notice.
      const ride = await db.query<{ status: string; driver_id: string }>(
        `SELECT status, driver_id FROM rides WHERE id=$1`,
        [rideId],
      );
      expect(ride.rows[0]!.status).toBe('ACCEPTED');
      expect(ride.rows[0]!.driver_id).toBe(DRIVER_A);
    });

    it('lets exactly one of two drivers win when both hold a pending offer', async () => {
      const rideId = await createRide();
      // Both offers exist at once: driver A was offered the ride, dropped off
      // the network, and it was re-offered to driver B before A came back.
      await offerTo(rideId, DRIVER_A);
      await offerTo(rideId, DRIVER_B);

      const results = await Promise.allSettled([
        accept(rideId, DRIVER_A),
        accept(rideId, DRIVER_B),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

      const ride = await db.query<{ status: string; driver_id: string }>(
        `SELECT status, driver_id FROM rides WHERE id=$1`,
        [rideId],
      );
      expect(ride.rows[0]!.status).toBe('ACCEPTED');
      expect([DRIVER_A, DRIVER_B]).toContain(ride.rows[0]!.driver_id);

      // And the loser's offer is not left PENDING, which would let them accept
      // a ride that already has a driver.
      const accepted = await db.query(
        `SELECT driver_id FROM ride_offers WHERE ride_id=$1 AND status='ACCEPTED'`,
        [rideId],
      );
      expect(accepted.rows).toHaveLength(1);
      expect(accepted.rows[0]!.driver_id).toBe(ride.rows[0]!.driver_id);
    });

    it('still allows one winner under a stampede of reconnecting drivers', async () => {
      // Twenty rounds, because a race that passes once has been shown to be
      // lucky, not safe.
      for (let round = 0; round < 20; round += 1) {
        await db.query(`DELETE FROM ride_offers`);
        await db.query(`DELETE FROM ride_events`);
        await db.query(`DELETE FROM rides`);
        await redis.flush();

        const rideId = await createRide();
        await offerTo(rideId, DRIVER_A);
        await offerTo(rideId, DRIVER_B);

        const results = await Promise.allSettled([
          accept(rideId, DRIVER_A),
          accept(rideId, DRIVER_B),
          accept(rideId, DRIVER_A),
          accept(rideId, DRIVER_B),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Offers that arrive too late
  // -------------------------------------------------------------------------

  describe('a stale offer', () => {
    it('cannot be accepted after the ride is completed', async () => {
      const rideId = await createRide('COMPLETED');
      // The offer row is still PENDING: this is the app that was disconnected
      // while the sheet was on screen and the ride finished without it.
      await offerTo(rideId, DRIVER_B);

      await expect(accept(rideId, DRIVER_B)).rejects.toThrow();

      const ride = await db.query<{ status: string; driver_id: string }>(
        `SELECT status, driver_id FROM rides WHERE id=$1`,
        [rideId],
      );
      expect(ride.rows[0]!.status).toBe('COMPLETED');
      expect(ride.rows[0]!.driver_id).toBe(DRIVER_A);
    });

    it('cannot be accepted once it has timed out', async () => {
      const rideId = await createRide();
      await offerTo(rideId, DRIVER_A, { status: 'TIMED_OUT' });

      await expect(accept(rideId, DRIVER_A)).rejects.toThrow(/NO_PENDING_OFFER/);

      const ride = await db.query<{ status: string }>(
        `SELECT status FROM rides WHERE id=$1`,
        [rideId],
      );
      expect(ride.rows[0]!.status).toBe('OFFERED');
    });

    it('cannot be accepted after it was given to somebody else', async () => {
      const rideId = await createRide();
      await offerTo(rideId, DRIVER_A);
      await offerTo(rideId, DRIVER_B);

      await expect(accept(rideId, DRIVER_A)).resolves.toBe('ACCEPTED');

      // Driver B reconnects still holding the sheet and taps accept.
      await expect(accept(rideId, DRIVER_B)).rejects.toThrow();

      const ride = await db.query<{ driver_id: string }>(
        `SELECT driver_id FROM rides WHERE id=$1`,
        [rideId],
      );
      expect(ride.rows[0]!.driver_id).toBe(DRIVER_A);
    });

    it('arriving on the socket after completion changes nothing in the database', async () => {
      const rideId = await createRide('COMPLETED');
      const socket = await authenticated(DRIVER_B, 'DRIVER');
      const saw = collect(socket);

      // A late frame from a queue that was draining while the ride finished.
      await gateway.toDriver(DRIVER_B, offerEvent(rideId));
      await settle();

      // It is delivered - the transport does not know the ride is over - and it
      // is inert. The realtime channel is advisory; the accept path is the only
      // thing that can move a ride, and the test above proves it refuses.
      expect(saw.filter((f) => JSON.parse(f).type === 'ride.offer')).toHaveLength(1);

      const ride = await db.query<{ status: string; driver_id: string }>(
        `SELECT status, driver_id FROM rides WHERE id=$1`,
        [rideId],
      );
      expect(ride.rows[0]!.status).toBe('COMPLETED');
      expect(ride.rows[0]!.driver_id).toBe(DRIVER_A);
      expect(
        (await db.query(`SELECT id FROM ride_offers WHERE ride_id=$1`, [rideId])).rows,
      ).toHaveLength(0);
    });
  });
});
