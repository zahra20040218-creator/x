import { beforeEach, describe, expect, it } from 'vitest';

import { FakeClock } from '../common/clock.js';
import { IdempotencyKeyReusedError } from '../common/problem.js';
import type { Queryable, QueryResult, SqlValue } from '../db/db.port.js';
import {
  IdempotencyInProgressError,
  IdempotencyService,
  stableStringify,
} from './idempotency.service.js';

const USER = 'uuuuuuuu-0000-4000-8000-000000000001';
const OTHER_USER = 'uuuuuuuu-0000-4000-8000-000000000002';
const ENDPOINT = 'POST /rides';

interface Row {
  key: string;
  userId: string;
  endpoint: string;
  requestHash: string;
  responseStatus: number | null;
  responseBody: unknown;
  expiresAt: Date;
}

/**
 * A stand-in for the idempotency_keys table that honours the one property the
 * whole mechanism rests on: the primary key (user_id, endpoint, key) admits
 * exactly one row, and INSERT ... ON CONFLICT DO NOTHING reports whether this
 * caller was the one that created it.
 */
class FakeKeyStore implements Queryable {
  readonly rows = new Map<string, Row>();

  private id(userId: string, endpoint: string, key: string): string {
    return `${userId}|${endpoint}|${key}`;
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<QueryResult<R>> {
    const normalised = sql.trim().toUpperCase();

    if (normalised.startsWith('INSERT INTO IDEMPOTENCY_KEYS')) {
      const [key, userId, endpoint, requestHash, , expiresAt] = params as [
        string, string, string, string, Date, Date,
      ];
      const id = this.id(userId, endpoint, key);
      if (this.rows.has(id)) return { rows: [], rowCount: 0 };
      this.rows.set(id, {
        key, userId, endpoint, requestHash,
        responseStatus: null, responseBody: null, expiresAt,
      });
      return { rows: [], rowCount: 1 };
    }

    if (normalised.startsWith('UPDATE IDEMPOTENCY_KEYS')) {
      const [status, body, , userId, endpoint, key] = params as [
        number, string, string | null, string, string, string,
      ];
      const row = this.rows.get(this.id(userId, endpoint, key));
      if (row) {
        row.responseStatus = status;
        row.responseBody = JSON.parse(body);
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (normalised.startsWith('DELETE FROM IDEMPOTENCY_KEYS') && normalised.includes('RESPONSE_STATUS IS NULL')) {
      const [userId, endpoint, key] = params as [string, string, string];
      const id = this.id(userId, endpoint, key);
      const row = this.rows.get(id);
      if (row && row.responseStatus === null) {
        this.rows.delete(id);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (normalised.startsWith('DELETE FROM IDEMPOTENCY_KEYS')) {
      const [now, limit] = params as [Date, number];
      let deleted = 0;
      for (const [id, row] of [...this.rows]) {
        if (deleted >= limit) break;
        if (row.expiresAt < now) {
          this.rows.delete(id);
          deleted++;
        }
      }
      return { rows: [], rowCount: deleted };
    }

    if (normalised.startsWith('SELECT')) {
      const [userId, endpoint, key] = params as [string, string, string];
      const row = this.rows.get(this.id(userId, endpoint, key));
      if (!row) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            request_hash: row.requestHash,
            response_status: row.responseStatus,
            response_body: row.responseBody,
          } as R,
        ],
        rowCount: 1,
      };
    }

    return { rows: [], rowCount: 0 };
  }
}

const RIDE_BODY = {
  pickup: { lat: 33.3061, lng: 44.4213 },
  dropoff: { lat: 33.2989, lng: 44.4361 },
};

describe('stableStringify', () => {
  it('is insensitive to key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('sorts nested keys too', () => {
    expect(stableStringify({ o: { x: 1, y: 2 } })).toBe(stableStringify({ o: { y: 2, x: 1 } }));
  });

  it('preserves array order, which is meaningful', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('treats an absent key and an undefined value alike, as JSON does', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it('distinguishes different values', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
    expect(stableStringify(null)).not.toBe(stableStringify(0));
  });
});

describe('IdempotencyService', () => {
  let clock: FakeClock;
  let store: FakeKeyStore;
  let service: IdempotencyService;

  beforeEach(() => {
    clock = new FakeClock();
    store = new FakeKeyStore();
    service = new IdempotencyService(clock, 86_400);
  });

  it('rejects a non-positive TTL', () => {
    expect(() => new IdempotencyService(clock, 0)).toThrow(/positive integer/);
  });

  describe('fingerprint', () => {
    it('is stable across key ordering', () => {
      expect(service.fingerprint({ a: 1, b: 2 })).toBe(service.fingerprint({ b: 2, a: 1 }));
    });

    it('changes when the body changes', () => {
      expect(service.fingerprint({ a: 1 })).not.toBe(service.fingerprint({ a: 2 }));
    });
  });

  // -------------------------------------------------------------------------
  // Case 1: new key.
  // -------------------------------------------------------------------------

  it('runs the work once for a new key', async () => {
    let calls = 0;
    const outcome = await service.run(
      store,
      { userId: USER, endpoint: ENDPOINT, key: 'k1', body: RIDE_BODY },
      async () => {
        calls++;
        return { status: 201, value: { id: 'ride-1' } };
      },
    );

    expect(calls).toBe(1);
    expect(outcome.fresh).toBe(true);
    expect(outcome.value).toEqual({ id: 'ride-1' });
  });

  // -------------------------------------------------------------------------
  // Case 2: same key, same body. THE case from CLAUDE.md §5.2.
  // -------------------------------------------------------------------------

  it('returns the original ride on a retry and does not create a second one', async () => {
    let calls = 0;
    const work = async () => {
      calls++;
      return { status: 201, value: { id: `ride-${calls}` } };
    };

    const first = await service.run(
      store, { userId: USER, endpoint: ENDPOINT, key: 'k1', body: RIDE_BODY }, work,
    );
    const second = await service.run(
      store, { userId: USER, endpoint: ENDPOINT, key: 'k1', body: RIDE_BODY }, work,
    );

    expect(calls).toBe(1);
    expect(second.fresh).toBe(false);
    expect(second.value).toEqual(first.value);
  });

  // ACCEPTANCE_CHECKLIST.md check 3: "press request 5 times quickly - only ONE
  // ride is created".
  it('creates exactly one ride when the same request is sent five times', async () => {
    let created = 0;
    const work = async () => {
      created++;
      return { status: 201, value: { id: `ride-${created}` } };
    };

    const outcomes = [];
    for (let i = 0; i < 5; i++) {
      outcomes.push(
        await service.run(
          store, { userId: USER, endpoint: ENDPOINT, key: 'same-key', body: RIDE_BODY }, work,
        ),
      );
    }

    expect(created).toBe(1);
    expect(new Set(outcomes.map((o) => (o.value as { id: string }).id)).size).toBe(1);
    expect(outcomes.filter((o) => o.fresh)).toHaveLength(1);
  });

  it('is insensitive to key ordering in the retried body', async () => {
    let calls = 0;
    const work = async () => {
      calls++;
      return { status: 201, value: { id: 'ride-1' } };
    };

    await service.run(
      store,
      { userId: USER, endpoint: ENDPOINT, key: 'k1', body: { a: 1, b: 2 } },
      work,
    );
    await service.run(
      store,
      { userId: USER, endpoint: ENDPOINT, key: 'k1', body: { b: 2, a: 1 } },
      work,
    );

    expect(calls).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Case 3: same key, different body.
  // -------------------------------------------------------------------------

  it('rejects the same key with a different body rather than guessing', async () => {
    await service.run(
      store, { userId: USER, endpoint: ENDPOINT, key: 'k1', body: RIDE_BODY },
      async () => ({ status: 201, value: { id: 'ride-1' } }),
    );

    await expect(
      service.run(
        store,
        {
          userId: USER, endpoint: ENDPOINT, key: 'k1',
          body: { ...RIDE_BODY, dropoff: { lat: 33.4, lng: 44.5 } },
        },
        async () => ({ status: 201, value: { id: 'ride-2' } }),
      ),
    ).rejects.toThrow(IdempotencyKeyReusedError);
  });

  // -------------------------------------------------------------------------
  // Case 4: concurrent retry while the original is still running.
  // -------------------------------------------------------------------------

  it('does not run the work twice when the same key arrives concurrently', async () => {
    let started = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const work = async () => {
      started++;
      await gate;
      return { status: 201, value: { id: `ride-${started}` } };
    };

    const first = service.run(
      store, { userId: USER, endpoint: ENDPOINT, key: 'k1', body: RIDE_BODY }, work,
    );
    // Second request arrives before the first has answered.
    const second = service
      .run(store, { userId: USER, endpoint: ENDPOINT, key: 'k1', body: RIDE_BODY }, work)
      .catch((error: unknown) => error);

    const secondResult = await second;
    release();
    await first;

    expect(started).toBe(1);
    expect(secondResult).toBeInstanceOf(IdempotencyInProgressError);
    expect((secondResult as IdempotencyInProgressError).status).toBe(409);
  });

  // -------------------------------------------------------------------------
  // Failure must not poison the key.
  // -------------------------------------------------------------------------

  it('releases the key when the work fails, so a retry can succeed', async () => {
    await expect(
      service.run(
        store, { userId: USER, endpoint: ENDPOINT, key: 'k1', body: RIDE_BODY },
        async () => {
          throw new Error('no drivers available');
        },
      ),
    ).rejects.toThrow('no drivers available');

    // The key is free again - otherwise the rider could never create this ride.
    const retry = await service.run(
      store, { userId: USER, endpoint: ENDPOINT, key: 'k1', body: RIDE_BODY },
      async () => ({ status: 201, value: { id: 'ride-1' } }),
    );

    expect(retry.fresh).toBe(true);
    expect(retry.value).toEqual({ id: 'ride-1' });
  });

  it('does not release a key whose work already succeeded', async () => {
    await service.run(
      store, { userId: USER, endpoint: ENDPOINT, key: 'k1', body: RIDE_BODY },
      async () => ({ status: 201, value: { id: 'ride-1' } }),
    );

    let calls = 0;
    await service.run(
      store, { userId: USER, endpoint: ENDPOINT, key: 'k1', body: RIDE_BODY },
      async () => {
        calls++;
        return { status: 201, value: { id: 'ride-2' } };
      },
    );

    expect(calls).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Scoping. A key is scoped to a user AND an endpoint.
  // -------------------------------------------------------------------------

  it('scopes keys per user, so two riders may use the same key text', async () => {
    let calls = 0;
    const work = async () => {
      calls++;
      return { status: 201, value: { id: `ride-${calls}` } };
    };

    await service.run(store, { userId: USER, endpoint: ENDPOINT, key: 'k', body: RIDE_BODY }, work);
    await service.run(
      store, { userId: OTHER_USER, endpoint: ENDPOINT, key: 'k', body: RIDE_BODY }, work,
    );

    expect(calls).toBe(2);
  });

  it('scopes keys per endpoint', async () => {
    let calls = 0;
    const work = async () => {
      calls++;
      return { status: 201, value: { id: `x-${calls}` } };
    };

    await service.run(store, { userId: USER, endpoint: 'POST /rides', key: 'k', body: {} }, work);
    await service.run(
      store, { userId: USER, endpoint: 'POST /admin/topup', key: 'k', body: {} }, work,
    );

    expect(calls).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Expiry
  // -------------------------------------------------------------------------

  describe('purgeExpired', () => {
    it('removes keys past their TTL and keeps live ones', async () => {
      await service.run(
        store, { userId: USER, endpoint: ENDPOINT, key: 'old', body: RIDE_BODY },
        async () => ({ status: 201, value: { id: 'ride-1' } }),
      );

      clock.advanceSeconds(86_400 + 1);

      await service.run(
        store, { userId: USER, endpoint: ENDPOINT, key: 'new', body: RIDE_BODY },
        async () => ({ status: 201, value: { id: 'ride-2' } }),
      );

      expect(await service.purgeExpired(store)).toBe(1);
      expect(store.rows.size).toBe(1);
    });

    it('honours the limit so one sweep cannot lock the table', async () => {
      for (let i = 0; i < 5; i++) {
        await service.run(
          store, { userId: USER, endpoint: ENDPOINT, key: `k${i}`, body: RIDE_BODY },
          async () => ({ status: 201, value: { id: `ride-${i}` } }),
        );
      }
      clock.advanceSeconds(86_401);

      expect(await service.purgeExpired(store, 2)).toBe(2);
      expect(store.rows.size).toBe(3);
    });
  });
});
