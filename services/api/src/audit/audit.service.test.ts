import { beforeEach, describe, expect, it } from 'vitest';

import { runWithRequestContext } from '../common/logger.js';
import type { Queryable, QueryResult, SqlValue } from '../db/db.port.js';
import { AUDIT_ACTIONS, AuditService, scrub } from './audit.service.js';

const ADMIN = 'aaaa0000-0000-4000-8000-000000000001';
const DRIVER = 'dddd0000-0000-4000-8000-000000000001';

class FakeAuditDb implements Queryable {
  rows: Array<Record<string, unknown>> = [];
  failNext: Error | null = null;

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<QueryResult<Row>> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }

    if (/^INSERT INTO audit_log/i.test(sql.trim())) {
      this.rows.push({
        actor_id: params[0], actor_role: params[1], action: params[2],
        target_type: params[3], target_id: params[4], result: params[5],
        correlation_id: params[6], metadata: JSON.parse(params[7] as string),
      });
      return { rows: [], rowCount: 1 };
    }

    return { rows: this.rows as Row[], rowCount: this.rows.length };
  }
}

describe('AuditService', () => {
  let db: FakeAuditDb;
  let audit: AuditService;

  beforeEach(() => {
    db = new FakeAuditDb();
    audit = new AuditService();
  });

  it('records every field the brief requires', async () => {
    await runWithRequestContext({ requestId: 'req-123' }, async () => {
      await audit.record(db, {
        actorId: ADMIN,
        actorRole: 'ADMIN',
        action: AUDIT_ACTIONS.walletTopUp,
        targetType: 'driver',
        targetId: DRIVER,
        result: 'SUCCESS',
        metadata: { amountIqd: 10_000 },
      });
    });

    const row = db.rows[0]!;
    // adminId, action, timestamp, correlationId, target, result.
    expect(row['actor_id']).toBe(ADMIN);
    expect(row['action']).toBe('wallet.topup');
    expect(row['target_type']).toBe('driver');
    expect(row['target_id']).toBe(DRIVER);
    expect(row['result']).toBe('SUCCESS');
    expect(row['correlation_id']).toBe('req-123');
  });

  // A log of successes only cannot answer "did someone try and get refused?",
  // which is where an incident investigation starts.
  it('records failures, not only successes', async () => {
    await audit.recordFailure(db, {
      actorId: ADMIN,
      actorRole: 'ADMIN',
      action: AUDIT_ACTIONS.walletTopUp,
      targetType: 'driver',
      targetId: DRIVER,
      reason: 'driver not found',
    });

    const row = db.rows[0]!;
    expect(row['result']).toBe('FAILURE');
    expect((row['metadata'] as Record<string, unknown>)['reason']).toBe('driver not found');
  });

  // Auditing must never break the audited action: an INSERT failure here would
  // otherwise roll back a legitimate wallet credit.
  it('swallows its own write failure rather than breaking the action', async () => {
    db.failNext = new Error('audit table is gone');

    await expect(
      audit.record(db, {
        actorId: ADMIN,
        actorRole: 'ADMIN',
        action: AUDIT_ACTIONS.walletTopUp,
        targetType: 'driver',
        targetId: DRIVER,
        result: 'SUCCESS',
      }),
    ).resolves.toBeUndefined();
  });

  it('logs loudly when it cannot write, so the swallow is not silent', async () => {
    const logged: Array<Record<string, unknown>> = [];
    const loud = new AuditService({
      error: (payload: Record<string, unknown>) => logged.push(payload),
    } as never);

    db.failNext = new Error('disk full');
    await loud.record(db, {
      actorId: ADMIN,
      actorRole: 'ADMIN',
      action: AUDIT_ACTIONS.configUpdate,
      targetType: 'platform_config',
      result: 'SUCCESS',
    });

    expect(logged).toHaveLength(1);
    expect(logged[0]!['event']).toBe('audit.write_failed');
  });

  it('falls back to a marker when there is no request context', async () => {
    await audit.record(db, {
      actorId: ADMIN,
      actorRole: 'ADMIN',
      action: AUDIT_ACTIONS.driverCreate,
      targetType: 'driver',
      targetId: DRIVER,
      result: 'SUCCESS',
    });

    expect(db.rows[0]!['correlation_id']).toBe('no-request-context');
  });

  // The audit log is read by operators and exported for disputes, so it is a
  // plausible route for PII to escape (CLAUDE.md §9).
  describe('PII scrubbing', () => {
    it.each([
      'phone', 'phone_e164', 'displayName', 'name',
      'lat', 'lng', 'latitude', 'longitude',
      'token', 'accessToken', 'refreshToken', 'password', 'secret',
    ])('redacts %s', (key) => {
      expect(scrub({ [key]: 'sensitive' })[key]).toBe('[redacted]');
    });

    it('redacts nested PII', () => {
      const scrubbed = scrub({ driver: { phone: '+9647700000001', id: 'd1' } });
      expect(JSON.stringify(scrubbed)).not.toContain('964');
      expect(JSON.stringify(scrubbed)).toContain('d1');
    });

    it('keeps the values an operator actually needs', () => {
      const scrubbed = scrub({ amountIqd: 10_000, transactionId: 'tx-1', outcome: 'RESOLVED' });
      expect(scrubbed).toEqual({
        amountIqd: 10_000,
        transactionId: 'tx-1',
        outcome: 'RESOLVED',
      });
    });

    it('scrubs on the way into the database, not just in logs', async () => {
      await audit.record(db, {
        actorId: ADMIN,
        actorRole: 'ADMIN',
        action: AUDIT_ACTIONS.driverCreate,
        targetType: 'driver',
        targetId: DRIVER,
        result: 'SUCCESS',
        metadata: { phone: '+9647700000001', vehiclePlate: '12345' },
      });

      const metadata = db.rows[0]!['metadata'] as Record<string, unknown>;
      expect(metadata['phone']).toBe('[redacted]');
      expect(metadata['vehiclePlate']).toBe('12345');
    });
  });

  describe('the action vocabulary', () => {
    // A closed set, so a typo is a compile error and the admin UI can filter
    // on values that actually exist.
    it('covers every money-moving and access-changing admin action', () => {
      expect(Object.values(AUDIT_ACTIONS)).toEqual(
        expect.arrayContaining([
          'driver.create',
          'driver.suspend',
          'driver.unsuspend',
          'wallet.topup',
          'dispute.resolve',
          'config.update',
        ]),
      );
    });

    it('uses stable dotted verbs', () => {
      for (const action of Object.values(AUDIT_ACTIONS)) {
        expect(action).toMatch(/^[a-z_]+\.[a-z_]+$/);
      }
    });
  });

  describe('queries', () => {
    it('reads back by actor and by target', async () => {
      await audit.record(db, {
        actorId: ADMIN,
        actorRole: 'ADMIN',
        action: AUDIT_ACTIONS.driverSuspend,
        targetType: 'driver',
        targetId: DRIVER,
        result: 'SUCCESS',
      });

      expect(await audit.listForActor(db, ADMIN)).toHaveLength(1);
      expect(await audit.listForTarget(db, 'driver', DRIVER)).toHaveLength(1);
    });
  });
});
