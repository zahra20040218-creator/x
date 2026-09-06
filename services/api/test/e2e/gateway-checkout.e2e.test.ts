import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { FakeFirebaseVerifier } from '../../src/auth/firebase-verifier.js';
import { FakeClock } from '../../src/common/clock.js';
import { ConfigSchema } from '../../src/common/config.js';
import { AuthGuard } from '../../src/http/auth.guard.js';
import { ProblemFilter } from '../../src/http/problem.filter.js';
import { InMemoryRedis } from '../../src/redis/in-memory-redis.js';
import { FakeDatabase } from '../fakes/fake-database.js';

/**
 * The subscription checkout endpoints, over real HTTP.
 *
 * ## Why this file exists
 *
 * This repository's recurring defect, named in AGENTS.md, is that a feature can
 * be present, tested, and completely unreachable. It has happened five times:
 * `NegotiationService` was registered in no module while the contract published
 * three paths for it; the payment registry was injected nowhere; the `DECLINED`
 * enum value, the retention index and the webhook dedup table all existed with
 * no code reading them.
 *
 * `gateway-payment.service.test.ts` and `real-gateway-ledger.test.ts` prove the
 * settlement is correct. Neither would notice if `POST
 * /v1/driver/subscription/checkout` answered 404, because neither speaks HTTP.
 * That is the gap this closes.
 *
 * ## What is asserted, and what is deliberately not
 *
 * Reachability, authorisation, and the OFF switch. Settlement correctness lives
 * in the two files above, against real PostgreSQL triggers, because it belongs
 * somewhere a fake cannot quietly agree with a bug — which `FakeConfigDb` and
 * `FakeDatabase` have each done once already in this repository.
 *
 * The config below sets NO `WAYL_TOKEN`, matching an ordinary deployment: the
 * rail is off, and what must be proven is that it refuses in the documented way
 * rather than by a 404, a 500, or by silently opening an intent nothing can pay.
 */

const DRIVER_PHONE = '+9647701112233';
const RIDER_PHONE = '+9647704445566';

describe('subscription checkout over HTTP', () => {
  let app: NestExpressApplication;
  let http: request.Agent;
  let firebase: FakeFirebaseVerifier;
  let db: FakeDatabase;

  const DRIVER_ID = '33333333-0000-4000-8000-000000000003';

  beforeEach(async () => {
    const clock = new FakeClock();
    db = new FakeDatabase();
    const redis = new InMemoryRedis(clock);
    firebase = new FakeFirebaseVerifier();
    firebase.register('driver-token', { uid: 'fb-driver', phoneNumber: DRIVER_PHONE });
    firebase.register('rider-token', { uid: 'fb-rider', phoneNumber: RIDER_PHONE });

    // Drivers are not self-registering in v1, so the row has to exist before
    // `otp/verify` will issue a DRIVER session.
    db.rows('users').push({
      id: DRIVER_ID,
      role: 'DRIVER',
      phone_e164: DRIVER_PHONE,
      display_name: 'سائق',
      is_active: true,
    });
    db.rows('drivers').push({
      user_id: DRIVER_ID,
      availability: 'OFFLINE',
      is_suspended: false,
      vehicle_plate: 'TEST 1',
      vehicle_model: 'Corolla',
      vehicle_color: 'أبيض',
      rating_sum: '0',
      rating_count: '0',
    });

    const config = ConfigSchema.parse({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://x:y@pgbouncer:6432/db',
      REDIS_URL: 'redis://localhost:6379',
      FIREBASE_PROJECT_ID: 'test-project',
      JWT_SECRET: 'a-test-secret-that-is-long-enough-32',
      // No WAYL_TOKEN, no WAYL_WEBHOOK_SECRET. The ordinary deployment.
    });

    app = await NestFactory.create<NestExpressApplication>(
      AppModule.forRoot({ config, database: db, redis, firebase, clock }),
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

  async function signIn(token: string, role: 'DRIVER' | 'RIDER'): Promise<string> {
    const res = await http
      .post('/v1/auth/otp/verify')
      .send({ firebaseIdToken: token, role, displayName: 'اختبار' })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  describe('the route exists at all', () => {
    it('does not answer 404 — the controller is registered', async () => {
      const token = await signIn('driver-token', 'DRIVER');
      const res = await http
        .post('/v1/driver/subscription/checkout')
        .set(auth(token))
        .send({ planCode: 'MONTHLY_25K' });

      // The precise refusal is asserted below. What matters here is that it is
      // a refusal from THIS handler and not from the router, which is exactly
      // what nobody checked the five previous times.
      expect(res.status).not.toBe(404);
    });
  });

  describe('with the rail off, which is every deployment today', () => {
    it('answers 501, not 500 and not a fabricated success', async () => {
      const token = await signIn('driver-token', 'DRIVER');
      const res = await http
        .post('/v1/driver/subscription/checkout')
        .set(auth(token))
        .send({ planCode: 'MONTHLY_25K' });

      // 501 is the honest code: the capability is not implemented on this
      // deployment. A 500 would tell a driver's app to retry something that
      // will never work, and a 200 would show them a link nobody can pay.
      expect(res.status).toBe(501);
    });

    it('reserves nothing while refusing', async () => {
      const token = await signIn('driver-token', 'DRIVER');
      await http
        .post('/v1/driver/subscription/checkout')
        .set(auth(token))
        .send({ planCode: 'MONTHLY_25K' });

      // A PENDING row written before the refusal would occupy the driver's one
      // permitted open checkout (`gateway_payments_one_pending_uq`) forever, so
      // switching the rail ON later would find them already blocked.
      expect(db.rows('gateway_payments')).toHaveLength(0);
    });

    it('refuses before validating the plan, so no plan is disclosed', async () => {
      const token = await signIn('driver-token', 'DRIVER');
      const res = await http
        .post('/v1/driver/subscription/checkout')
        .set(auth(token))
        .send({ planCode: 'A_PLAN_THAT_DOES_NOT_EXIST' });

      expect(res.status).toBe(501);
    });
  });

  describe('authorisation', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await http
        .post('/v1/driver/subscription/checkout')
        .send({ planCode: 'MONTHLY_25K' });

      expect(res.status).toBe(401);
    });

    it('rejects a RIDER, who has no subscription to buy', async () => {
      const token = await signIn('rider-token', 'RIDER');
      const res = await http
        .post('/v1/driver/subscription/checkout')
        .set(auth(token))
        .send({ planCode: 'MONTHLY_25K' });

      // `@Roles('DRIVER')` on the class. CLAUDE.md §1.1: hiding a button is not
      // authorisation, so the server refuses regardless of what any app shows.
      expect(res.status).toBe(403);
    });

    it('rejects an unauthenticated read of a checkout', async () => {
      const res = await http.get(
        '/v1/driver/subscription/checkout/11111111-0000-4000-8000-000000000001',
      );
      expect(res.status).toBe(401);
    });
  });

  describe('reading a checkout', () => {
    it('validates the reference as a UUID rather than answering 500', async () => {
      const token = await signIn('driver-token', 'DRIVER');
      const res = await http
        .get('/v1/driver/subscription/checkout/not-a-uuid')
        .set(auth(token));

      // 422, the code this contract uses for a failed validation everywhere
      // else. It answered 500 until this test was written: the handler called
      // `UuidSchema.parse` directly, and a bare `parse` throws a raw `ZodError`
      // that no filter maps — so a malformed id in a URL reported that the
      // server had broken, and spent an error budget on a client's mistake.
      // `negotiation.controller.ts` had the identical bug in four places; both
      // now go through `zodParam`.
      expect(res.status).toBe(422);
    });

    it('404s a reference that does not exist', async () => {
      const token = await signIn('driver-token', 'DRIVER');
      const res = await http
        .get('/v1/driver/subscription/checkout/11111111-0000-4000-8000-000000000001')
        .set(auth(token));

      // The same 404 a driver gets for somebody else's reference, so the
      // response cannot be used to learn which references exist.
      expect(res.status).toBe(404);
    });
  });
});
