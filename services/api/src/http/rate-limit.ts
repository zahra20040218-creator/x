import {
  type CanActivate,
  type CustomDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import type { Clock } from '../common/clock.js';
import type { Logger } from '../common/logger.js';
import { ProblemError } from '../common/problem.js';
import type { RedisPort } from '../redis/redis.port.js';
import type { AuthenticatedRequest } from './auth.guard.js';

/**
 * Rate limiting.
 *
 * Security audit RISK-2 / S-4 / S-7. The endpoint that matters most is
 * `POST /auth/otp/verify`: it is unauthenticated by necessity, and every call
 * costs a real Firebase verification. Unbounded, it is both a bill and an
 * enumeration oracle.
 *
 * ## Why Redis and not an in-process counter
 *
 * The same reason CLAUDE.md §5.1 forbids an application-level mutex for
 * matching: a counter in process memory is per-instance. Run two API processes
 * — which a 500-user target requires — and the effective limit doubles, then
 * triples, silently. The limit has to live where all instances can see it.
 *
 * ## Algorithm: fixed window, deliberately
 *
 * A sliding-window log is more precise and costs a sorted-set operation plus
 * unbounded memory per key. A fixed window costs one INCR. The imprecision is
 * a burst of up to 2x the limit across a window boundary, which for "stop
 * someone looping OTP requests" is entirely acceptable — and being cheap
 * matters, because this runs on the hot path of every request.
 *
 * ## What happens when Redis is unreachable — this is the interesting part
 *
 * The first version of this file failed OPEN for every endpoint. That was one
 * policy applied to two very different situations, and it was wrong for one of
 * them:
 *
 *  - Failing open on `POST /driver/location` is right. Blocking it would stop
 *    an in-progress ride from tracking, which is a worse incident than an
 *    unthrottled location feed — and location reporting writes to Redis
 *    anyway, so during a Redis outage the call fails on its own.
 *
 *  - Failing open on `POST /auth/otp/verify` is wrong. It means a Redis blip
 *    removes ALL protection from the one endpoint that costs real money per
 *    call, and an attacker who can cause or simply wait for that blip gets an
 *    unmetered oracle.
 *
 * Failing CLOSED everywhere is equally wrong: it makes Redis a hard single
 * point of failure for the whole platform, so a limiter that cannot count
 * becomes "nobody in Baghdad can request a ride".
 *
 * So the failure behaviour is a property of the ENDPOINT, not of the limiter.
 * Each rule declares a {@link RiskTier}, and the tier picks the policy:
 *
 *  - `OPERATIONAL` -> **allow**. Hot paths where blocking breaks a live ride.
 *  - `STANDARD` / `CRITICAL` -> **degrade** to the in-process limiter below,
 *    at a deliberately stricter limit.
 *
 * Degrading is not as good as Redis and is not pretended to be: the in-process
 * counter is per-instance, so N instances permit N times the local limit. That
 * is why the local limit is the Redis limit divided by
 * `RATE_LIMIT_LOCAL_DIVISOR` (default 4 — **set it to your instance count**).
 * A control that is 4x too generous for the duration of an outage is a very
 * different thing from no control at all.
 *
 * @see docs/RATE_LIMIT_POLICY.md for the per-endpoint tier table.
 */

/**
 * How much it costs to be wrong about this endpoint, which is what decides
 * the behaviour when the limiter cannot reach Redis.
 *
 * Required on every rule — there is no default. Choosing a limit without
 * stating what the endpoint protects is how `auth/otp/verify` ended up with
 * the same failure policy as a location ping.
 */
export type RiskTier =
  /** Auth, token issuance, money movement, admin mutation. */
  | 'CRITICAL'
  /** Ride lifecycle, ratings, profile writes. Low frequency, real effects. */
  | 'STANDARD'
  /** High-frequency polling and location. Blocking these breaks a live ride. */
  | 'OPERATIONAL';

/** What to do when Redis cannot be reached, derived from the tier. */
export type UnavailablePolicy = 'allow' | 'degrade';

export const UNAVAILABLE_POLICY: Record<RiskTier, UnavailablePolicy> = {
  CRITICAL: 'degrade',
  STANDARD: 'degrade',
  OPERATIONAL: 'allow',
};

export interface RateLimitRule {
  /** Max requests permitted per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * Key the limit by the caller's identity where available, otherwise by IP.
   *
   * `ip` is the only option for unauthenticated endpoints. It is weaker — a
   * NAT'd mobile carrier puts thousands of users behind one address, which is
   * exactly the situation in Baghdad — so IP limits are set generously and the
   * per-user limits do the real work.
   */
  by: 'ip' | 'user' | 'user-or-ip';
  /** Decides the Redis-unavailable behaviour. See {@link RiskTier}. */
  tier: RiskTier;
}

export const RATE_LIMIT = 'rateLimit';

export const RateLimit = (rule: RateLimitRule): CustomDecorator<string> =>
  SetMetadata(RATE_LIMIT, rule);

export const NO_RATE_LIMIT = 'noRateLimit';

/**
 * Exempt a route from rate limiting entirely.
 *
 * Exists for one reason: **health checks must never return 429.** A load
 * balancer that gets a 429 from a liveness probe removes the instance from the
 * pool, so a rate limiter firing on `/health` would take a perfectly healthy
 * process out of service — the limiter causing the outage it exists to
 * prevent. Probes also arrive from a small number of infrastructure IPs at a
 * fixed rate, so they are the case where an IP-keyed bucket is most likely to
 * fill and least likely to indicate abuse.
 *
 * Do not use this for anything else.
 */
export const NoRateLimit = (): CustomDecorator<string> => SetMetadata(NO_RATE_LIMIT, true);

/**
 * Defaults, applied to every route that does not declare its own.
 *
 * Generous on purpose: the driver app polls for offers every 5 seconds and
 * reports location continuously, so a tight global limit would break normal
 * operation. Tight limits are declared per-endpoint where they matter.
 *
 * The tier is `STANDARD` rather than `OPERATIONAL`: an undeclared route is one
 * nobody has classified, and the safe assumption about an unclassified route is
 * that it does something that matters.
 */
export const DEFAULT_RATE_LIMIT: RateLimitRule = {
  limit: 300,
  windowSeconds: 60,
  by: 'user-or-ip',
  tier: 'STANDARD',
};

export class RateLimitExceededError extends ProblemError {
  constructor(retryAfterSeconds: number) {
    super({
      type: 'rate-limit-exceeded',
      title: 'Too many requests',
      status: 429,
      detail: `Too many requests. Retry in ${retryAfterSeconds} second(s).`,
      extra: { retryAfterSeconds },
    });
  }
}

/** Raised internally when Redis does not answer in time. Never surfaces. */
export class RateLimiterTimeoutError extends Error {
  constructor(ms: number) {
    super(`Rate limiter did not get a response from Redis within ${ms}ms.`);
    this.name = 'RateLimiterTimeoutError';
  }
}

/** The limit applied per-instance while Redis is unavailable. */
export function localLimitFor(rule: RateLimitRule, divisor: number): number {
  return Math.max(1, Math.ceil(rule.limit / divisor));
}

/**
 * The in-process fallback, used ONLY while Redis is unreachable.
 *
 * Bounded in both dimensions on purpose:
 *
 *  - **Across time** by dropping the whole table when the window rolls over.
 *    With fixed windows every entry from a previous window is already dead, so
 *    a clear is both the cheapest eviction and the most complete one, and it
 *    removes the need for a sweeper that could itself leak.
 *
 *  - **Within a window** by `maxKeys`. Reaching it means a very large number of
 *    distinct identities in 60 seconds while Redis happens to be down, which is
 *    an attack rather than traffic. At that point the limiter cannot account
 *    for new identities, and for a tier that asked to degrade the safe answer
 *    is to refuse rather than to wave them through — so `hit` returns `null`
 *    and the caller rejects.
 */
export class LocalWindowLimiter {
  private window = -1;
  private readonly counts = new Map<string, number>();

  constructor(private readonly maxKeys: number) {}

  /** New count for the key, or `null` if the table is saturated. */
  hit(key: string, window: number): number | null {
    if (window !== this.window) {
      this.window = window;
      this.counts.clear();
    }

    const current = this.counts.get(key);
    if (current === undefined && this.counts.size >= this.maxKeys) return null;

    const next = (current ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }

  /** Test and observability only. */
  get size(): number {
    return this.counts.size;
  }
}

export interface RateLimitOptions {
  /**
   * Divides the Redis limit to produce the per-instance fallback limit.
   * Set it to the number of API instances you run.
   */
  localDivisor: number;
  /**
   * How long to wait for Redis before treating it as unavailable.
   *
   * This matters more than it looks. ioredis buffers commands while
   * disconnected instead of rejecting them, so without a timeout a Redis that
   * is *hung* rather than *refused* would add its full latency to every single
   * request — the limiter turning a Redis problem into an API-wide latency
   * problem. 0 disables the timeout.
   */
  redisTimeoutMs: number;
  /** Distinct identities the in-process fallback tracks per window. */
  localMaxKeys: number;
}

export const DEFAULT_RATE_LIMIT_OPTIONS: RateLimitOptions = {
  localDivisor: 4,
  redisTimeoutMs: 50,
  localMaxKeys: 20_000,
};

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly options: RateLimitOptions;
  private readonly local: LocalWindowLimiter;

  constructor(
    private readonly redis: RedisPort,
    private readonly clock: Clock,
    private readonly reflector: Reflector,
    private readonly logger?: Logger,
    options?: Partial<RateLimitOptions>,
  ) {
    this.options = { ...DEFAULT_RATE_LIMIT_OPTIONS, ...options };
    this.local = new LocalWindowLimiter(this.options.localMaxKeys);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const exempt = this.reflector.getAllAndOverride<boolean>(NO_RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exempt) return true;

    const rule =
      this.reflector.getAllAndOverride<RateLimitRule>(RATE_LIMIT, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_RATE_LIMIT;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const identity = this.identityFor(rule, request);
    const route = `${request.method}:${routeKeyOf(request)}`;

    // Window number rather than a timestamp, so every instance computes the
    // same key for the same window without any coordination.
    const window = Math.floor(this.clock.nowMs() / (rule.windowSeconds * 1_000));
    const key = `ratelimit:${route}:${identity}:${window}`;

    let count: number;
    try {
      count = await this.incrementWithTimeout(key, rule.windowSeconds * 1_000);
    } catch (error) {
      return this.handleUnavailable(rule, route, key, window, error);
    }

    if (count > rule.limit) {
      const retryAfter = this.secondsUntilWindowEnd(rule.windowSeconds);

      this.logger?.info(
        { event: 'ratelimit.exceeded', route, tier: rule.tier, limit: rule.limit },
        'rate limit exceeded',
      );

      // The identity is NOT logged. For an unauthenticated endpoint it is an
      // IP address, and CLAUDE.md §9 treats caller-identifying data as PII.
      throw new RateLimitExceededError(retryAfter);
    }

    return true;
  }

  /**
   * Redis could not be reached. Apply the tier's policy.
   *
   * Never rethrows the Redis error: a limiter fault must surface as either a
   * permitted request or a 429, never as a 500.
   */
  private handleUnavailable(
    rule: RateLimitRule,
    route: string,
    key: string,
    window: number,
    error: unknown,
  ): boolean {
    const policy = UNAVAILABLE_POLICY[rule.tier];

    if (policy === 'allow') {
      this.logger?.warn(
        {
          event: 'ratelimit.unavailable',
          route,
          tier: rule.tier,
          policy,
          decision: 'allowed',
          err: error,
        },
        'rate limiter unavailable; allowing request',
      );
      return true;
    }

    const localLimit = localLimitFor(rule, this.options.localDivisor);
    const count = this.local.hit(key, window);

    if (count === null) {
      // Saturated. See LocalWindowLimiter: this is an attack shape, not
      // traffic, and a tier that asked to degrade does not get waved through.
      this.logger?.error(
        {
          event: 'ratelimit.local_saturated',
          route,
          tier: rule.tier,
          maxKeys: this.options.localMaxKeys,
        },
        'rate limiter fallback saturated; refusing request',
      );
      throw new RateLimitExceededError(this.secondsUntilWindowEnd(rule.windowSeconds));
    }

    const permitted = count <= localLimit;

    this.logger?.warn(
      {
        event: 'ratelimit.unavailable',
        route,
        tier: rule.tier,
        policy,
        decision: permitted ? 'degraded' : 'rejected',
        localLimit,
        err: error,
      },
      'rate limiter unavailable; applying in-process fallback',
    );

    if (!permitted) {
      throw new RateLimitExceededError(this.secondsUntilWindowEnd(rule.windowSeconds));
    }

    return true;
  }

  /**
   * `redis.increment`, bounded in time.
   *
   * The losing promise keeps a handler attached so that a Redis rejection
   * arriving after the timeout does not surface as an unhandled rejection and
   * take the process down.
   */
  private async incrementWithTimeout(key: string, ttlMs: number): Promise<number> {
    const operation = this.redis.increment(key, ttlMs);
    if (this.options.redisTimeoutMs <= 0) return operation;

    operation.catch(() => {
      /* handled by the race, or already too late to matter */
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new RateLimiterTimeoutError(this.options.redisTimeoutMs)),
            this.options.redisTimeoutMs,
          );
          // Must not hold the event loop open at shutdown.
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private identityFor(rule: RateLimitRule, request: AuthenticatedRequest): string {
    const userId = request.user?.id;

    switch (rule.by) {
      case 'user':
        return userId ?? `ip:${clientIpOf(request)}`;
      case 'ip':
        return `ip:${clientIpOf(request)}`;
      case 'user-or-ip':
        // Prefer the user: it survives a changing mobile IP, and it is the
        // identity an abuser cannot rotate for free.
        return userId ? `user:${userId}` : `ip:${clientIpOf(request)}`;
    }
  }

  private secondsUntilWindowEnd(windowSeconds: number): number {
    const windowMs = windowSeconds * 1_000;
    const elapsed = this.clock.nowMs() % windowMs;
    return Math.max(1, Math.ceil((windowMs - elapsed) / 1_000));
  }
}

/**
 * The route pattern, not the concrete URL.
 *
 * `/rides/abc-123/accept` and `/rides/def-456/accept` must share a bucket;
 * keying on the raw path would give every ride its own limit and make the
 * control useless.
 */
function routeKeyOf(request: Request): string {
  // Express types `route` as `any`. Narrowed explicitly rather than cast, so a
  // future Express change surfaces as a type error instead of an `any` that
  // silently makes every ride its own rate-limit bucket.
  const candidate: unknown = (request as { route?: unknown }).route;

  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    'path' in candidate &&
    typeof (candidate as { path: unknown }).path === 'string'
  ) {
    return (candidate as { path: string }).path;
  }

  return request.path;
}

/**
 * The client's address.
 *
 * `X-Forwarded-For` is only trusted when Express is configured with `trust
 * proxy` — otherwise any client can spoof the header and reset their own
 * bucket, which would make the limiter decorative. `req.ip` already applies
 * that rule, so it is used directly rather than parsing the header here.
 */
function clientIpOf(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}
