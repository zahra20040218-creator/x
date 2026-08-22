import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import pino, { type Logger } from 'pino';

/**
 * Structured logging. CLAUDE.md §9:
 *   "Every log line carries request_id. Never log phone numbers, exact
 *    coordinates, or full names."
 *
 * That rule is enforced here rather than left to discipline, because the way
 * PII actually reaches logs is never `logger.info(phone)`. It is
 * `logger.info({ user })` where `user` happens to contain a phone field, three
 * refactors after anyone looked at it. So redaction is applied structurally to
 * known-sensitive key names at every depth, and coordinates are rounded rather
 * than removed - a 3-decimal-place coordinate (~110m) is enough to debug a
 * matching problem and not enough to find someone's house.
 */

/** Key names that must never appear in a log line with their real value. */
const REDACTED_KEYS = new Set([
  'phone',
  'phone_e164',
  'phoneE164',
  'phoneNumber',
  'msisdn',
  'displayName',
  'display_name',
  'fullName',
  'name',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'firebaseIdToken',
  'authorization',
  'idempotencyKey',
  'jwt',
  'secret',
  'apiKey',
  'signature',
]);

/** Key names holding a coordinate, which get coarsened rather than removed. */
const COARSE_COORD_KEYS = new Set(['lat', 'lng', 'latitude', 'longitude']);

/** ~110 m at the equator. Enough to debug matching, not enough to locate a person. */
const COORD_PRECISION = 3;

const MAX_DEPTH = 8;

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[max-depth]';

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redact(v, depth + 1));
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(key)) {
        out[key] = '[redacted]';
      } else if (COARSE_COORD_KEYS.has(key) && typeof v === 'number') {
        out[key] = Number(v.toFixed(COORD_PRECISION));
      } else {
        out[key] = redact(v, depth + 1);
      }
    }
    return out;
  }

  return value;
}

export interface RequestContext {
  requestId: string;
  userId?: string;
  role?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function newRequestId(): string {
  return randomUUID();
}

export function createLogger(level: string, name = 'api'): Logger {
  return pino({
    name,
    level,
    // pino's own redaction covers exact paths; `redact()` above covers the
    // arbitrary-depth case. Both are used: belt and braces, because a PII leak
    // in logs is not recoverable once it is shipped to a log aggregator.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["idempotency-key"]',
        'phone',
        '*.phone',
        '*.phone_e164',
        'displayName',
        '*.displayName',
      ],
      censor: '[redacted]',
    },
    formatters: {
      level: (label) => ({ level: label }),
      // CLAUDE.md §9 - request_id on EVERY line, taken from async context so
      // that no call site has to remember to pass it.
      log: (obj) => {
        const ctx = storage.getStore();
        const base = redact(obj) as Record<string, unknown>;
        return ctx
          ? { ...base, request_id: ctx.requestId, user_id: ctx.userId, role: ctx.role }
          : base;
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const LOGGER = Symbol('LOGGER');
export type { Logger };
