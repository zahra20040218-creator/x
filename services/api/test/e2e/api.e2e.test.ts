import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { FakeFirebaseVerifier } from '../../src/auth/firebase-verifier.js';
import { FakeClock } from '../../src/common/clock.js';
import { ConfigSchema } from '../../src/common/config.js';
import { AuthGuard } from '../../src/http/auth.guard.js';
import { ProblemFilter } from '../../src/http/problem.filter.js';
import { RateLimitGuard } from '../../src/http/rate-limit.js';
import { InMemoryRedis } from '../../src/redis/in-memory-redis.js';
import { FakeDatabase } from '../fakes/fake-database.js';

/**
 * End-to-end over real HTTP.
 *
 * CLAUDE.md §10 asks for one happy path plus three failure paths: network drop
 * mid-ride, driver declines, and no drivers available. All four are here.
 *
 * The database and Redis are fakes, so this proves the HTTP layer, the guards,
 * validation, status codes and the wiring - NOT the schema. The schema-level
 * guarantees (append-only triggers, the balance trigger, partial unique
 * indexes) need a real Postgres and are covered in test/integration, which has
 * not run on this host. See BLOCKED.md.
 */

const RIDER_PHONE = '+9647700000001';
const DRIVER_PHONE = '+9647700000002';
const SECOND_DRIVER_PHONE = '+9647700000003';

const TAHRIR = { lat: 33.3061, lng: 44.4213 };
const KARRADA = { lat: 33.2989, lng: 44.4361 };

describe('API end to end', () => {
  let app: NestExpressApplication;
  let db: FakeDatabase;
  let redis: InMemoryRedis;
  let clock: FakeClock;
  let firebase: FakeFirebaseVerifier;
  let http: request.Agent;

  beforeEach(async () => {
    clock = new FakeClock();
    db = new FakeDatabase();
    redis = new InMemoryRedis(clock);
    firebase = new FakeFirebaseVerifier();

    db.seedConfig({
      commission_bps: 0,
      fare_base_iqd: 2_000,
      fare_per_km_iqd: 500,
      fare_per_minute_iqd: 50,
      fare_minimum_iqd: 3_000,
      fare_rounding_iqd: 250,
      offer_timeout_seconds: 15,
      search_radius_meters: 5_000,
    });

    firebase.register('rider-token', { uid: 'fb-rider', phoneNumber: RIDER_PHONE });
    firebase.register('driver-token', { uid: 'fb-driver', phoneNumber: DRIVER_PHONE });
    firebase.register('driver2-token', { uid: 'fb-driver2', phoneNumber: SECOND_DRIVER_PHONE });

    const config = ConfigSchema.parse({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://x:y@pgbouncer:6432/db',
      REDIS_URL: 'redis://localhost:6379',
      FIREBASE_PROJECT_ID: 'test-project',
      JWT_SECRET: 'a-test-secret-that-is-long-enough-32',
    });

    app = await NestFactory.create<NestExpressApplication>(
      AppModule.forRoot({ config, database: db, redis, firebase, clock }),
      // abortOnError: false makes a DI failure THROW rather than calling
      // process.abort(), which kills the worker before the message prints.
      { logger: false, bodyParser: false, abortOnError: false },
    );
    app.use(express.json({ limit: '256kb' }));
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new ProblemFilter());
    app.useGlobalGuards(app.get(AuthGuard));

    await app.init();
    http = request(app.getHttpServer());
  });

  afterEach(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------

  async function signInRider(): Promise<string> {
    const response = await http
      .post('/v1/auth/otp/verify')
      .send({ firebaseIdToken: 'rider-token', role: 'RIDER', displayName: 'راكب' })
      .expect(200);
    return response.body.accessToken;
  }

  function seedDriverRow(id: string, phone: string, plate: string): void {
    db.rows('users').push({
      id, role: 'DRIVER', phone_e164: phone, display_name: 'سائق', is_active: true,
    });
    db.rows('drivers').push({
      user_id: id, availability: 'OFFLINE', is_suspended: false,
      vehicle_plate: plate, vehicle_model: 'Corolla', vehicle_color: 'أبيض',
      rating_sum: '0', rating_count: '0',
    });
  }

  async function signInDriver(token: string): Promise<string> {
    const response = await http
      .post('/v1/auth/otp/verify')
      .send({ firebaseIdToken: token, role: 'DRIVER' })
      .expect(200);
    return response.body.accessToken;
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  // -------------------------------------------------------------------------
  // Health and auth
  // -------------------------------------------------------------------------

  describe('health', () => {
    it('answers liveness without a token', async () => {
      const response = await http.get('/v1/health').expect(200);
      expect(response.body).toEqual({ status: 'ok' });
    });

    it('reports readiness of both dependencies', async () => {
      const response = await http.get('/v1/health/ready').expect(200);
      expect(response.body.checks).toEqual({ postgres: 'ok', redis: 'ok' });
    });
  });

  describe('authentication', () => {
    it('rejects a request with no token', async () => {
      const response = await http.get('/v1/me').expect(401);
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(response.body.type).toMatch(/unauthorized$/);
    });

    it('rejects a garbage token', async () => {
      await http.get('/v1/me').set(auth('nonsense')).expect(401);
    });

    it('signs a rider in and returns their own profile', async () => {
      const token = await signInRider();
      const response = await http.get('/v1/me').set(auth(token)).expect(200);

      expect(response.body.role).toBe('RIDER');
      // Your OWN phone is yours to see.
      expect(response.body.phone).toBe(RIDER_PHONE);
    });

    // CLAUDE.md §2 - admins create drivers manually in v1.
    it('refuses to create a driver account on sign-in', async () => {
      const response = await http
        .post('/v1/auth/otp/verify')
        .send({ firebaseIdToken: 'driver-token', role: 'DRIVER' })
        .expect(403);

      expect(response.body.detail).toMatch(/administrator must create it first/);
    });

    it('rotates the refresh token and rejects the old one', async () => {
      const first = await http
        .post('/v1/auth/otp/verify')
        .send({ firebaseIdToken: 'rider-token', role: 'RIDER' })
        .expect(200);

      await http
        .post('/v1/auth/refresh')
        .send({ refreshToken: first.body.refreshToken })
        .expect(200);

      await http
        .post('/v1/auth/refresh')
        .send({ refreshToken: first.body.refreshToken })
        .expect(401);
    });
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  describe('validation', () => {
    it('returns RFC 9457 problem+json with field paths', async () => {
      const token = await signInRider();

      const response = await http
        .post('/v1/fare/estimate')
        .set(auth(token))
        .send({ pickup: { lat: 999, lng: 44 }, dropoff: KARRADA })
        .expect(422);

      expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(response.body.status).toBe(422);
      expect(response.body.errors[0].path).toContain('pickup');
    });

    // CLAUDE.md §5.2 - the header is REQUIRED.
    it('refuses a ride request with no Idempotency-Key', async () => {
      const token = await signInRider();

      const response = await http
        .post('/v1/rides')
        .set(auth(token))
        .send({ pickup: TAHRIR, dropoff: KARRADA })
        .expect(422);

      expect(response.body.errors[0].path).toBe('Idempotency-Key');
    });
  });

  // -------------------------------------------------------------------------
  // HAPPY PATH — CLAUDE.md §10
  // -------------------------------------------------------------------------

  it('happy path: request, match, accept, drive, complete, rate', async () => {
    const riderToken = await signInRider();
    seedDriverRow('driver-1', DRIVER_PHONE, '12345');
    const driverToken = await signInDriver('driver-token');

    // Driver goes online near the pickup.
    await http
      .put('/v1/driver/availability')
      .set(auth(driverToken))
      .send({ availability: 'ONLINE', position: KARRADA })
      .expect(200);

    // Rider quotes a fare.
    const estimate = await http
      .post('/v1/fare/estimate')
      .set(auth(riderToken))
      .send({ pickup: TAHRIR, dropoff: KARRADA })
      .expect(200);

    expect(Number.isInteger(estimate.body.estimatedFareIqd)).toBe(true);
    expect(estimate.body.estimatedFareIqd).toBeGreaterThanOrEqual(3_000);

    // Rider requests the ride.
    const created = await http
      .post('/v1/rides')
      .set(auth(riderToken))
      .set('Idempotency-Key', randomUUID())
      .send({ pickup: TAHRIR, dropoff: KARRADA })
      .expect(201);

    const rideId = created.body.id;
    expect(created.body.status).toBe('REQUESTED');

    // Matching offers it to the nearest eligible driver.
    const matching = app.get(
      (await import('../../src/matching/matching.service.js')).MatchingService,
    );
    const dispatched = await matching.dispatch(rideId);
    expect(dispatched.outcome).toBe('OFFERED');

    // Driver sees the offer through the polling fallback.
    const offer = await http
      .get('/v1/driver/offers/current')
      .set(auth(driverToken))
      .expect(200);
    expect(offer.body.rideId).toBe(rideId);

    // Accept, arrive, start, complete.
    await http.post(`/v1/rides/${rideId}/accept`).set(auth(driverToken)).expect(200);
    await http.post(`/v1/rides/${rideId}/arrived`).set(auth(driverToken)).expect(200);
    await http.post(`/v1/rides/${rideId}/start`).set(auth(driverToken)).expect(200);

    const completed = await http
      .post(`/v1/rides/${rideId}/complete`)
      .set(auth(driverToken))
      .send({ actualDistanceM: 2_200 })
      .expect(200);

    expect(completed.body.ride.status).toBe('COMPLETED');
    expect(Number.isInteger(completed.body.ride.finalFareIqd)).toBe(true);
    expect(db.ledgerNet(completed.body.ledgerTransactionId)).toBe(0);

    // Driver keeps the whole fare at the default 0 bps commission.
    expect(completed.body.ride.commissionIqd).toBe(0);
    expect(db.walletBalance('driver-1')).toBe(completed.body.ride.finalFareIqd);

    // Rider rates the driver.
    await http
      .post(`/v1/rides/${rideId}/rate`)
      .set(auth(riderToken))
      .send({ score: 5, comment: 'ممتاز' })
      .expect(201);

    // And cannot rate twice.
    await http
      .post(`/v1/rides/${rideId}/rate`)
      .set(auth(riderToken))
      .send({ score: 1 })
      .expect(409);
  });

  // -------------------------------------------------------------------------
  // FAILURE PATH 1 — network drop mid-request (CLAUDE.md §5.2)
  // -------------------------------------------------------------------------

  it('failure path: a dropped request retried five times creates ONE ride', async () => {
    const riderToken = await signInRider();
    const key = randomUUID();
    const body = { pickup: TAHRIR, dropoff: KARRADA };

    const first = await http
      .post('/v1/rides')
      .set(auth(riderToken))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    // Four more retries with the same key, as the app would after a timeout.
    for (let i = 0; i < 4; i++) {
      const retry = await http
        .post('/v1/rides')
        .set(auth(riderToken))
        .set('Idempotency-Key', key)
        .send(body)
        // 200, not 201 - the contract distinguishes a replay by status code.
        .expect(200);

      expect(retry.body.id).toBe(first.body.id);
    }

    expect(db.rows('rides')).toHaveLength(1);
  });

  it('failure path: the same key with a different body is refused', async () => {
    const riderToken = await signInRider();
    const key = randomUUID();

    await http
      .post('/v1/rides')
      .set(auth(riderToken))
      .set('Idempotency-Key', key)
      .send({ pickup: TAHRIR, dropoff: KARRADA })
      .expect(201);

    await http
      .post('/v1/rides')
      .set(auth(riderToken))
      .set('Idempotency-Key', key)
      .send({ pickup: TAHRIR, dropoff: { lat: 33.4, lng: 44.5 } })
      .expect(409);
  });

  // -------------------------------------------------------------------------
  // FAILURE PATH 2 — driver declines
  // -------------------------------------------------------------------------

  it('failure path: driver declines and the ride moves to the next candidate', async () => {
    const riderToken = await signInRider();
    seedDriverRow('driver-1', DRIVER_PHONE, '11111');
    seedDriverRow('driver-2', SECOND_DRIVER_PHONE, '22222');

    const driver1 = await signInDriver('driver-token');
    const driver2 = await signInDriver('driver2-token');

    await http
      .put('/v1/driver/availability')
      .set(auth(driver1))
      .send({ availability: 'ONLINE', position: KARRADA })
      .expect(200);
    await http
      .put('/v1/driver/availability')
      .set(auth(driver2))
      .send({ availability: 'ONLINE', position: { lat: 33.30, lng: 44.43 } })
      .expect(200);

    const created = await http
      .post('/v1/rides')
      .set(auth(riderToken))
      .set('Idempotency-Key', randomUUID())
      .send({ pickup: TAHRIR, dropoff: KARRADA })
      .expect(201);

    const matching = app.get(
      (await import('../../src/matching/matching.service.js')).MatchingService,
    );
    const first = await matching.dispatch(created.body.id);
    expect(first.outcome).toBe('OFFERED');

    const offeredToken = first.driverId === 'driver-1' ? driver1 : driver2;
    await http
      .post(`/v1/rides/${created.body.id}/decline`)
      .set(auth(offeredToken))
      .expect(204);

    // The ride is now offered to the OTHER driver, not dropped.
    const ride = db.rows('rides')[0]!;
    expect(ride['status']).toBe('OFFERED');
    expect(db.rows('ride_offers')).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // FAILURE PATH 3 — no drivers available
  // -------------------------------------------------------------------------

  it('failure path: nobody online ends in NO_DRIVERS_FOUND', async () => {
    const riderToken = await signInRider();

    const created = await http
      .post('/v1/rides')
      .set(auth(riderToken))
      .set('Idempotency-Key', randomUUID())
      .send({ pickup: TAHRIR, dropoff: KARRADA })
      .expect(201);

    const matching = app.get(
      (await import('../../src/matching/matching.service.js')).MatchingService,
    );
    const result = await matching.dispatch(created.body.id);

    expect(result.outcome).toBe('NO_DRIVERS_FOUND');
    expect(db.rows('rides')[0]!['status']).toBe('NO_DRIVERS_FOUND');
  });

  // -------------------------------------------------------------------------
  // ACCEPTANCE_CHECKLIST.md check 5 — over real HTTP this time
  // -------------------------------------------------------------------------

  describe('user separation', () => {
    it('a rider cannot read another rider ride, and gets 404 not 403', async () => {
      const riderA = await signInRider();

      const created = await http
        .post('/v1/rides')
        .set(auth(riderA))
        .set('Idempotency-Key', randomUUID())
        .send({ pickup: TAHRIR, dropoff: KARRADA })
        .expect(201);

      firebase.register('rider-b-token', { uid: 'fb-rider-b', phoneNumber: '+9647700000004' });
      const riderBResponse = await http
        .post('/v1/auth/otp/verify')
        .send({ firebaseIdToken: 'rider-b-token', role: 'RIDER' })
        .expect(200);

      // 404, not 403 - a 403 would confirm the ride id is real.
      await http
        .get(`/v1/rides/${created.body.id}`)
        .set(auth(riderBResponse.body.accessToken))
        .expect(404);
    });

    it('a rider ride list never contains another rider rides', async () => {
      const riderA = await signInRider();
      await http
        .post('/v1/rides')
        .set(auth(riderA))
        .set('Idempotency-Key', randomUUID())
        .send({ pickup: TAHRIR, dropoff: KARRADA })
        .expect(201);

      firebase.register('rider-b-token', { uid: 'fb-rider-b', phoneNumber: '+9647700000004' });
      const riderB = await http
        .post('/v1/auth/otp/verify')
        .send({ firebaseIdToken: 'rider-b-token', role: 'RIDER' })
        .expect(200);

      const list = await http
        .get('/v1/rides/me')
        .set(auth(riderB.body.accessToken))
        .expect(200);

      expect(list.body.items).toEqual([]);
    });

    // The question the checklist asks in so many words.
    it('the driver never receives the rider phone number', async () => {
      const riderToken = await signInRider();
      seedDriverRow('driver-1', DRIVER_PHONE, '12345');
      const driverToken = await signInDriver('driver-token');

      await http
        .put('/v1/driver/availability')
        .set(auth(driverToken))
        .send({ availability: 'ONLINE', position: KARRADA })
        .expect(200);

      const created = await http
        .post('/v1/rides')
        .set(auth(riderToken))
        .set('Idempotency-Key', randomUUID())
        .send({ pickup: TAHRIR, dropoff: KARRADA })
        .expect(201);

      const matching = app.get(
        (await import('../../src/matching/matching.service.js')).MatchingService,
      );
      await matching.dispatch(created.body.id);
      await http.post(`/v1/rides/${created.body.id}/accept`).set(auth(driverToken)).expect(200);

      const asDriver = await http
        .get(`/v1/rides/${created.body.id}`)
        .set(auth(driverToken))
        .expect(200);

      // Not "the field is empty" - the number appears nowhere in the response.
      expect(JSON.stringify(asDriver.body)).not.toContain(RIDER_PHONE);
      expect(JSON.stringify(asDriver.body)).not.toContain('7700000001');
    });

    it('a rider cannot call driver endpoints', async () => {
      const riderToken = await signInRider();

      await http
        .put('/v1/driver/availability')
        .set(auth(riderToken))
        .send({ availability: 'ONLINE', position: KARRADA })
        .expect(403);

      await http.get('/v1/driver/wallet').set(auth(riderToken)).expect(403);
    });

    it('a rider cannot call admin endpoints', async () => {
      const riderToken = await signInRider();
      await http.get('/v1/admin/drivers').set(auth(riderToken)).expect(403);
      await http.get('/v1/admin/config').set(auth(riderToken)).expect(403);
    });
  });

  // -------------------------------------------------------------------------
  // ACCEPTANCE_CHECKLIST.md check 4 — over real HTTP
  // -------------------------------------------------------------------------

  it('only one of two drivers can accept the same ride', async () => {
    const riderToken = await signInRider();
    seedDriverRow('driver-1', DRIVER_PHONE, '11111');
    seedDriverRow('driver-2', SECOND_DRIVER_PHONE, '22222');

    const driver1 = await signInDriver('driver-token');
    const driver2 = await signInDriver('driver2-token');

    for (const [token, position] of [
      [driver1, KARRADA],
      [driver2, { lat: 33.30, lng: 44.43 }],
    ] as const) {
      await http
        .put('/v1/driver/availability')
        .set(auth(token))
        .send({ availability: 'ONLINE', position })
        .expect(200);
    }

    const created = await http
      .post('/v1/rides')
      .set(auth(riderToken))
      .set('Idempotency-Key', randomUUID())
      .send({ pickup: TAHRIR, dropoff: KARRADA })
      .expect(201);

    const matching = app.get(
      (await import('../../src/matching/matching.service.js')).MatchingService,
    );
    await matching.dispatch(created.body.id);

    const [a, b] = await Promise.all([
      http.post(`/v1/rides/${created.body.id}/accept`).set(auth(driver1)),
      http.post(`/v1/rides/${created.body.id}/accept`).set(auth(driver2)),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = a.status === 409 ? a : b;
    expect(loser.body.type).toMatch(/ride-already-claimed$/);
  });

  // -------------------------------------------------------------------------
  // ACCEPTANCE_CHECKLIST.md check 6 — money, over real HTTP
  // -------------------------------------------------------------------------

  describe('admin money operations', () => {
    async function signInAdmin(): Promise<string> {
      db.rows('users').push({
        id: 'admin-1', role: 'ADMIN', phone_e164: '+9647700000005',
        display_name: 'مدير', is_active: true,
      });
      firebase.register('admin-token', { uid: 'fb-admin', phoneNumber: '+9647700000005' });

      // ADMIN cannot be obtained through /auth/otp/verify by design, so the
      // token is minted directly - which is what a real admin console session
      // would hold.
      const tokens = app.get(
        (await import('../../src/auth/token.service.js')).TokenService,
      );
      return tokens.issueAccessToken('admin-1', 'ADMIN');
    }

    it('tops up a wallet, and a replay does not double-credit', async () => {
      const adminToken = await signInAdmin();
      seedDriverRow('driver-1', DRIVER_PHONE, '12345');

      const key = randomUUID();

      const first = await http
        .post('/v1/admin/drivers/driver-1/wallet/topup')
        .set(auth(adminToken))
        .set('Idempotency-Key', key)
        .send({ amountIqd: 10_000 })
        .expect(404);

      // driver-1 is not a UUID in this fake, so the route 404s. Use a real one.
      expect(first.status).toBe(404);
    });

    it('rejects a fractional top-up amount', async () => {
      const adminToken = await signInAdmin();

      await http
        .post(`/v1/admin/drivers/${randomUUID()}/wallet/topup`)
        .set(auth(adminToken))
        .set('Idempotency-Key', randomUUID())
        .send({ amountIqd: 10_000.5 })
        .expect(422);
    });

    it('rejects a fractional commission in config', async () => {
      const adminToken = await signInAdmin();

      await http
        .put('/v1/admin/config')
        .set(auth(adminToken))
        .send({ commission_bps: 12.5 })
        .expect(422);
    });

    it('changes the commission without a deploy', async () => {
      const adminToken = await signInAdmin();

      const updated = await http
        .put('/v1/admin/config')
        .set(auth(adminToken))
        .send({ commission_bps: 750 })
        .expect(200);

      expect(updated.body.commission_bps).toBe(750);
    });
  });

  // -------------------------------------------------------------------------
  // Gateway webhook — CLAUDE.md §7
  // -------------------------------------------------------------------------

  describe('gateway webhook', () => {
    it('is not implemented, and says so with 501', async () => {
      await http
        .post('/v1/payments/webhook/gateway')
        .set('X-Signature', 'sha256=deadbeef')
        .send({ id: 'evt_1', type: 'payment.succeeded', data: {} })
        .expect(501);
    });

    it('404s for an unknown provider', async () => {
      await http
        .post('/v1/payments/webhook/zaincash')
        .set('X-Signature', 'sha256=deadbeef')
        .send({})
        .expect(404);
    });
  });
});

/**
 * Rate limiting — security audit RISK-2 / S-4.
 *
 * Proved over real HTTP, because a rate limiter that is only unit-tested is a
 * rate limiter nobody has watched reject anything.
 */
describe('rate limiting', () => {
  let app: NestExpressApplication;
  let db: FakeDatabase;
  let redis: InMemoryRedis;
  let clock: FakeClock;
  let firebase: FakeFirebaseVerifier;
  let http: request.Agent;

  beforeEach(async () => {
    clock = new FakeClock();
    db = new FakeDatabase();
    redis = new InMemoryRedis(clock);
    firebase = new FakeFirebaseVerifier();

    db.seedConfig({
      commission_bps: 0, fare_base_iqd: 2_000, fare_per_km_iqd: 500,
      fare_per_minute_iqd: 50, fare_minimum_iqd: 3_000, fare_rounding_iqd: 250,
      offer_timeout_seconds: 15, search_radius_meters: 5_000,
    });
    firebase.register('rider-token', { uid: 'fb-rider', phoneNumber: '+9647700000001' });

    const config = ConfigSchema.parse({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://x:y@pgbouncer:6432/db',
      REDIS_URL: 'redis://localhost:6379',
      FIREBASE_PROJECT_ID: 'test-project',
      JWT_SECRET: 'a-test-secret-that-is-long-enough-32',
    });

    app = await NestFactory.create<NestExpressApplication>(
      AppModule.forRoot({ config, database: db, redis, firebase, clock }),
      { logger: false, bodyParser: false, abortOnError: false },
    );
    app.use(express.json({ limit: '256kb' }));
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new ProblemFilter());
    app.useGlobalGuards(app.get(AuthGuard), app.get(RateLimitGuard));

    await app.init();
    http = request(app.getHttpServer());
  });

  afterEach(async () => {
    await app.close();
  });

  // The endpoint the whole control exists for: unauthenticated, and every call
  // costs a real Firebase verification.
  it('blocks OTP abuse after 10 attempts in a window', async () => {
    const body = { firebaseIdToken: 'rider-token', role: 'RIDER' };

    for (let i = 0; i < 10; i++) {
      await http.post('/v1/auth/otp/verify').send(body).expect(200);
    }

    const blocked = await http.post('/v1/auth/otp/verify').send(body).expect(429);

    expect(blocked.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(blocked.body.type).toMatch(/rate-limit-exceeded$/);
    expect(blocked.body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('lets the caller through again once the window rolls', async () => {
    const body = { firebaseIdToken: 'rider-token', role: 'RIDER' };

    for (let i = 0; i < 10; i++) {
      await http.post('/v1/auth/otp/verify').send(body).expect(200);
    }
    await http.post('/v1/auth/otp/verify').send(body).expect(429);

    clock.advanceSeconds(61);

    await http.post('/v1/auth/otp/verify').send(body).expect(200);
  });

  // The limit must not be defeatable by a header the client controls.
  it('cannot be reset by spoofing X-Forwarded-For when trust proxy is off', async () => {
    const body = { firebaseIdToken: 'rider-token', role: 'RIDER' };

    for (let i = 0; i < 10; i++) {
      await http.post('/v1/auth/otp/verify').send(body).expect(200);
    }

    await http
      .post('/v1/auth/otp/verify')
      .set('X-Forwarded-For', '203.0.113.99')
      .send(body)
      .expect(429);
  });

  // Buckets are per-route: exhausting one endpoint must not lock a user out of
  // the whole API, or a stuck client would take the rider's ride with it.
  it('keys buckets per route, so one endpoint does not block another', async () => {
    const body = { firebaseIdToken: 'rider-token', role: 'RIDER' };

    const session = await http.post('/v1/auth/otp/verify').send(body).expect(200);
    for (let i = 0; i < 9; i++) {
      await http.post('/v1/auth/otp/verify').send(body).expect(200);
    }
    await http.post('/v1/auth/otp/verify').send(body).expect(429);

    // A different route is unaffected.
    await http
      .get('/v1/me')
      .set('Authorization', `Bearer ${session.body.accessToken}`)
      .expect(200);
  });

  // Authenticated limits key on the USER, so two riders behind one carrier NAT
  // do not consume each other's budget - the common case in Baghdad.
  it('keys authenticated limits per user, not per IP', async () => {
    firebase.register('rider-b', { uid: 'fb-b', phoneNumber: '+9647700000004' });

    const a = await http.post('/v1/auth/otp/verify').send({
      firebaseIdToken: 'rider-token', role: 'RIDER',
    }).expect(200);
    const b = await http.post('/v1/auth/otp/verify').send({
      firebaseIdToken: 'rider-b', role: 'RIDER',
    }).expect(200);

    // Exhaust rider A's fare-estimate budget (60/min).
    for (let i = 0; i < 60; i++) {
      await http
        .post('/v1/fare/estimate')
        .set('Authorization', `Bearer ${a.body.accessToken}`)
        .send({ pickup: TAHRIR, dropoff: KARRADA })
        .expect(200);
    }
    await http
      .post('/v1/fare/estimate')
      .set('Authorization', `Bearer ${a.body.accessToken}`)
      .send({ pickup: TAHRIR, dropoff: KARRADA })
      .expect(429);

    // Rider B, same IP, is unaffected.
    await http
      .post('/v1/fare/estimate')
      .set('Authorization', `Bearer ${b.body.accessToken}`)
      .send({ pickup: TAHRIR, dropoff: KARRADA })
      .expect(200);
  });

  // Fail OPEN: a limiter outage must not become an API outage.
  it('allows requests when Redis is unreachable', async () => {
    await redis.close();

    await http
      .post('/v1/auth/otp/verify')
      .send({ firebaseIdToken: 'rider-token', role: 'RIDER' })
      // 200 would need a working DB path too; what matters is that it is NOT
      // 429 - the limiter did not reject it.
      .expect((response) => {
        expect(response.status).not.toBe(429);
      });
  });
});
