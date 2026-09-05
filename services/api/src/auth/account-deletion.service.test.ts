import { describe, expect, it } from 'vitest';

import { FakeClock } from '../common/clock.js';
import { ConflictProblem, NotFoundProblem } from '../common/problem.js';
import type { Database, QueryResult, SqlValue, Transaction } from '../db/db.port.js';
import { AccountDeletionService, type SessionRevoker } from './account-deletion.service.js';

/**
 * Erasing an account.
 *
 * This is the most destructive operation a user can invoke on themselves and
 * it is irreversible, so what is asserted here is mostly what it REFUSES and
 * what it leaves alone. The happy path is one statement; the ways it can
 * quietly do harm are several.
 *
 * A recording fake rather than `FakeDatabase`: what matters is the exact set
 * of statements issued and their order, and a recorder shows that directly.
 * The schema-level guarantees this relies on - eighteen ON DELETE RESTRICT
 * foreign keys, the append-only ledger triggers, the phone format CHECK - live
 * in Postgres and are not modelled here. Assertions below are about the
 * SERVICE.
 */

const USER = '11111111-0000-4000-8000-000000000001';
const NOW = new Date('2026-04-01T10:00:00.000Z');

interface Recorded {
  sql: string;
  params: readonly SqlValue[];
}

class RecordingDb implements Database {
  readonly statements: Recorded[] = [];

  constructor(
    private readonly reply: (sql: string) => { rows: Array<Record<string, unknown>> } = () => ({
      rows: [],
    }),
  ) {}

  query<T>(sql: string, params: readonly SqlValue[] = []): Promise<QueryResult<T>> {
    this.statements.push({ sql, params });
    const { rows } = this.reply(sql);
    return Promise.resolve({ rows: rows as T[], rowCount: rows.length });
  }

  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return work(this as unknown as Transaction);
  }

  matching(fragment: string): Recorded[] {
    return this.statements.filter((s) => s.sql.includes(fragment));
  }

  indexOf(fragment: string): number {
    return this.statements.findIndex((s) => s.sql.includes(fragment));
  }

  // Part of the Database port and irrelevant here: this fake is never pooled
  // and never shut down.
  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** A user who exists, is not deleted, and has no live ride. */
function ordinary(sql: string): { rows: Array<Record<string, unknown>> } {
  if (sql.includes('SELECT deleted_at')) return { rows: [{ deleted_at: null }] };
  return { rows: [] };
}

/**
 * Revocation, recorded as a statement so the ORDER can be asserted.
 *
 * The real `TokenService.revokeAllForUser` issues an UPDATE against
 * `refresh_tokens`; this issues the same shape, because what the tests care
 * about is that it happens and that it happens FIRST.
 */
const revoker: SessionRevoker = {
  async revokeAllForUser(q, userId) {
    await q.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1`, [userId]);
    return 1;
  },
};

function make(db: RecordingDb): AccountDeletionService {
  return new AccountDeletionService(db, revoker, new FakeClock(NOW));
}

describe('AccountDeletionService — what it refuses', () => {
  it('refuses while a ride is in progress, and names the ride', async () => {
    const db = new RecordingDb((sql) => {
      if (sql.includes('SELECT deleted_at')) return { rows: [{ deleted_at: null }] };
      if (sql.includes('FROM rides')) return { rows: [{ id: 'ride-1' }] };
      return { rows: [] };
    });

    // Erasing a rider mid-trip leaves a driver carrying a passenger the system
    // cannot name; erasing a driver mid-trip leaves a rider in a car nobody is
    // tracking. Neither is recoverable by an apology.
    await expect(make(db).deleteOwnAccount(USER)).rejects.toBeInstanceOf(ConflictProblem);

    // And nothing was erased on the way to refusing.
    expect(db.matching('UPDATE users')).toHaveLength(0);
    expect(db.matching('DELETE FROM device_tokens')).toHaveLength(0);
    expect(db.matching('DELETE FROM driver_location_history')).toHaveLength(0);
  });

  it('checks BOTH sides of a ride, not just the rider', async () => {
    const db = new RecordingDb(ordinary);
    await make(db).deleteOwnAccount(USER);

    // One person can be a rider on one ride and a driver on another.
    const [check] = db.matching('FROM rides');
    expect(check!.sql).toContain('rider_id = $1 OR driver_id = $1');
  });

  it('treats only the live statuses as blocking', async () => {
    const db = new RecordingDb(ordinary);
    await make(db).deleteOwnAccount(USER);

    const [check] = db.matching('FROM rides');
    for (const live of ['REQUESTED', 'OFFERED', 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS']) {
      expect(check!.sql).toContain(live);
    }
    // A completed or cancelled ride must never block deletion - that would make
    // the right conditional on having no history, which is backwards.
    expect(check!.sql).not.toContain('COMPLETED');
  });

  it('404s an account that does not exist', async () => {
    const db = new RecordingDb(() => ({ rows: [] }));
    await expect(make(db).deleteOwnAccount(USER)).rejects.toBeInstanceOf(NotFoundProblem);
  });

  it('is idempotent — deleting twice is a no-op, not an error', async () => {
    // A client retrying after a dropped response must not be told it failed.
    const db = new RecordingDb((sql) =>
      sql.includes('SELECT deleted_at') ? { rows: [{ deleted_at: NOW }] } : { rows: [] },
    );

    await expect(make(db).deleteOwnAccount(USER)).resolves.toBeUndefined();
    expect(db.matching('UPDATE users')).toHaveLength(0);
  });
});

describe('AccountDeletionService — what it erases', () => {
  it('severs credentials BEFORE erasing anything else', async () => {
    const db = new RecordingDb(ordinary);
    await make(db).deleteOwnAccount(USER);

    // Order is the point: a request racing this transaction must not be able to
    // authenticate against an account halfway through being erased.
    const revoke = db.indexOf('refresh_tokens');
    const update = db.indexOf('UPDATE users');
    expect(revoke).toBeGreaterThanOrEqual(0);
    expect(revoke).toBeLessThan(update);
  });

  it('erases device tokens, or the next person on this handset gets the notifications', async () => {
    const db = new RecordingDb(ordinary);
    await make(db).deleteOwnAccount(USER);
    expect(db.matching('DELETE FROM device_tokens')).toHaveLength(1);
  });

  it('erases location history immediately rather than waiting for the sweep', async () => {
    const db = new RecordingDb(ordinary);
    await make(db).deleteOwnAccount(USER);

    // The 90-day retention job would eventually take it. A deletion request
    // should not have to wait 90 days.
    const [purge] = db.matching('DELETE FROM driver_location_history');
    expect(purge!.params[0]).toBe(USER);
  });

  it('writes a tombstone phone that cannot collide with a real subscriber', async () => {
    const db = new RecordingDb(ordinary);
    await make(db).deleteOwnAccount(USER);

    const [update] = db.matching('UPDATE users');
    // `+9640…`: satisfies `users_phone_e164_format` (+964 then ten digits) and
    // is impossible as a real number, because Iraqi mobiles always carry a 7
    // after the country code.
    expect(update!.sql).toContain("'+9640'");
    // A sequence, not a hash. A hash collision would fail the unique index
    // mid-deletion on a user already told the request succeeded.
    expect(update!.sql).toContain('nextval');
    expect(update!.sql).not.toContain('hashtext');
  });

  it('nulls the Firebase uid rather than tombstoning it', async () => {
    const db = new RecordingDb(ordinary);
    await make(db).deleteOwnAccount(USER);

    // It is UNIQUE only WHERE NOT NULL. Leaving it set would let the same
    // Firebase identity resolve straight back to this row on the next sign-in.
    const [update] = db.matching('UPDATE users');
    expect(update!.sql).toContain('firebase_uid = NULL');
  });

  it('deactivates and stamps the deletion time from the injected clock', async () => {
    const db = new RecordingDb(ordinary);
    await make(db).deleteOwnAccount(USER);

    const [update] = db.matching('UPDATE users');
    expect(update!.sql).toContain('is_active    = FALSE');
    // `toContainEqual`, not `toContain`: `FakeClock.now()` returns a fresh
    // `Date` on every call, so an identity comparison would never match even
    // though the value is right.
    expect(update!.params).toContainEqual(NOW);
  });

  it('takes a deleted driver offline in the same transaction', async () => {
    const db = new RecordingDb(ordinary);
    await make(db).deleteOwnAccount(USER);

    // A deleted driver left ONLINE would keep receiving dispatches until the
    // presence sweep noticed.
    const [offline] = db.matching('UPDATE drivers');
    expect(offline!.sql).toContain("availability = 'OFFLINE'");
  });

  it('never touches the ledger', async () => {
    const db = new RecordingDb(ordinary);
    await make(db).deleteOwnAccount(USER);

    // CLAUDE.md §6.3: append-only, enforced by database triggers. The money
    // survives the person, pointing at an anonymous id - which is exactly what
    // `docs/PLAY_LISTING.md` discloses.
    expect(db.matching('ledger_entries')).toHaveLength(0);
    expect(db.matching('DELETE FROM rides')).toHaveLength(0);
    expect(db.matching('DELETE FROM payments')).toHaveLength(0);
  });
});
