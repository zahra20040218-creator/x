import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import type { AuthenticatedUser } from '../auth/auth.service.js';
import {
  BadWebhookPayloadProblem,
  NotFoundProblem,
  NotImplementedError,
  UnauthorizedProblem,
} from '../common/problem.js';
import { DATABASE, type Database } from '../db/db.port.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { processWebhook } from '../payments/webhook.js';
import { REDIS, type RedisPort } from '../redis/redis.port.js';
import { RideRepository } from '../rides/ride.repository.js';
import { CurrentUser, Public } from './auth.guard.js';
import { METRICS, MetricsRegistry } from '../observability/metrics.js';
import { NoRateLimit, RateLimit } from './rate-limit.js';
import { OpenDisputeSchema } from './schemas.js';
import { zodBody } from './zod.pipe.js';

@Controller()
export class OpsController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: RedisPort,
    private readonly rides: RideRepository,
    private readonly ledger: LedgerService,
    @Inject('GATEWAY_WEBHOOK_SECRET') private readonly gatewaySecret: string | undefined,
    @Inject('METRICS_TOKEN') private readonly metricsToken: string | undefined,
    @Inject(METRICS) private readonly metricsRegistry: MetricsRegistry,
  ) {}

  /** Liveness. Deliberately touches nothing — it answers "is the process up". */
  @Get('health')
  @Public()
  @NoRateLimit()
  health() {
    return { status: 'ok' as const };
  }

  /** Readiness. Checks Postgres (through PgBouncer) and Redis. */
  @Get('health/ready')
  @Public()
  @NoRateLimit()
  async ready(@Res({ passthrough: true }) response: Response) {
    const [postgres, redis] = await Promise.all([this.db.ping(), this.redis.ping()]);
    const ok = postgres && redis;

    if (!ok) response.status(503);

    return {
      status: ok ? ('ok' as const) : ('degraded' as const),
      checks: {
        postgres: postgres ? ('ok' as const) : ('fail' as const),
        redis: redis ? ('ok' as const) : ('fail' as const),
      },
    };
  }

  /**
   * A rider or driver opens a dispute on a ride they were part of.
   *
   * Listed under /admin/disputes in the contract because that is where the
   * collection lives, but the POST is not admin-only.
   */
  /**
   * Prometheus scrape endpoint. See docs/api-contract.yaml (added 2026-08-23).
   *
   * `@NoRateLimit` for the same reason as the health checks: a scrape that
   * gets 429 shows up as a gap in the graphs, and a gap in the graphs during
   * an incident is exactly when you need them.
   */
  @Get('metrics')
  @Public()
  @NoRateLimit()
  metrics(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): string {
    const expected = this.metricsToken;

    // Disabled, or wrong token - both answer 404. A 401 would confirm that
    // metrics are served from this host, which is information a scanner has
    // not earned.
    if (!expected || authorization !== `Bearer ${expected}`) {
      throw new NotFoundProblem('Endpoint');
    }

    response.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return this.metricsRegistry.render();
  }

  @Post('admin/disputes')
  @HttpCode(201)
  async openDispute(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(OpenDisputeSchema)) body: OpenDisputeBody,
  ) {
    const ride = await this.rides.findById(this.db, body.rideId);

    // 404 rather than 403 if it is not their ride — the same reasoning as
    // GET /rides/{id}: the endpoint must not confirm which ride ids exist.
    if (!ride) throw new NotFoundProblem('Ride');
    if (user.role !== 'ADMIN' && ride.riderId !== user.id && ride.driverId !== user.id) {
      throw new NotFoundProblem('Ride');
    }

    const result = await this.db.query<{ id: string; created_at: Date }>(
      `INSERT INTO disputes (ride_id, opened_by, reason_code, description)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [body.rideId, user.id, body.reasonCode, body.description ?? ''],
    );
    const row = result.rows[0]!;

    return {
      id: row.id,
      rideId: body.rideId,
      openedBy: user.id,
      status: 'OPEN',
      reasonCode: body.reasonCode,
      description: body.description ?? '',
      resolution: null,
      createdAt: row.created_at.toISOString(),
      resolvedAt: null,
    };
  }

  /**
   * Gateway webhook. CLAUDE.md §7 — the provider is stubbed in v1, but the
   * handler exists and is a thin wrapper over the pure, already-tested
   * `processWebhook`.
   *
   * The signature is verified BEFORE the 501 is returned, so this cannot be
   * used as an unauthenticated oracle for which rides exist.
   */
  @Post('payments/webhook/:provider')
  @Public()
  // Unauthenticated by necessity and it writes the ledger. The signature
  // check is the real control; this bounds how often an attacker may
  // make us perform one.
  @RateLimit({ limit: 120, windowSeconds: 60, by: 'ip', tier: 'CRITICAL' })
  @HttpCode(204)
  webhook(
    @Param('provider') provider: string,
    @Headers('x-signature') signature: string | undefined,
    @Body() rawBody: unknown,
  ): void {
    if (provider !== 'gateway') throw new NotFoundProblem('Provider');

    if (!this.gatewaySecret) {
      // Not configured at all. Still not an oracle: the answer is identical
      // whether or not the ride referenced in the payload exists.
      throw new NotImplementedError('Gateway payments');
    }

    const outcome = processWebhook({
      // The RAW body, captured by the verify hook in main.ts. Re-serialising
      // the parsed object reorders keys and the signature would never match.
      rawBody: (rawBody as { __raw?: string }).__raw ?? JSON.stringify(rawBody),
      signatureHeader: signature,
      secret: this.gatewaySecret,
    });

    if (outcome.kind === 'REJECTED') {
      // The status `processWebhook` computed, not a blanket 501.
      //
      // Two things were wrong with rethrowing every rejection as
      // NotImplementedError. It contradicted the published contract, which
      // documents 400 for a malformed payload and 401 for a bad signature. And
      // 5xx is the one class a retrying provider reads as "the far side is
      // broken, send it again" - so a permanently-unverifiable request would be
      // redelivered forever instead of being dropped after one try.
      //
      // The detail is deliberately constant. The old message named the reason,
      // which told an unauthenticated caller whether a guessed secret was
      // correct and whether a secret was configured at all.
      if (outcome.status === 401) throw new UnauthorizedProblem('Webhook signature rejected.');
      throw new BadWebhookPayloadProblem();
    }
    if (outcome.kind === 'IGNORED') return;

    // Signature checked, payload understood — and the gateway is still a stub,
    // so there is nothing legitimate to write. CLAUDE.md §7.
    throw new NotImplementedError('Gateway payment settlement');
  }
}

interface OpenDisputeBody {
  rideId: string;
  reasonCode: 'FARE_WRONG' | 'DRIVER_NO_SHOW' | 'RIDER_NO_SHOW' | 'UNSAFE' | 'OTHER';
  description?: string | undefined;
}
