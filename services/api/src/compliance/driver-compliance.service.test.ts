import { describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../common/clock.js';
import type { Queryable, QueryResult, SqlValue } from '../db/db.port.js';
import {
  DriverComplianceService,
  parseRequiredDocuments,
  type DriverDocumentStatus,
  type DriverDocumentType,
} from './driver-compliance.service.js';

/**
 * Driver document compliance.
 *
 * The feature is disabled by default, and the first group is the one that
 * matters most: with no requirement configured, nothing changes and no query is
 * issued. Everything after it only applies once an owner has turned it on with
 * legal advice behind them.
 */

const NOW = new Date('2026-08-24T09:00:00.000Z');
const DRIVER = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';

interface Doc {
  driver_id?: string;
  doc_type: DriverDocumentType;
  status: DriverDocumentStatus;
  expires_at: Date | null;
}

/** Records the SQL issued, so "no query at all" is testable. */
class StubDb implements Queryable {
  readonly queries: string[] = [];

  constructor(private readonly rows: Doc[] = []) {}

  query<Row = Record<string, unknown>>(
    sql: string,
    _params?: readonly SqlValue[],
  ): Promise<QueryResult<Row>> {
    this.queries.push(sql);
    return Promise.resolve({
      rows: this.rows as unknown as Row[],
      rowCount: this.rows.length,
    });
  }
}

function serviceFor(
  required: DriverDocumentType[],
  rows: Doc[] = [],
  now: Date = NOW,
): { service: DriverComplianceService; db: StubDb } {
  const db = new StubDb(rows);
  return {
    service: new DriverComplianceService(new FakeClock(now), () => Promise.resolve(required)),
    db,
  };
}

const verified = (
  doc_type: DriverDocumentType,
  expires_at: Date | null = null,
  driver_id = DRIVER,
): Doc => ({ driver_id, doc_type, status: 'VERIFIED', expires_at });

describe('driver compliance', () => {
  describe('disabled, which is the default', () => {
    it('treats every driver as compliant', async () => {
      const { service, db } = serviceFor([]);

      const verdict = await service.evaluate(db, DRIVER);

      expect(verdict.compliant).toBe(true);
      expect(verdict.missing).toEqual([]);
    });

    it('issues no query at all', async () => {
      const { service, db } = serviceFor([]);

      await service.evaluate(db, DRIVER);
      await service.filterCompliant(db, [DRIVER, OTHER]);

      // Not "a check that passes" - the absence of a check. An empty
      // requirement list must not put the document table on the hot path.
      expect(db.queries).toEqual([]);
    });

    it('lets every candidate through matching', async () => {
      const { service, db } = serviceFor([]);

      expect(await service.filterCompliant(db, [DRIVER, OTHER])).toEqual(
        new Set([DRIVER, OTHER]),
      );
    });
  });

  describe('once a requirement is configured', () => {
    it('blocks a driver who has never supplied the document', async () => {
      const { service, db } = serviceFor(['DRIVING_LICENCE'], []);

      const verdict = await service.evaluate(db, DRIVER);

      expect(verdict.compliant).toBe(false);
      // Named, so the driver can be told what to bring. "Not eligible" is not
      // something anyone can act on.
      expect(verdict.missing).toEqual(['DRIVING_LICENCE']);
    });

    it('blocks a document still awaiting review', async () => {
      const { service, db } = serviceFor(
        ['DRIVING_LICENCE'],
        [{ doc_type: 'DRIVING_LICENCE', status: 'PENDING', expires_at: null }],
      );

      const verdict = await service.evaluate(db, DRIVER);

      expect(verdict.compliant).toBe(false);
      expect(verdict.missing).toEqual(['DRIVING_LICENCE']);
    });

    it('reports a rejection separately from a missing document', async () => {
      const { service, db } = serviceFor(
        ['DRIVING_LICENCE'],
        [{ doc_type: 'DRIVING_LICENCE', status: 'REJECTED', expires_at: null }],
      );

      const verdict = await service.evaluate(db, DRIVER);

      // The driver has already been told why. Sending them to supply the same
      // document again wastes their trip to the office.
      expect(verdict.rejected).toEqual(['DRIVING_LICENCE']);
      expect(verdict.missing).toEqual([]);
    });

    it('allows a verified document with no expiry recorded', async () => {
      const { service, db } = serviceFor(['NATIONAL_ID'], [verified('NATIONAL_ID')]);

      expect((await service.evaluate(db, DRIVER)).compliant).toBe(true);
    });

    it('requires every configured document, not just one', async () => {
      const { service, db } = serviceFor(
        ['NATIONAL_ID', 'DRIVING_LICENCE'],
        [verified('NATIONAL_ID')],
      );

      const verdict = await service.evaluate(db, DRIVER);

      expect(verdict.compliant).toBe(false);
      expect(verdict.missing).toEqual(['DRIVING_LICENCE']);
    });

    it('ignores documents that are held but not required', async () => {
      const { service, db } = serviceFor(
        ['NATIONAL_ID'],
        [verified('NATIONAL_ID'), verified('VEHICLE_AUTHORIZATION')],
      );

      expect((await service.evaluate(db, DRIVER)).compliant).toBe(true);
    });
  });

  describe('expiry', () => {
    it('a document is valid all through its printed date', async () => {
      // Expires today, and it is 09:00. A licence dated the 24th is good for
      // the whole of the 24th; stopping the driver at midnight would cost them
      // a day they are legally entitled to work.
      const { service, db } = serviceFor(
        ['DRIVING_LICENCE'],
        [verified('DRIVING_LICENCE', new Date('2026-08-24T00:00:00.000Z'))],
      );

      expect((await service.evaluate(db, DRIVER)).compliant).toBe(true);
    });

    it('lapses the day after', async () => {
      const { service, db } = serviceFor(
        ['DRIVING_LICENCE'],
        [verified('DRIVING_LICENCE', new Date('2026-08-23T00:00:00.000Z'))],
      );

      const verdict = await service.evaluate(db, DRIVER);

      expect(verdict.compliant).toBe(false);
      expect(verdict.expired).toEqual(['DRIVING_LICENCE']);
      // Expired is not missing: the driver had it, and needs it renewed.
      expect(verdict.missing).toEqual([]);
    });

    it('a document expiring tomorrow is still good', async () => {
      const { service, db } = serviceFor(
        ['DRIVING_LICENCE'],
        [verified('DRIVING_LICENCE', new Date('2026-08-25T00:00:00.000Z'))],
      );

      expect((await service.evaluate(db, DRIVER)).compliant).toBe(true);
    });

    it('is evaluated when asked, never stored', async () => {
      const row = verified('DRIVING_LICENCE', new Date('2026-08-24T00:00:00.000Z'));

      const today = new DriverComplianceService(new FakeClock(NOW), () =>
        Promise.resolve<DriverDocumentType[]>(['DRIVING_LICENCE']));
      const nextWeek = new DriverComplianceService(
        new FakeClock(new Date('2026-08-31T09:00:00.000Z')),
        () => Promise.resolve<DriverDocumentType[]>(['DRIVING_LICENCE']),
      );

      // Same row, two different answers. A stored EXPIRED flag would need a job
      // to flip it, and would be wrong until that job ran.
      expect((await today.evaluate(new StubDb([row]), DRIVER)).compliant).toBe(true);
      expect((await nextWeek.evaluate(new StubDb([row]), DRIVER)).compliant).toBe(false);
    });
  });

  describe('filtering a matching candidate set', () => {
    it('drops the non-compliant and keeps the rest', async () => {
      const { service, db } = serviceFor(
        ['DRIVING_LICENCE'],
        [verified('DRIVING_LICENCE', null, DRIVER)],
      );

      expect(await service.filterCompliant(db, [DRIVER, OTHER])).toEqual(new Set([DRIVER]));
    });

    it('excludes a driver with no document rows rather than skipping them', async () => {
      // The bug this guards: grouping the result by driver and iterating the
      // groups silently allows anyone absent from the result set — which is
      // precisely the driver who supplied nothing.
      const { service, db } = serviceFor(['DRIVING_LICENCE'], []);

      expect(await service.filterCompliant(db, [DRIVER, OTHER])).toEqual(new Set());
    });

    it('asks the database once for the whole set', async () => {
      const { service, db } = serviceFor(
        ['DRIVING_LICENCE'],
        [verified('DRIVING_LICENCE', null, DRIVER)],
      );

      await service.filterCompliant(db, [DRIVER, OTHER, '00000000-0000-4000-8000-0000000000c3']);

      // A query per candidate would put this table on the dispatch path once
      // per nearby driver.
      expect(db.queries).toHaveLength(1);
    });

    it('returns nothing for an empty candidate set without querying', async () => {
      const { service, db } = serviceFor(['DRIVING_LICENCE']);

      expect(await service.filterCompliant(db, [])).toEqual(new Set());
      expect(db.queries).toEqual([]);
    });
  });

  describe('parsing the configured list', () => {
    it('reads a comma-separated list', () => {
      expect(parseRequiredDocuments('NATIONAL_ID,DRIVING_LICENCE')).toEqual([
        'NATIONAL_ID',
        'DRIVING_LICENCE',
      ]);
    });

    it('tolerates spacing and case', () => {
      expect(parseRequiredDocuments(' national_id , DRIVING_LICENCE ')).toEqual([
        'NATIONAL_ID',
        'DRIVING_LICENCE',
      ]);
    });

    it('treats an empty value as no requirement', () => {
      expect(parseRequiredDocuments('')).toEqual([]);
      expect(parseRequiredDocuments('   ')).toEqual([]);
      expect(parseRequiredDocuments(',,')).toEqual([]);
    });

    it('drops a duplicate rather than requiring it twice', () => {
      expect(parseRequiredDocuments('NATIONAL_ID,NATIONAL_ID')).toEqual(['NATIONAL_ID']);
    });

    it('ignores an unknown name and reports it, rather than throwing', () => {
      const onUnknown = vi.fn();

      // An administrator's typo must cost that one entry. Throwing here would
      // take matching down for every driver, from a text field in an admin form.
      const result = parseRequiredDocuments('DRIVING_LICENCE,PASSPORT', onUnknown);

      expect(result).toEqual(['DRIVING_LICENCE']);
      expect(onUnknown).toHaveBeenCalledWith('PASSPORT');
    });

    it('a list of only unknown names disables the check rather than blocking everyone', () => {
      // Fail open, deliberately: the alternative is a typo that stops every
      // driver in the city working, with no error anyone would connect to it.
      expect(parseRequiredDocuments('PASSPORT,VISA')).toEqual([]);
    });
  });
});
