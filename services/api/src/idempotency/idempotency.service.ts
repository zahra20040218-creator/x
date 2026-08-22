import { createHash } from 'node:crypto';

import type { Clock } from '../common/clock.js';
import type { Queryable } from '../db/db.port.js';
import { isPgError, PgErrorCode } from '../db/db.port.js';
import { IdempotencyKeyReusedError } from '../common/problem.js';

/**
 * CLAUDE.md §5.2 - idempotent ride creation.
 *
 * The reason, verbatim from the constitution: "Baghdad mobile networks drop
 * requests mid-flight. Without this, a rider who loses signal creates 3 rides
 * and 3 drivers get dispatched."
 *
 * The subtlety is that the request the client retries may have ALREADY been
 * processed - the server did the work and the response never arrived. So the
 * mechanism cannot be "check whether a ride exists"; it has to be "remember
 * what we answered, and answer the same thing again".
 *
 * Three cases have to be told apart, and conflating any two of them is a bug:
 *
 *   1. New key                  -> do the work, store the response.
 *   2. Same key, same body      -> return the STORED response. Not a new ride.
 *   3. Same key, different body -> 409. The client has a bug, and guessing
 *                                  which request it meant would either
 *                                  duplicate a ride or silently drop one.
 *
 * There is also a fourth case that a naive implementation gets wrong: the same
 * key arriving CONCURRENTLY, before the first request has finished. That is not
 * hypothetical - it is exactly what a flaky connection produces when the client
 * retries on a timeout while the original is still in flight. It is handled by
 * claiming the key with an INSERT first, so the database's primary key decides
 * the winner.
 */

export interface IdempotentOutcome<T> {
  value: T;
  /** true when this call did the work; false when a stored response was returned. */
  fresh: boolean;
}

interface StoredRecord {
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
}

export class IdempotencyService {
  constructor(
    private readonly clock: Clock,
    private readonly ttlSeconds: number,
  ) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error(`ttlSeconds must be a positive integer, got ${ttlSeconds}`);
    }
  }

  /**
   * Hash of the request body, used to tell case 2 from case 3.
   *
   * Keys are sorted recursively so that `{a:1,b:2}` and `{b:2,a:1}` hash the
   * same - JSON key order is not stable across clients, and treating a
   * reordered but identical body as a conflict would reject legitimate retries.
   */
  fingerprint(body: unknown): string {
    return createHash('sha256').update(stableStringify(body)).digest('hex');
  }

  /**
   * Run `work` at most once for a given (user, endpoint, key).
   *
   * `q` must be the POOL, not a transaction: the key claim has to be visible to
   * a concurrent request immediately, and a row inside an uncommitted
   * transaction is not. The work itself opens its own transaction.
   */
  async run<T>(
    q: Queryable,
    params: {
      userId: string;
      endpoint: string;
      key: string;
      body: unknown;
    },
    work: () => Promise<{ status: number; value: T }>,
  ): Promise<IdempotentOutcome<T>> {
    const requestHash = this.fingerprint(params.body);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1_000);

    // Claim the key. ON CONFLICT DO NOTHING makes this a single atomic
    // "did I win?" - two concurrent identical requests cannot both win, because
    // the primary key (user_id, endpoint, key) admits exactly one row.
    const claim = await q.query(
      `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, endpoint, key) DO NOTHING`,
      [params.key, params.userId, params.endpoint, requestHash, now, expiresAt],
    );

    if (claim.rowCount === 0) {
      // Someone else holds the key. Either it is finished (return its response)
      // or still running (tell the client to retry rather than duplicating).
      return { value: await this.replay<T>(q, params, requestHash), fresh: false };
    }

    try {
      const result = await work();

      await q.query(
        `UPDATE idempotency_keys
            SET response_status = $1, response_body = $2, ride_id = $3
          WHERE user_id = $4 AND endpoint = $5 AND key = $6`,
        [
          result.status,
          JSON.stringify(result.value),
          extractRideId(result.value),
          params.userId,
          params.endpoint,
          params.key,
        ],
      );

      return { value: result.value, fresh: true };
    } catch (error) {
      // The work failed, so the key must NOT stay claimed - otherwise a retry
      // of a request that never succeeded would replay a response that does not
      // exist, and the rider could never create that ride.
      await q
        .query(
          `DELETE FROM idempotency_keys
            WHERE user_id = $1 AND endpoint = $2 AND key = $3 AND response_status IS NULL`,
          [params.userId, params.endpoint, params.key],
        )
        .catch(() => undefined);

      throw error;
    }
  }

  private async replay<T>(
    q: Queryable,
    params: { userId: string; endpoint: string; key: string },
    requestHash: string,
  ): Promise<T> {
    const existing = await q.query<StoredRecord>(
      `SELECT request_hash, response_status, response_body
         FROM idempotency_keys
        WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
      [params.userId, params.endpoint, params.key],
    );

    const record = existing.rows[0];

    // The row vanished between the failed INSERT and this SELECT, which means
    // the original attempt failed and cleaned up. Treat it as retryable.
    if (!record) {
      throw new IdempotencyInProgressError();
    }

    // Case 3: same key, different request.
    if (record.request_hash !== requestHash) {
      throw new IdempotencyKeyReusedError();
    }

    // Case 4: the original is still running.
    if (record.response_status === null) {
      throw new IdempotencyInProgressError();
    }

    // Case 2: replay the stored response verbatim.
    return record.response_body as T;
  }

  /** Delete expired keys. Run from the scheduled maintenance job. */
  async purgeExpired(q: Queryable, limit = 1_000): Promise<number> {
    const result = await q.query(
      `DELETE FROM idempotency_keys
        WHERE key IN (
          SELECT key FROM idempotency_keys
           WHERE expires_at < $1
           LIMIT $2
        )`,
      [this.clock.now(), limit],
    );
    return result.rowCount;
  }
}

/**
 * The original request with this key is still in flight.
 *
 * 409 rather than 202: the client's correct behaviour is to retry the same key
 * shortly, and a 409 with this type tells it to do exactly that. Returning 202
 * with no body would leave the rider app with no ride to show and no error.
 */
export class IdempotencyInProgressError extends Error {
  readonly status = 409;
  readonly type = 'idempotency-in-progress';

  constructor() {
    super('A request with this Idempotency-Key is still being processed. Retry shortly.');
    this.name = 'IdempotencyInProgressError';
  }
}

/** Deterministic JSON: object keys sorted recursively. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // undefined members are absent from JSON, so they must not affect the hash.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

  return `{${entries.join(',')}}`;
}

function extractRideId(value: unknown): string | null {
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return null;
}

export { isPgError, PgErrorCode };
