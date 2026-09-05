import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { FakeFirebaseVerifier } from '../../src/auth/firebase-verifier.js';
import { ConfigSchema } from '../../src/common/config.js';
import { AuthGuard } from '../../src/http/auth.guard.js';
import { ProblemFilter } from '../../src/http/problem.filter.js';
import type { PgDatabase } from '../../src/db/pg-database.js';
import {
  assertRealDatabase,
  assertRealRedis,
  createRealDatabase,
  createRealRedis,
  isRealInfraRequested,
  realDatabaseUrl,
  truncateAll,
  type RealRedis,
} from '../support/real-infra.js';

/**
 * The same disconnect scenarios, driven through the real application.
 *
 * ## Why this exists alongside `real-reconnect-duplicate.test.ts`
 *
 * That file reproduces `acceptRide`'s guards - the Redis claim outside, the
 * `status = 'PENDING'` offer check and the state machine inside one
 * `FOR UPDATE` - and asserts them against the real services. Deleting the
 * PENDING guard from it does fail two of its tests, so it is load-bearing.
 *
 * But it is load-bearing over a REPRODUCTION. It proves my copy of the guards
 * is self-consistent; it cannot notice if `RideService.acceptRide` stops
 * matching the copy. A test that would keep passing while the shipped code
 * regressed is the exact failure mode this project has hit before - four
 * components were unit-tested and never connected to anything.
 *
 * So this drives the real thing: real HTTP, the real controller, the real
 * `RideService`, the real `MatchingService`, and the real
 * `GET /driver/offers/current` the app resyncs against - all on PostgreSQL
 * 17.11 and Redis 8.0.5. No guard is restated here. If a guard moves, these
 * fail.
 *
 * The one fake is the Firebase verifier, because minting genuine Firebase ID
 * tokens needs the live project and a handset. Everything downstream of the
 * token is real.
 */

const RUN = isRealInfraRequested();
const describeReal = RUN ? describe : describe.skip;

const RIDER_PHONE = '+9647700000001';
const DRIVER_A_PHONE = '+9647700000002';
const DRIVER_B_PHONE = '+9647700000003';

const TAHRIR = { lat: 33.3061, lng: 44.4213 };
const KARRADA = { lat: 33.2989, lng: 44.4361 };

describeReal('disconnect and retry, through the real application', () => {
  let app: NestExpressApplication;
  let db: PgDatabase;
  let redis: RealRedis;
  let firebase: FakeFirebaseVerifier;
  let http: request.Agent;

  let driverAId: string;
  let driverBId: string;

  beforeAll(async () => {
    db = createRealDatabase(10);
    redis = createRealRedis();
    assertRealDatabase(db);
    assertRealRedis(redis.adapter);

    firebase = new FakeFirebaseVerifier();
    firebase.register('rider-token', { uid: 'fb-rider', phoneNumber: RIDER_PHONE });
    firebase.register('driver-a-token', { uid: 'fb-driver-a', phoneNumber: DRIVER_A_PHONE });
    firebase.register('driver-b-token', { uid: 'fb-driver-b', phoneNumber: DRIVER_B_PHONE });

    const config = ConfigSchema.parse({
      NODE_ENV: 'test',
      DATABASE_URL: realDatabaseUrl(),
      REDIS_URL: 'redis://127.0.0.1:6380',
      FIREBASE_PROJECT_ID: 'test-project',
      JWT_SECRET: 'a-test-secret-that-is-long-enough-32',
    });

    app = await NestFactory.create<NestExpressApplication>(
      AppModule.forRoot({ config, database: db, redis: redis.adapter, firebase }),
      { logger: false, bodyParser: false, abortOnError: false },
    );
    app.use(express.json({ limit: '256kb' }));
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new ProblemFilter());
    app.useGlobalGuards(app.get(AuthGuard));

    await app.init();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
    await redis.close();
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await redis.flush();

    await db.query(
      `INSERT INTO platform_config (key, value) VALUES
         ('commission_bps','0'), ('fare_base_iqd','2000'), ('fare_per_km_iqd','500'),
         ('fare_per_minute_iqd','50'), ('fare_minimum_iqd','3000'),
         ('fare_rounding_iqd','250'), ('offer_timeout_seconds','15'),
         ('search_radius_meters','5000'), ('required_driver_documents','')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );

    // The driver profile must exist before sign-in: `/auth/otp/verify` matches
    // an existing user on the phone number in the token.
    driverAId = randomUUID();
    driverBId = randomUUID();
    await db.query(
      `INSERT INTO users (id, role, phone_e164, display_name)
       VALUES ($1,'DRIVER',$3,'سائق أ'), ($2,'DRIVER',$4,'سائق ب')`,
      [driverAId, driverBId, DRIVER_A_PHONE, DRIVER_B_PHONE],
    );
    await db.query(
      `INSERT INTO drivers (user_id, vehicle_plate, vehicle_model, vehicle_color)
       VALUES ($1,'11111','Corolla','أبيض'), ($2,'22222','Corolla','أسود')`,
      [driverAId, driverBId],
    );
  });

  // -------------------------------------------------------------------------

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function signIn(token: string, role: 'RIDER' | 'DRIVER'): Promise<string> {
    const response = await http
      .post('/v1/auth/otp/verify')
      .send({ firebaseIdToken: token, role, displayName: 'مستخدم' })
      .expect(200);
    return response.body.accessToken;
  }

  async function goOnline(token: string, position: { lat: number; lng: number }): Promise<void> {
    await http
      .put('/v1/driver/availability')
      .set(auth(token))
      .send({ availability: 'ONLINE', position })
      .expect(200);
  }

  async function requestRide(riderToken: string): Promise<string> {
    const created = await http
      .post('/v1/rides')
      .set(auth(riderToken))
      .set('Idempotency-Key', randomUUID())
      .send({ pickup: TAHRIR, dropoff: KARRADA })
      .expect(201);
    return created.body.id;
  }

  /** The real matcher, not a hand-picked driver. */
  async function dispatch(rideId: string): Promise<{ outcome: string; driverId?: string }> {
    const matching = app.get(
      (await import('../../src/matching/matching.service.js')).MatchingService,
    );
    return matching.dispatch(rideId);
  }

  // -------------------------------------------------------------------------
  // The binding. This is the D3 assertion, minus the handset.
  // -------------------------------------------------------------------------

  it('offers the ride that was requested to the driver that was chosen', async () => {
    const riderToken = await signIn('rider-token', 'RIDER');
    const driverToken = await signIn('driver-a-token', 'DRIVER');
    await goOnline(driverToken, KARRADA);

    const rideId = await requestRide(riderToken);
    const result = await dispatch(rideId);
    expect(result.outcome).toBe('OFFERED');

    // Not "an offer arrived". The offer row must name THIS ride and THIS
    // driver, and the resync endpoint the app calls must return the same ids.
    const offer = await db.query<{ ride_id: string; driver_id: string }>(
      `SELECT ride_id, driver_id FROM ride_offers WHERE status='PENDING'`,
    );
    expect(offer.rows).toHaveLength(1);
    expect(offer.rows[0]!.ride_id).toBe(rideId);
    expect(offer.rows[0]!.driver_id).toBe(result.driverId);
    expect(result.driverId).toBe(driverAId);

    const resynced = await http
      .get('/v1/driver/offers/current')
      .set(auth(driverToken))
      .expect(200);
    expect(resynced.body.rideId).toBe(rideId);
  });

  // -------------------------------------------------------------------------
  // Reconnect and resync
  // -------------------------------------------------------------------------

  it('resyncs to the same single offer however many times the app asks', async () => {
    const riderToken = await signIn('rider-token', 'RIDER');
    const driverToken = await signIn('driver-a-token', 'DRIVER');
    await goOnline(driverToken, KARRADA);

    const rideId = await requestRide(riderToken);
    await dispatch(rideId);

    // A flapping connection asks three times. Each answer must be the same
    // offer, and no answer may create another one.
    const seen: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await http
        .get('/v1/driver/offers/current')
        .set(auth(driverToken))
        .expect(200);
      seen.push(response.body.offerId);
      expect(response.body.rideId).toBe(rideId);
    }

    expect(new Set(seen).size).toBe(1);
    expect(
      (await db.query(`SELECT id FROM ride_offers WHERE ride_id=$1`, [rideId])).rows,
    ).toHaveLength(1);
  });

  it('stops offering once the offer is answered', async () => {
    const riderToken = await signIn('rider-token', 'RIDER');
    const driverToken = await signIn('driver-a-token', 'DRIVER');
    await goOnline(driverToken, KARRADA);

    const rideId = await requestRide(riderToken);
    await dispatch(rideId);

    await http.post(`/v1/rides/${rideId}/accept`).set(auth(driverToken)).expect(200);

    // 204, not the same offer again. An app that resyncs after accepting must
    // not be handed the offer sheet a second time.
    await http.get('/v1/driver/offers/current').set(auth(driverToken)).expect(204);
  });

  // -------------------------------------------------------------------------
  // One winner
  // -------------------------------------------------------------------------

  it('refuses the retry when the app accepts again after reconnecting', async () => {
    const riderToken = await signIn('rider-token', 'RIDER');
    const driverToken = await signIn('driver-a-token', 'DRIVER');
    await goOnline(driverToken, KARRADA);

    const rideId = await requestRide(riderToken);
    await dispatch(rideId);

    await http.post(`/v1/rides/${rideId}/accept`).set(auth(driverToken)).expect(200);

    // The reply to the first accept was lost with the connection, so the app
    // sends it again. It must not succeed twice, and it must not 500.
    const retry = await http.post(`/v1/rides/${rideId}/accept`).set(auth(driverToken));
    expect([404, 409]).toContain(retry.status);

    const ride = await db.query<{ status: string; driver_id: string }>(
      `SELECT status, driver_id FROM rides WHERE id=$1`,
      [rideId],
    );
    expect(ride.rows[0]!.status).toBe('ACCEPTED');
    expect(ride.rows[0]!.driver_id).toBe(driverAId);
  });

  it('lets exactly one driver win a simultaneous accept', async () => {
    const riderToken = await signIn('rider-token', 'RIDER');
    const tokenA = await signIn('driver-a-token', 'DRIVER');
    const tokenB = await signIn('driver-b-token', 'DRIVER');
    await goOnline(tokenA, KARRADA);
    await goOnline(tokenB, { lat: 33.3, lng: 44.43 });

    const rideId = await requestRide(riderToken);
    await dispatch(rideId);

    // Driver A dropped off the network, so the ride was re-offered to B while
    // A still had the sheet on screen. Both tap accept at once.
    await db.query(
      `INSERT INTO ride_offers (ride_id, driver_id, status, distance_m, expires_at)
       VALUES ($1, $2, 'PENDING', 420, now() + interval '60 seconds')
       ON CONFLICT (ride_id, driver_id) DO NOTHING`,
      [rideId, driverBId],
    );

    const [first, second] = await Promise.all([
      http.post(`/v1/rides/${rideId}/accept`).set(auth(tokenA)),
      http.post(`/v1/rides/${rideId}/accept`).set(auth(tokenB)),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    // The loser gets a refusal, never a 500.
    expect(statuses.some((s) => s === 404 || s === 409)).toBe(true);

    const ride = await db.query<{ status: string; driver_id: string }>(
      `SELECT status, driver_id FROM rides WHERE id=$1`,
      [rideId],
    );
    expect(ride.rows[0]!.status).toBe('ACCEPTED');
    expect([driverAId, driverBId]).toContain(ride.rows[0]!.driver_id);

    // Exactly one accepted offer, and it belongs to the driver who holds the
    // ride. Two would be two drivers told they won.
    const accepted = await db.query<{ driver_id: string }>(
      `SELECT driver_id FROM ride_offers WHERE ride_id=$1 AND status='ACCEPTED'`,
      [rideId],
    );
    expect(accepted.rows).toHaveLength(1);
    expect(accepted.rows[0]!.driver_id).toBe(ride.rows[0]!.driver_id);
  });

  // -------------------------------------------------------------------------
  // Offers that arrive too late
  // -------------------------------------------------------------------------

  it('refuses an accept for a ride that is already finished', async () => {
    const riderToken = await signIn('rider-token', 'RIDER');
    const tokenA = await signIn('driver-a-token', 'DRIVER');
    const tokenB = await signIn('driver-b-token', 'DRIVER');
    await goOnline(tokenA, KARRADA);

    const rideId = await requestRide(riderToken);
    await dispatch(rideId);
    await http.post(`/v1/rides/${rideId}/accept`).set(auth(tokenA)).expect(200);
    await http.post(`/v1/rides/${rideId}/arrived`).set(auth(tokenA)).expect(200);
    await http.post(`/v1/rides/${rideId}/start`).set(auth(tokenA)).expect(200);
    await http
      .post(`/v1/rides/${rideId}/complete`)
      .set(auth(tokenA))
      .send({ finalFareIqd: 5000 })
      .expect(200);

    // Driver B reconnects still holding a stale offer sheet for this ride.
    await db.query(
      `INSERT INTO ride_offers (ride_id, driver_id, status, distance_m, expires_at)
       VALUES ($1, $2, 'PENDING', 420, now() + interval '60 seconds')
       ON CONFLICT (ride_id, driver_id) DO NOTHING`,
      [rideId, driverBId],
    );

    const late = await http.post(`/v1/rides/${rideId}/accept`).set(auth(tokenB));
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(late.status).toBeLessThan(500);

    const ride = await db.query<{ status: string; driver_id: string }>(
      `SELECT status, driver_id FROM rides WHERE id=$1`,
      [rideId],
    );
    expect(ride.rows[0]!.status).toBe('COMPLETED');
    expect(ride.rows[0]!.driver_id).toBe(driverAId);
  });

  it('never hands a driver an offer that belongs to somebody else', async () => {
    const riderToken = await signIn('rider-token', 'RIDER');
    const tokenA = await signIn('driver-a-token', 'DRIVER');
    const tokenB = await signIn('driver-b-token', 'DRIVER');
    await goOnline(tokenA, KARRADA);

    const rideId = await requestRide(riderToken);
    const result = await dispatch(rideId);
    expect(result.driverId).toBe(driverAId);

    // B was never offered this ride. Resync must tell them nothing, and accept
    // must refuse - a driver who was not offered a ride is not entitled to
    // learn that it exists.
    await http.get('/v1/driver/offers/current').set(auth(tokenB)).expect(204);
    const stolen = await http.post(`/v1/rides/${rideId}/accept`).set(auth(tokenB));
    expect([403, 404, 409]).toContain(stolen.status);

    const ride = await db.query<{ status: string }>(
      `SELECT status FROM rides WHERE id=$1`,
      [rideId],
    );
    expect(ride.rows[0]!.status).toBe('OFFERED');
  });
});
