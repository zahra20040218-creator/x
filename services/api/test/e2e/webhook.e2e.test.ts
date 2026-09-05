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
import { signPayload } from '../../src/payments/webhook.js';
import { InMemoryRedis } from '../../src/redis/in-memory-redis.js';
import { FakeDatabase } from '../fakes/fake-database.js';

/**
 * The gateway webhook, over real HTTP, with a secret actually configured.
 *
 * ## Why this file exists separately
 *
 * `api.e2e.test.ts` builds its config without `GATEWAY_WEBHOOK_SECRET`, and the
 * option is `.optional()`, so the controller short-circuits to 501 before it
 * ever reads the body. It also registers a bare `express.json()` with no
 * `verify` hook, while production (`main.ts`) registers one that captures the
 * raw bytes. Between those two facts, the entire signature path - the only
 * security control on an unauthenticated endpoint that writes ledger rows - was
 * exercised by zero tests at the HTTP layer. `webhook.test.ts` covers the pure
 * function thoroughly; nothing covered the plumbing that feeds it.
 *
 * So this harness mirrors `main.ts` deliberately, including the `verify` hook.
 * If the raw-body capture regresses, the correctly-signed request below stops
 * verifying and this file goes red - which is the whole point.
 *
 * ## What is asserted
 *
 * That rejections carry the status the contract publishes. Every REJECTED
 * outcome used to be rethrown as `NotImplementedError`, so a bad signature
 * answered 501. That was wrong twice over: it contradicted the documented
 * 400/401, and 5xx is the one class a retrying provider reads as "the far side
 * is broken, send it again" - so an unverifiable request would be redelivered
 * forever instead of dropped.
 */

const SECRET = 'a-webhook-secret-that-is-long-enough';

describe('gateway webhook over HTTP, with a secret configured', () => {
  let app: NestExpressApplication;
  let http: request.Agent;

  beforeEach(async () => {
    const clock = new FakeClock();
    const db = new FakeDatabase();
    const redis = new InMemoryRedis(clock);
    const firebase = new FakeFirebaseVerifier();

    const config = ConfigSchema.parse({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://x:y@pgbouncer:6432/db',
      REDIS_URL: 'redis://localhost:6379',
      FIREBASE_PROJECT_ID: 'test-project',
      JWT_SECRET: 'a-test-secret-that-is-long-enough-32',
      GATEWAY_WEBHOOK_SECRET: SECRET,
    });

    app = await NestFactory.create<NestExpressApplication>(
      AppModule.forRoot({ config, database: db, redis, firebase, clock }),
      { logger: false, bodyParser: false, abortOnError: false },
    );

    // The SAME parser production uses, verify hook included. A bare
    // express.json() here would make every signature check pass or fail for
    // reasons that have nothing to do with the code under test.
    app.use(
      express.json({
        limit: '256kb',
        verify: (req, _res, buf) => {
          if (req.url?.startsWith('/v1/payments/webhook')) {
            (req as unknown as { rawBody: string }).rawBody = buf.toString('utf8');
          }
        },
      }),
    );
    app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
      const body = req.body as Record<string, unknown> | undefined;
      const raw = (req as unknown as { rawBody?: string }).rawBody;
      if (raw && body && typeof body === 'object') {
        Object.defineProperty(body, '__raw', { value: raw, enumerable: false });
      }
      next();
    });

    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new ProblemFilter());
    app.useGlobalGuards(app.get(AuthGuard));

    await app.init();
    http = request(app.getHttpServer());
  });

  afterEach(async () => {
    await app.close();
  });

  function post(body: unknown, signature?: string) {
    const raw = JSON.stringify(body);
    const req = http
      .post('/v1/payments/webhook/gateway')
      .set('Content-Type', 'application/json');
    if (signature !== undefined) req.set('X-Signature', signature);
    return req.send(raw);
  }

  it('401s with no signature header', async () => {
    const res = await post({ id: 'evt_1', type: 'payment.succeeded', data: {} });
    expect(res.status).toBe(401);
  });

  it('401s on a bad signature, not 501', async () => {
    const res = await post({ id: 'evt_1', type: 'payment.succeeded', data: {} }, 'sha256=deadbeef');
    expect(res.status).toBe(401);
  });

  it('does not name the rejection reason in the response', async () => {
    const res = await post({ id: 'evt_1', type: 'payment.succeeded', data: {} }, 'sha256=deadbeef');

    // The old detail read "Gateway webhook rejected: BAD_SIGNATURE", which told
    // an unauthenticated caller whether a guessed secret was correct.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('BAD_SIGNATURE');
    expect(body).not.toContain('MALFORMED_PAYLOAD');
  });

  it('400s a correctly-signed but unparseable payload', async () => {
    // Correctly signed, so it gets past the security boundary and fails on
    // shape - which is the only way to reach the 400 branch at all.
    const body = { id: 'evt_2', type: 'payment.succeeded', data: { rideId: 'r1' } };
    const res = await post(body, signPayload(JSON.stringify(body), SECRET));

    // `data.driverId` is missing, so the translator rejects it as malformed.
    expect(res.status).toBe(400);
  });

  it('204s an event type it does not model, rather than erroring', async () => {
    // A 4xx would make a provider retry an event that is not an error - it is
    // simply a feature this system does not use.
    const body = {
      id: 'evt_3',
      type: 'invoice.created',
      data: { rideId: 'r1', driverId: 'd1' },
    };
    const res = await post(body, signPayload(JSON.stringify(body), SECRET));
    expect(res.status).toBe(204);
  });

  it('still 501s a fully valid event, because settlement is stubbed', async () => {
    // CLAUDE.md §7 keeps the gateway a stub. This asserts the boundary is where
    // the constitution puts it: signature and payload are real, the WRITE is
    // not. If this ever returns 204, a ledger path became reachable and the
    // replay dedup in DECISIONS.md D-019 must land in the same change.
    const body = {
      id: 'evt_4',
      type: 'payment.succeeded',
      data: { rideId: 'r1', driverId: 'd1', amountIqd: 5000, commissionIqd: 0 },
    };
    const res = await post(body, signPayload(JSON.stringify(body), SECRET));
    expect(res.status).toBe(501);
  });

  it('verifies over the raw bytes, so key order does not matter', async () => {
    // The proof that the raw-body plumbing is real. Signing a differently
    // ordered serialisation of the same object must FAIL, because the signature
    // covers bytes and not semantics - if the handler re-serialised the parsed
    // object, this would wrongly pass.
    const sent = '{"id":"evt_5","type":"payment.failed","data":{"rideId":"r1","driverId":"d1"}}';
    const reordered =
      '{"type":"payment.failed","id":"evt_5","data":{"driverId":"d1","rideId":"r1"}}';

    const wrong = await http
      .post('/v1/payments/webhook/gateway')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signPayload(reordered, SECRET))
      .send(sent);
    expect(wrong.status).toBe(401);

    const right = await http
      .post('/v1/payments/webhook/gateway')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signPayload(sent, SECRET))
      .send(sent);

    // 501, not 204, and that is the correct current behaviour: the controller
    // throws the §7 stub for EVERY accepted outcome, `payment.failed` included.
    // What this asserts is the thing that matters here - the same bytes with
    // the right signature get PAST the security boundary, where the reordered
    // signature did not. The two statuses differing is the proof; 401 would
    // mean the raw body never reached the verifier.
    expect(right.status).toBe(501);
    expect(right.status).not.toBe(wrong.status);
  });

  it('404s an unknown provider before doing any crypto', async () => {
    await http
      .post('/v1/payments/webhook/zaincash')
      .set('X-Signature', 'sha256=deadbeef')
      .send({})
      .expect(404);
  });
});
