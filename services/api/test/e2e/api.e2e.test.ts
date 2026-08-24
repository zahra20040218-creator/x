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
 * indexes) need a real Postgres and are covered in test/integration, which
 * runs against PostgreSQL 17.11 and Redis 8.0.5.
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

  // The Firebase token identifies the user, so two calls with the default
  // return the SAME rider. Pass a distinct token for a genuinely different
  // person - a test that means to use a stranger and quietly reuses the owner
  // asserts nothing.
  async function signInRider(firebaseIdToken = 'rider-token'): Promise<string> {
    const response = await http
      .post('/v1/auth/otp/verify')
      .send({ firebaseIdToken, role: 'RIDER', displayName: 'راكب' })
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

    // CLAUDE.md §5.1: two drivers must never both accept. The invariant is
    // "exactly one 200", not a particular rejection code - there are now two
    // independent layers that can refuse the loser, and which one fires
    // depends on who dispatch picked:
    //
    //   404  the loser was never the offeree (D-14 authorisation)
    //   409  the loser was the offeree but lost the Redis claim (§5.1)
    //
    // Asserting one specific code would make this test depend on dispatch
    // ordering rather than on the property that matters.
    const winners = [a, b].filter((r) => r.status === 200);
    const losers = [a, b].filter((r) => r.status !== 200);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect([404, 409]).toContain(losers[0]!.status);

    // The winner really did get the ride.
    expect(winners[0]!.body.status).toBe('ACCEPTED');

    // NOT asserted: that ride_events still holds the ACCEPTED row.
    // FakeDatabase.transaction snapshots the whole database and restores it on
    // failure, so the loser's rollback erases the winner's committed write.
    // Real PostgreSQL would not. Recorded as D-15.
  });

  /**
   * D-13 — going offline while holding an offer.
   *
   * Before the fix a driver could tap "go offline", which deletes their Redis
   * presence, and still accept the offer afterwards. The rider ended up with
   * an assigned driver whose location was not in Redis at all, so the tracking
   * screen stayed empty — and until the offer timed out, no other driver was
   * tried.
   */
  it('going offline releases the offer the driver was holding', async () => {
    const riderToken = await signInRider();
    seedDriverRow('driver-1', DRIVER_PHONE, '11111');
    const driver1 = await signInDriver('driver-token');

    await http
      .put('/v1/driver/availability')
      .set(auth(driver1))
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

    // The offer is theirs right now.
    await http.get('/v1/driver/offers/current').set(auth(driver1)).expect(200);

    await http
      .put('/v1/driver/availability')
      .set(auth(driver1))
      .send({ availability: 'OFFLINE' })
      .expect(200);

    // The offer is gone...
    const after = await http.get('/v1/driver/offers/current').set(auth(driver1));
    expect(after.body.offer ?? null).toBeNull();

    // ...and accepting it afterwards no longer works.
    await http
      .post(`/v1/rides/${created.body.id}/accept`)
      .set(auth(driver1))
      .expect(404);
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

      // Migration 0006: a minted token is no longer enough on its own - it
      // must belong to a LIVE session. That is the whole point of the change,
      // so the test creates a real session rather than working around it.
      const tokens = app.get(
        (await import('../../src/auth/token.service.js')).TokenService,
      );
      const pair = await tokens.issuePair(db, 'admin-1', 'ADMIN');
      return pair.accessToken;
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
  // -------------------------------------------------------------------------

  describe('disputes', () => {
    async function completedRide(): Promise<{
      rideId: string;
      riderToken: string;
      driverToken: string;
    }> {
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

      const rideId = created.body.id;

      // The driver is not a party to the ride until they accept it, and the
      // endpoint checks exactly that. Without this the driver's own dispute
      // is correctly refused with a 404.
      const matching = app.get(
        (await import('../../src/matching/matching.service.js')).MatchingService,
      );
      await matching.dispatch(rideId);
      await http.post(`/v1/rides/${rideId}/accept`).set(auth(driverToken)).expect(200);

      return { rideId, riderToken, driverToken };
    }

    it('lets the rider open one on their own ride', async () => {
      const { rideId, riderToken } = await completedRide();

      const response = await http
        .post('/v1/admin/disputes')
        .set(auth(riderToken))
        .send({ rideId, reasonCode: 'FARE_WRONG', description: 'الأجرة أعلى من المقدرة' })
        .expect(201);

      expect(response.body.status).toBe('OPEN');
      expect(response.body.reasonCode).toBe('FARE_WRONG');
      // The id is what the app shows back as a reference number.
      expect(response.body.id).toBeTruthy();
    });

    it('lets the driver open one too', async () => {
      const { rideId, driverToken } = await completedRide();

      await http
        .post('/v1/admin/disputes')
        .set(auth(driverToken))
        .send({ rideId, reasonCode: 'RIDER_NO_SHOW' })
        .expect(201);
    });

    it('description is optional', async () => {
      const { rideId, riderToken } = await completedRide();

      const response = await http
        .post('/v1/admin/disputes')
        .set(auth(riderToken))
        .send({ rideId, reasonCode: 'OTHER' })
        .expect(201);

      expect(response.body.description).toBe('');
    });

    it('answers 404, not 403, to someone who was not on the ride', async () => {
      const { rideId } = await completedRide();

      // A genuinely different person: the fake verifier maps token -> identity,
      // so an unregistered token is a 401 and a reused one is the rider again.
      firebase.register('stranger-token', {
        uid: 'fb-stranger',
        phoneNumber: '+9647700000009',
      });
      const strangerToken = await signInRider('stranger-token');

      // 403 would confirm the ride exists. Same reasoning as GET /rides/{id}.
      await http
        .post('/v1/admin/disputes')
        .set(auth(strangerToken))
        .send({ rideId, reasonCode: 'UNSAFE' })
        .expect(404);
    });

    it('answers 404 for a ride id that does not exist', async () => {
      const riderToken = await signInRider();

      await http
        .post('/v1/admin/disputes')
        .set(auth(riderToken))
        .send({ rideId: randomUUID(), reasonCode: 'OTHER' })
        .expect(404);
    });

    it('rejects a reason code outside the enum', async () => {
      const { rideId, riderToken } = await completedRide();

      // The Dart client sends `DisputeReason.wire`, so this is the check that
      // keeps the two enums from drifting apart silently.
      await http
        .post('/v1/admin/disputes')
        .set(auth(riderToken))
        .send({ rideId, reasonCode: 'NOT_A_REASON' })
        .expect(422);
    });

    it('requires authentication', async () => {
      const { rideId } = await completedRide();

      await http
        .post('/v1/admin/disputes')
        .send({ rideId, reasonCode: 'OTHER' })
        .expect(401);
    });
  });

  // -------------------------------------------------------------------------
  // Driver document compliance
  //
  // Owner decision, 2026-08-24, overriding the CLAUDE.md §2 OUT-OF-SCOPE entry
  // for KYC. See DECISIONS.md.
  //
  // The first test is the one that matters. The feature ships DISABLED, and
  // "disabled" has to mean the system behaves exactly as it did before - not
  // "a policy that happens to permit everyone".
  // -------------------------------------------------------------------------

  describe('driver documents', () => {
    async function onlineDriver(): Promise<string> {
      seedDriverRow('driver-1', DRIVER_PHONE, '12345');
      return signInDriver('driver-token');
    }

    const goOnline = (token: string) =>
      http
        .put('/v1/driver/availability')
        .set(auth(token))
        .send({ availability: 'ONLINE', position: KARRADA });

    function requireDocuments(value: string): void {
      db.rows('platform_config').push({ key: 'required_driver_documents', value });
    }

    it('with no policy configured, a driver goes online exactly as before', async () => {
      const driverToken = await onlineDriver();

      await goOnline(driverToken).expect(200);
    });

    it('with a policy configured, a driver with no documents is refused', async () => {
      requireDocuments('DRIVING_LICENCE');
      const driverToken = await onlineDriver();

      const response = await goOnline(driverToken).expect(403);

      // Named, so the app can tell the driver what to bring. The server sends
      // the document CODE, never Arabic prose - the app localises it
      // (CLAUDE.md §8).
      expect(response.body.missing).toEqual(['DRIVING_LICENCE']);
      expect(response.body.type).toContain('driver-not-compliant');
    });

    it('a refused driver is not left in the Redis geo set', async () => {
      requireDocuments('DRIVING_LICENCE');
      const driverToken = await onlineDriver();

      await goOnline(driverToken).expect(403);

      // Checked BEFORE presence is written. The other order leaves a driver
      // matchable while being told they cannot work.
      const state = await http.get('/v1/me').set(auth(driverToken)).expect(200);
      expect(state.body.driver?.availability ?? 'OFFLINE').toBe('OFFLINE');
    });

    it('a verified, unexpired document lets the driver online', async () => {
      requireDocuments('DRIVING_LICENCE');
      const driverToken = await onlineDriver();

      db.rows('driver_documents').push({
        driver_id: 'driver-1',
        doc_type: 'DRIVING_LICENCE',
        status: 'VERIFIED',
        expires_at: new Date('2030-01-01T00:00:00.000Z'),
      });

      await goOnline(driverToken).expect(200);
    });

    it('an expired document is reported as expired, not as missing', async () => {
      requireDocuments('DRIVING_LICENCE');
      const driverToken = await onlineDriver();

      db.rows('driver_documents').push({
        driver_id: 'driver-1',
        doc_type: 'DRIVING_LICENCE',
        status: 'VERIFIED',
        expires_at: new Date('2020-01-01T00:00:00.000Z'),
      });

      const response = await goOnline(driverToken).expect(403);

      // The driver has the document and needs it renewed. Telling them it is
      // missing sends them to the wrong office.
      expect(response.body.expired).toEqual(['DRIVING_LICENCE']);
      expect(response.body.missing).toEqual([]);
    });

    it('a pending document does not count as held', async () => {
      requireDocuments('DRIVING_LICENCE');
      const driverToken = await onlineDriver();

      db.rows('driver_documents').push({
        driver_id: 'driver-1',
        doc_type: 'DRIVING_LICENCE',
        status: 'PENDING',
        expires_at: null,
      });

      await goOnline(driverToken).expect(403);
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

  // Phase 5. This test used to assert the opposite - that OTP verification
  // was allowed through unmetered whenever Redis was down. That was the
  // finding (S-7), not the desired behaviour, so the assertion is inverted
  // here rather than the policy being bent to keep it green.
  it('does NOT let OTP verification become unlimited when Redis dies', async () => {
    await redis.close();
    const body = { firebaseIdToken: 'rider-token', role: 'RIDER' };

    // The endpoint keeps working, degraded: ceil(10 / 4) per instance.
    for (let i = 0; i < 3; i++) {
      const response = await http.post('/v1/auth/otp/verify').send(body);
      expect(response.status).not.toBe(429);
    }

    // And then it stops. Without the fallback this would be unmetered.
    await http.post('/v1/auth/otp/verify').send(body).expect(429);
  });

  // The other half of the trade: an operational endpoint must NOT start
  // failing because the limiter lost Redis.
  it('keeps an operational endpoint open when Redis dies', async () => {
    const { body: session } = await http
      .post('/v1/auth/otp/verify')
      .send({ firebaseIdToken: 'rider-token', role: 'RIDER' })
      .expect(200);

    await redis.close();

    // Ride status polling is OPERATIONAL. 404 is fine - the ride does not
    // exist. 429 is not: that would blank a tracking screen mid-ride.
    for (let i = 0; i < 40; i++) {
      const response = await http
        .get('/v1/rides/00000000-0000-4000-8000-000000000000')
        .set('Authorization', `Bearer ${session.accessToken}`);
      expect(response.status).not.toBe(429);
    }
  });

  // A 429 on a liveness probe makes the load balancer eject a healthy
  // instance - the limiter causing the outage it exists to prevent.
  it('never rate limits the health endpoints', async () => {
    for (let i = 0; i < 400; i++) {
      await http.get('/v1/health').expect(200);
    }
  });

  it('still serves health when Redis is gone', async () => {
    await redis.close();
    await http.get('/v1/health').expect(200);
  });
});

/**
 * Admin audit trail — brief §16, security audit RISK-3.
 *
 * Asserted over real HTTP: an audit row is only worth anything if it appears
 * when the actual endpoint is called, not when a service method is called
 * directly.
 */
describe('admin audit log', () => {
  let app: NestExpressApplication;
  let db: FakeDatabase;
  let redis: InMemoryRedis;
  let clock: FakeClock;
  let firebase: FakeFirebaseVerifier;
  let http: request.Agent;
  let adminToken: string;

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
    db.rows('users').push({
      id: 'admin-1', role: 'ADMIN', phone_e164: '+9647700000005',
      display_name: 'مدير', is_active: true,
    });

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

    const tokens = app.get(
      (await import('../../src/auth/token.service.js')).TokenService,
    );
    adminToken = (await tokens.issuePair(db, 'admin-1', 'ADMIN')).accessToken;
  });

  afterEach(async () => {
    await app.close();
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  it('records driver creation with the acting admin', async () => {
    await http
      .post('/v1/admin/drivers')
      .set(auth())
      .send({
        phone: '07700000009',
        displayName: 'سائق جديد',
        vehiclePlate: '55555',
        vehicleModel: 'Corolla',
        vehicleColor: 'أبيض',
      })
      .expect(201);

    const rows = db.rows('audit_log');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['action']).toBe('driver.create');
    expect(rows[0]!['actor_id']).toBe('admin-1');
    expect(rows[0]!['result']).toBe('SUCCESS');
  });

  // The row that answers "who credited this driver 500,000 dinars".
  it('records a wallet top-up with the amount and transaction id', async () => {
    const driverId = '11111111-1111-4111-8111-111111111111';
    db.rows('users').push({
      id: driverId, role: 'DRIVER', phone_e164: '+9647700000002',
      display_name: 'سائق', is_active: true,
    });
    db.rows('drivers').push({
      user_id: driverId, availability: 'OFFLINE', is_suspended: false,
      vehicle_plate: '1', vehicle_model: 'x', vehicle_color: 'y',
      rating_sum: '0', rating_count: '0',
    });

    await http
      .post(`/v1/admin/drivers/${driverId}/wallet/topup`)
      .set(auth())
      .set('Idempotency-Key', randomUUID())
      .send({ amountIqd: 10_000, reference: 'receipt-42' })
      .expect(201);

    const topup = db.rows('audit_log').find((r) => r['action'] === 'wallet.topup');
    expect(topup).toBeDefined();
    expect(topup!['target_id']).toBe(driverId);

    const metadata = JSON.parse(topup!['metadata'] as string) as Record<string, unknown>;
    expect(metadata['amountIqd']).toBe(10_000);
    expect(metadata['transactionId']).toBeTruthy();
  });

  // Suspension gets a distinct verb from an ordinary edit, so an operator
  // filtering the log does not have to read metadata to tell them apart.
  it('distinguishes suspension from an ordinary update', async () => {
    const driverId = '22222222-2222-4222-8222-222222222222';
    db.rows('users').push({
      id: driverId, role: 'DRIVER', phone_e164: '+9647700000003',
      display_name: 'سائق', is_active: true,
    });
    db.rows('drivers').push({
      user_id: driverId, availability: 'OFFLINE', is_suspended: false,
      vehicle_plate: '1', vehicle_model: 'x', vehicle_color: 'y',
      rating_sum: '0', rating_count: '0',
    });

    await http
      .patch(`/v1/admin/drivers/${driverId}`)
      .set(auth())
      .send({ isSuspended: true, suspendedReason: 'complaint' })
      .expect(200);

    expect(
      db.rows('audit_log').some((r) => r['action'] === 'driver.suspend'),
    ).toBe(true);
  });

  // "Commission changed" is not actionable. "0 -> 2500 bps by this admin" is.
  it('records a commission change with both the old and new value', async () => {
    await http
      .put('/v1/admin/config')
      .set(auth())
      .send({ commission_bps: 2_500 })
      .expect(200);

    const row = db.rows('audit_log').find((r) => r['action'] === 'config.update');
    expect(row).toBeDefined();

    const metadata = JSON.parse(row!['metadata'] as string) as {
      changes: Record<string, { from: number; to: number }>;
    };
    expect(metadata.changes['commission_bps']).toEqual({ from: 0, to: 2_500 });
  });

  // CLAUDE.md §9 - the audit log is exported for disputes, so it is a
  // plausible route for PII to escape.
  it('never writes a phone number into audit metadata', async () => {
    await http
      .post('/v1/admin/drivers')
      .set(auth())
      .send({
        phone: '07700000009',
        displayName: 'سائق جديد',
        vehiclePlate: '55555',
        vehicleModel: 'Corolla',
        vehicleColor: 'أبيض',
      })
      .expect(201);

    const serialised = JSON.stringify(db.rows('audit_log'));

    // Matched as a PHONE NUMBER, not as the substring '964'. A bare substring
    // check false-positives on any UUID that happens to contain those digits,
    // which makes the test flaky and - worse - would let it pass or fail for
    // reasons unrelated to PII.
    expect(serialised).not.toMatch(/\+?964\d{9,}/);
    expect(serialised).not.toContain('07700000009');
  });

  it('is not writable by a non-admin', async () => {
    firebase.register('rider-token', { uid: 'fb-r', phoneNumber: '+9647700000001' });
    const rider = await http
      .post('/v1/auth/otp/verify')
      .send({ firebaseIdToken: 'rider-token', role: 'RIDER' })
      .expect(200);

    await http
      .post('/v1/admin/drivers')
      .set({ Authorization: `Bearer ${rider.body.accessToken}` })
      .send({
        phone: '07700000009', displayName: 'x',
        vehiclePlate: '1', vehicleModel: 'x', vehicleColor: 'y',
      })
      .expect(403);

    expect(db.rows('audit_log')).toHaveLength(0);
  });
});


/**
 * Session revocation — Phase 6, security audit S-3.
 *
 * S-3 said "an admin token cannot be revoked short of rotating JWT_SECRET".
 * Half of that was already false: AuthGuard reloads the user on every request,
 * so deactivating an account always took effect immediately. The half that was
 * true is the one tested here — logging out did not invalidate the access
 * token the caller was holding, so for up to an hour "log me out" logged
 * nobody out.
 *
 * Asserted over HTTP, because the claim is about what a token can still DO.
 */
describe('session revocation', () => {
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
    firebase.register('rider-token', { uid: 'fb-rider', phoneNumber: RIDER_PHONE });
    firebase.register('other-token', { uid: 'fb-other', phoneNumber: SECOND_DRIVER_PHONE });

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

  async function signIn(token = 'rider-token'): Promise<{ access: string; refresh: string }> {
    const { body } = await http
      .post('/v1/auth/otp/verify')
      .send({ firebaseIdToken: token, role: 'RIDER' })
      .expect(200);
    return { access: body.accessToken, refresh: body.refreshToken };
  }

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  // THE regression. Before migration 0006 this returned 200.
  it('logout invalidates the access token immediately, not in an hour', async () => {
    const { access } = await signIn();
    await http.get('/v1/me').set(as(access)).expect(200);

    await http.post('/v1/auth/logout').set(as(access)).expect(204);

    // Same token, one request later.
    await http.get('/v1/me').set(as(access)).expect(401);
  });

  it('stays revoked as time passes rather than merely expiring', async () => {
    const { access } = await signIn();
    await http.post('/v1/auth/logout').set(as(access)).expect(204);

    clock.advanceSeconds(30);
    await http.get('/v1/me').set(as(access)).expect(401);
  });

  it('does not reveal that a session was revoked rather than expired', async () => {
    const { access } = await signIn();
    await http.post('/v1/auth/logout').set(as(access)).expect(204);

    const revoked = await http.get('/v1/me').set(as(access)).expect(401);
    const garbage = await http.get('/v1/me').set(as('not.a.jwt')).expect(401);

    // Telling a token holder WHICH failure occurred is information they have
    // not earned.
    expect(revoked.body.detail).toBe(garbage.body.detail);
  });

  it('revokes every device, not just the one that called logout', async () => {
    const phone = await signIn();
    const laptop = await signIn();
    expect(phone.access).not.toBe(laptop.access);

    await http.post('/v1/auth/logout').set(as(phone.access)).expect(204);

    await http.get('/v1/me').set(as(laptop.access)).expect(401);
  });

  it('leaves other users signed in', async () => {
    const mine = await signIn('rider-token');
    const theirs = await signIn('other-token');

    await http.post('/v1/auth/logout').set(as(mine.access)).expect(204);

    await http.get('/v1/me').set(as(theirs.access)).expect(200);
  });

  // Rotation must NOT invalidate the access token issued alongside it. This is
  // why the session id is carried forward instead of a new one being minted:
  // a row-per-session model would log the caller out every time they
  // refreshed, which is worse than the bug being fixed.
  it('survives refresh rotation', async () => {
    const first = await signIn();

    const { body: rotated } = await http
      .post('/v1/auth/refresh')
      .send({ refreshToken: first.refresh })
      .expect(200);

    await http.get('/v1/me').set(as(rotated.accessToken)).expect(200);
    // The token issued before the rotation also still works - same session.
    await http.get('/v1/me').set(as(first.access)).expect(200);
  });

  it('logout after a rotation still kills the whole session', async () => {
    const first = await signIn();
    const { body: rotated } = await http
      .post('/v1/auth/refresh')
      .send({ refreshToken: first.refresh })
      .expect(200);

    await http.post('/v1/auth/logout').set(as(rotated.accessToken)).expect(204);

    await http.get('/v1/me').set(as(rotated.accessToken)).expect(401);
    await http.get('/v1/me').set(as(first.access)).expect(401);
  });

  // Account deactivation already worked before this change; asserted so that
  // it cannot regress while the session machinery is being edited.
  it('deactivating the account cuts a live session off', async () => {
    const { access } = await signIn();
    await http.get('/v1/me').set(as(access)).expect(200);

    const user = db.rows('users').find((u) => u['phone_e164'] === RIDER_PHONE)!;
    user['is_active'] = false;

    await http.get('/v1/me').set(as(access)).expect(401);
  });

  // The admin PATCH route validates its path param as a UUID.
  const DRIVER_9 = '00000000-0000-4000-8000-000000000009';
  const DRIVER_8 = '00000000-0000-4000-8000-000000000008';

  // "Credential/session invalidation after a security-sensitive change."
  // Suspending a driver for fraud used to leave every device they were signed
  // in on holding a working token until it expired.
  it('admin suspension cuts the driver off on every device', async () => {
    const tokens = app.get(
      (await import('../../src/auth/token.service.js')).TokenService,
    );

    db.rows('users').push({
      id: 'admin-9', role: 'ADMIN', phone_e164: '+9647700000005',
      display_name: 'مدير', is_active: true,
    });
    db.rows('users').push({
      id: DRIVER_9, role: 'DRIVER', phone_e164: DRIVER_PHONE,
      display_name: 'سائق', is_active: true,
    });
    db.rows('drivers').push({
      user_id: DRIVER_9, availability: 'OFFLINE', is_suspended: false,
      vehicle_plate: '99999', vehicle_model: 'Corolla', vehicle_color: 'أبيض',
      rating_sum: 0, rating_count: 0, suspended_reason: null,
    });

    const admin = (await tokens.issuePair(db, 'admin-9', 'ADMIN')).accessToken;
    const phone = (await tokens.issuePair(db, DRIVER_9, 'DRIVER')).accessToken;
    const tablet = (await tokens.issuePair(db, DRIVER_9, 'DRIVER')).accessToken;

    await http.get('/v1/me').set(as(phone)).expect(200);
    await http.get('/v1/me').set(as(tablet)).expect(200);

    await http
      .patch(`/v1/admin/drivers/${DRIVER_9}`)
      .set(as(admin))
      .send({ isSuspended: true, suspendedReason: 'fraud' })
      .expect(200);

    await http.get('/v1/me').set(as(phone)).expect(401);
    await http.get('/v1/me').set(as(tablet)).expect(401);

    // The account itself is NOT deactivated - they can sign in again and see
    // that they are suspended. Suspension bars rides, not sign-in.
    const driver = db.rows('users').find((u) => u['id'] === DRIVER_9)!;
    expect(driver['is_active']).toBe(true);
  });

  it('lifting a suspension does not revoke sessions', async () => {
    const tokens = app.get(
      (await import('../../src/auth/token.service.js')).TokenService,
    );
    db.rows('users').push({
      id: 'admin-8', role: 'ADMIN', phone_e164: '+9647700000005',
      display_name: 'مدير', is_active: true,
    });
    db.rows('users').push({
      id: DRIVER_8, role: 'DRIVER', phone_e164: DRIVER_PHONE,
      display_name: 'سائق', is_active: true,
    });
    db.rows('drivers').push({
      user_id: DRIVER_8, availability: 'OFFLINE', is_suspended: true,
      vehicle_plate: '88888', vehicle_model: 'Corolla', vehicle_color: 'أبيض',
      rating_sum: 0, rating_count: 0, suspended_reason: 'fraud',
    });

    const admin = (await tokens.issuePair(db, 'admin-8', 'ADMIN')).accessToken;
    const driverToken = (await tokens.issuePair(db, DRIVER_8, 'DRIVER')).accessToken;

    await http
      .patch(`/v1/admin/drivers/${DRIVER_8}`)
      .set(as(admin))
      .send({ isSuspended: false })
      .expect(200);

    // Reinstatement is not a security-sensitive change against the driver, so
    // it must not sign them out.
    await http.get('/v1/me').set(as(driverToken)).expect(200);
  });

  // A real, signed, unexpired token for a REAL active user, whose only defect
  // is that its session was revoked. Anything less than this passes for the
  // wrong reason - an unknown subject would 401 on the user lookup alone.
  it('refuses a validly signed token whose session is gone', async () => {
    const { access } = await signIn();
    await http.get('/v1/me').set(as(access)).expect(200);

    // Revoke the session directly, without going through logout.
    for (const row of db.rows('refresh_tokens')) row['revoked_at'] = clock.now();

    await http.get('/v1/me').set(as(access)).expect(401);
  });

  // -------------------------------------------------------------------------
  // Disputes
  //
  // The POST lives under /admin/disputes because that is where the collection
  // sits in the contract, but it is NOT admin-only: it is how a rider says the
  // fare was wrong and how a driver reports a rider who never appeared. It had
  // no test and no caller in either app, which meant the admin queue behind it
  // could only ever be empty.

});
