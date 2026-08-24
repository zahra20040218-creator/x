import { readFile } from 'node:fs/promises';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeClock } from '../../src/common/clock.js';
import {
  DriverComplianceService,
  type DriverDocumentType,
} from '../../src/compliance/driver-compliance.service.js';
import type { PgDatabase } from '../../src/db/pg-database.js';
import { PlatformConfigService } from '../../src/platform-config/platform-config.service.js';
import {
  assertRealDatabase,
  createRealDatabase,
  isRealInfraRequested,
  truncateAll,
} from '../support/real-infra.js';

/**
 * Driver document compliance, against a real PostgreSQL.
 *
 * The unit tests cover the decision. These cover the things only a real
 * database can answer: that the enum casts in the `ANY(...)` clauses are
 * accepted, that the upsert on `(driver_id, doc_type)` really is an upsert,
 * that the CHECK constraint refuses a verified document with no verifier, and
 * that a DATE column round-trips without a timezone shifting the expiry by a
 * day.
 */

const DRIVER_A = '00000000-0000-4000-8000-0000000000c1';
const DRIVER_B = '00000000-0000-4000-8000-0000000000c2';
const ADMIN = '00000000-0000-4000-8000-0000000000a1';

const NOW = new Date('2026-08-24T09:00:00.000Z');

describe.skipIf(!isRealInfraRequested())('driver compliance on real PostgreSQL', () => {
  let db: PgDatabase;

  beforeAll(() => {
    // Synchronous: it constructs a pool, it does not connect.
    db = createRealDatabase();
    assertRealDatabase(db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);

    await db.query(
      `INSERT INTO users (id, role, phone_e164, display_name)
       VALUES ($1,'DRIVER','+9647700000021','سائق أ'),
              ($2,'DRIVER','+9647700000022','سائق ب'),
              ($3,'ADMIN','+9647700000023','مدير')`,
      [DRIVER_A, DRIVER_B, ADMIN],
    );
    await db.query(
      `INSERT INTO drivers (user_id, vehicle_plate, vehicle_model, vehicle_color)
       VALUES ($1,'11111','Corolla','أبيض'), ($2,'22222','Rio','أسود')`,
      [DRIVER_A, DRIVER_B],
    );

    // truncateAll empties platform_config along with everything else, so the
    // row migration 0010 seeds is gone by the time a test runs. Re-created
    // here to mirror a real deployment. Worth knowing generally: any
    // integration test that reads configuration is otherwise running on the
    // built-in defaults, not on what the migrations seeded.
    await db.query(
      `INSERT INTO platform_config (key, value) VALUES ('required_driver_documents', '')`,
    );
  });

  function serviceFor(required: DriverDocumentType[], now = NOW): DriverComplianceService {
    return new DriverComplianceService(new FakeClock(now), () => Promise.resolve(required));
  }

  async function record(
    driverId: string,
    docType: DriverDocumentType,
    status: 'PENDING' | 'VERIFIED' | 'REJECTED',
    expiresAt: string | null = null,
  ): Promise<void> {
    const verifying = status === 'VERIFIED';
    await db.query(
      `INSERT INTO driver_documents
         (driver_id, doc_type, status, expires_at, verified_by, verified_at)
       VALUES ($1, $2::driver_document_type, $3::driver_document_status, $4::date, $5, $6)
       ON CONFLICT (driver_id, doc_type) DO UPDATE SET
         status = EXCLUDED.status,
         expires_at = EXCLUDED.expires_at,
         verified_by = EXCLUDED.verified_by,
         verified_at = EXCLUDED.verified_at`,
      [driverId, docType, status, expiresAt, verifying ? ADMIN : null, verifying ? NOW : null],
    );
  }

  describe('the schema', () => {
    it('refuses a verified document with no verifier', async () => {
      // The question asked after an incident is who approved it. A row that
      // cannot answer that is an audit trail with a hole in it.
      await expect(
        db.query(
          `INSERT INTO driver_documents (driver_id, doc_type, status)
           VALUES ($1, 'DRIVING_LICENCE', 'VERIFIED')`,
          [DRIVER_A],
        ),
      ).rejects.toThrow(/driver_documents_verified_has_verifier/);
    });

    it('holds one row per document per driver', async () => {
      await record(DRIVER_A, 'DRIVING_LICENCE', 'PENDING');
      await record(DRIVER_A, 'DRIVING_LICENCE', 'VERIFIED', '2027-01-01');

      const rows = await db.query<{ status: string }>(
        `SELECT status FROM driver_documents WHERE driver_id = $1`,
        [DRIVER_A],
      );

      // Renewing a licence updates the record. Two rows would leave no rule
      // for which one is current.
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.status).toBe('VERIFIED');
    });

    it('rejects a document type outside the enum', async () => {
      await expect(
        db.query(
          `INSERT INTO driver_documents (driver_id, doc_type, status)
           VALUES ($1, 'PASSPORT', 'PENDING')`,
          [DRIVER_A],
        ),
      ).rejects.toThrow();
    });
  });

  describe('the queries the service actually issues', () => {
    it('evaluates one driver', async () => {
      await record(DRIVER_A, 'DRIVING_LICENCE', 'VERIFIED', '2027-01-01');

      const verdict = await serviceFor(['DRIVING_LICENCE']).evaluate(db, DRIVER_A);

      expect(verdict.compliant).toBe(true);
    });

    it('filters a candidate set in one query', async () => {
      await record(DRIVER_A, 'DRIVING_LICENCE', 'VERIFIED', '2027-01-01');
      await record(DRIVER_B, 'DRIVING_LICENCE', 'PENDING');

      const allowed = await serviceFor(['DRIVING_LICENCE']).filterCompliant(db, [
        DRIVER_A,
        DRIVER_B,
      ]);

      expect(allowed).toEqual(new Set([DRIVER_A]));
    });

    it('excludes a driver with no documents at all', async () => {
      const allowed = await serviceFor(['NATIONAL_ID']).filterCompliant(db, [DRIVER_A, DRIVER_B]);

      expect(allowed).toEqual(new Set());
    });
  });

  describe('expiry across a real DATE column', () => {
    it('a licence expiring today is still valid today', async () => {
      // The trap: pg returns a DATE as local midnight. Comparing it to an
      // instant without accounting for that stops a driver a day early - or
      // late, depending on which side of UTC the box sits.
      await record(DRIVER_A, 'DRIVING_LICENCE', 'VERIFIED', '2026-08-24');

      const verdict = await serviceFor(['DRIVING_LICENCE']).evaluate(db, DRIVER_A);

      expect(verdict.compliant).toBe(true);
    });

    it('and has lapsed the next day', async () => {
      await record(DRIVER_A, 'DRIVING_LICENCE', 'VERIFIED', '2026-08-24');

      const verdict = await serviceFor(
        ['DRIVING_LICENCE'],
        new Date('2026-08-25T09:00:00.000Z'),
      ).evaluate(db, DRIVER_A);

      expect(verdict.compliant).toBe(false);
      expect(verdict.expired).toEqual(['DRIVING_LICENCE']);
    });
  });

  describe('the configured policy', () => {
    it('is empty when the row exists but is unset', async () => {
      const config = new PlatformConfigService(new FakeClock(NOW));
      expect(await config.requiredDriverDocuments(db)).toEqual([]);
    });

    it('is empty when the row is missing entirely', async () => {
      // A database migrated before 0010, or a hand-edited one. Absent must
      // mean disabled: the alternative is blocking every driver in the city
      // because a config row went missing.
      await db.query(`DELETE FROM platform_config WHERE key = 'required_driver_documents'`);

      const config = new PlatformConfigService(new FakeClock(NOW));
      expect(await config.requiredDriverDocuments(db)).toEqual([]);
    });

    it('migration 0010 seeds it EMPTY, which is the legal assumption guard', async () => {
      // Asserted against the migration itself rather than the live row,
      // because truncateAll wipes the seeded value - so a runtime check here
      // would pass whether the migration seeds '' or does not seed at all.
      //
      // If this fails, someone has made a document mandatory by default.
      // Which documents Iraqi law requires is not a question this repository
      // is entitled to answer.
      const sql = await readFile(
        new URL('../../migrations/0010_driver_documents.up.sql', import.meta.url),
        'utf8',
      );

      expect(sql).toContain("('required_driver_documents', ''");
      expect(sql).not.toMatch(/\('required_driver_documents',\s*'[A-Z]/);
    });

    it('is read from platform_config without a deploy', async () => {
      await db.query(
        `UPDATE platform_config SET value = 'DRIVING_LICENCE'
          WHERE key = 'required_driver_documents'`,
      );

      const config = new PlatformConfigService(new FakeClock(NOW));
      expect(await config.requiredDriverDocuments(db)).toEqual(['DRIVING_LICENCE']);
    });

    it('ignores a typo without taking matching down', async () => {
      await db.query(
        `UPDATE platform_config SET value = 'DRIVING_LICENCE,PASPORT'
          WHERE key = 'required_driver_documents'`,
      );

      const ignored: string[] = [];
      const config = new PlatformConfigService(new FakeClock(NOW));
      const required = await config.requiredDriverDocuments(db, (v) => ignored.push(v));

      expect(required).toEqual(['DRIVING_LICENCE']);
      expect(ignored).toEqual(['PASPORT']);
    });
  });
});
