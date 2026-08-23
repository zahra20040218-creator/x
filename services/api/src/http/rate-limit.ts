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
 * Security audit RISK-2 / S-4. The endpoint that matters most is
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
 * a burst of up to 2× the limit across a window boundary, which for "stop
 * someone looping OTP requests" is entirely acceptable — and being cheap
 * matters, because this runs on the hot path of every request.
 *
 * ## Fail-open, and why
 *
 * If Redis is unreachable the request is ALLOWED, not rejected. Rate limiting
 * is a protective control, not a correctness one; making the whole API
 * unavailable because the limiter cannot count would convert a Redis blip into
 * a total outage. This is a deliberate trade and it is logged loudly, because
 * "the limiter is down" must not be silent.
 */

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
}

export const RATE_LIMIT = 'rateLimit';

export const RateLimit = (rule: RateLimitRule): CustomDecorator<string> =>
  SetMetadata(RATE_LIMIT, rule);

/**
 * Defaults, applied to every route that does not declare its own.
 *
 * Generous on purpose: the driver app polls for offers every 5 seconds and
 * reports location continuously, so a tight global limit would break normal
 * operation. Tight limits are declared per-endpoint where they matter.
 */
export const DEFAULT_RATE_LIMIT: RateLimitRule = {
  limit: 300,
  windowSeconds: 60,
  by: 'user-or-ip',
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

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly redis: RedisPort,
    private readonly clock: Clock,
    private readonly reflector: Reflector,
    private readonly logger?: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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
      count = await this.redis.increment(key, rule.windowSeconds * 1_000);
    } catch (error) {
      // Fail OPEN. See the class comment: a limiter outage must not become an
      // API outage. Logged at warn so it cannot pass unnoticed.
      this.logger?.warn(
        { event: 'ratelimit.unavailable', route, err: error },
        'rate limiter unavailable; allowing request',
      );
      return true;
    }

    if (count > rule.limit) {
      const retryAfter = this.secondsUntilWindowEnd(rule.windowSeconds);

      this.logger?.info(
        { event: 'ratelimit.exceeded', route, limit: rule.limit },
        'rate limit exceeded',
      );

      // The identity is NOT logged. For an unauthenticated endpoint it is an
      // IP address, and CLAUDE.md §9 treats caller-identifying data as PII.
      throw new RateLimitExceededError(retryAfter);
    }

    return true;
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
