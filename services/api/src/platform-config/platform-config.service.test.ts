import { beforeEach, describe, expect, it } from 'vitest';

import { FakeClock } from '../common/clock.js';
import type { Queryable, QueryResult, SqlValue } from '../db/db.port.js';
import {
  CONFIG_DEFAULTS,
  CONFIG_KEYS,
  InvalidConfigValueError,
  PlatformConfigService,
} from './platform-config.service.js';

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';

/** Mirrors the seed in migration 0001. */
function seededRows(): Map<string, string> {
  return new Map(Object.entries(CONFIG_DEFAULTS).map(([k, v]) => [k, String(v)]));
}

class FakeConfigDb implements Queryable {
  queries = 0;

  constructor(public rows = seededRows()) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<QueryResult<R>> {
    const normalised = sql.trim().toUpperCase();

    if (normalised.startsWith('SELECT KEY, VALUE')) {
      this.queries++;
      const rows = [...this.rows].map(([key, value]) => ({ key, value }) as R);
      return { rows, rowCount: rows.length };
    }

    if (normalised.startsWith('SELECT KEY FROM')) {
      const rows = [...this.rows.keys()].map((key) => ({ key }) as R);
      return { rows, rowCount: rows.length };
    }

    // A single policy row, which is how every flag getter reads
    // (`readBooleanFlag` / `readNumericFlag`). The fake did not model this
    // shape at all, so every flag test silently exercised the fallback path
    // and would have passed against a getter that ignored the database.
    if (normalised.startsWith('SELECT VALUE FROM PLATFORM_CONFIG')) {
      this.queries++;
      const key = params[0] as string;
      const value = this.rows.get(key);
      return value === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ value } as R], rowCount: 1 };
    }

    if (normalised.startsWith('INSERT INTO PLATFORM_CONFIG')) {
      const [key, value] = params as [string, string];
      this.rows.set(key, value);
      return { rows: [], rowCount: 1 };
    }

    if (normalised.startsWith('UPDATE PLATFORM_CONFIG')) {
      const [value, , , key] = params as [string, Date, string, string];
      this.rows.set(key, value);
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }
}

describe('PlatformConfigService', () => {
  let clock: FakeClock;
  let db: FakeConfigDb;
  let service: PlatformConfigService;

  beforeEach(() => {
    clock = new FakeClock();
    db = new FakeConfigDb();
    service = new PlatformConfigService(clock, 30_000);
  });

  describe('read', () => {
    it('reads every key from the database', async () => {
      const config = await service.read(db);
      for (const key of CONFIG_KEYS) {
        expect(config[key]).toBe(CONFIG_DEFAULTS[key]);
      }
    });

    // CLAUDE.md §6.5 - the shipped default.
    it('reports a zero commission by default', async () => {
      expect(await service.commissionBps(db)).toBe(0);
    });

    it('falls back to the built-in default when a key is absent', async () => {
      db.rows.delete('commission_bps');
      expect(await service.commissionBps(db)).toBe(0);
      expect(await service.missingKeys(db)).toEqual(['commission_bps']);
    });

    it('reports no missing keys when the seed is complete', async () => {
      expect(await service.missingKeys(db)).toEqual([]);
    });

    // A row edited by hand with psql never passed through the API's validation.
    it('rejects a non-integer value rather than producing NaN', async () => {
      db.rows.set('commission_bps', 'not-a-number');
      await expect(service.read(db)).rejects.toThrow(InvalidConfigValueError);
      await expect(service.read(db)).rejects.toThrow(/not an integer/);
    });

    it('rejects a decimal commission', async () => {
      db.rows.set('commission_bps', '12.5');
      await expect(service.read(db)).rejects.toThrow(/not an integer/);
    });

    it('rejects an out-of-range commission', async () => {
      db.rows.set('commission_bps', '10001');
      await expect(service.read(db)).rejects.toThrow(InvalidConfigValueError);
    });

    it('rejects a negative fare component', async () => {
      db.rows.set('fare_base_iqd', '-100');
      await expect(service.read(db)).rejects.toThrow(InvalidConfigValueError);
    });

    it('rejects a zero rounding step, which would divide by zero downstream', async () => {
      db.rows.set('fare_rounding_iqd', '0');
      await expect(service.read(db)).rejects.toThrow(InvalidConfigValueError);
    });
  });

  describe('caching', () => {
    it('does not hit the database twice within the TTL', async () => {
      await service.read(db);
      await service.read(db);
      await service.read(db);
      expect(db.queries).toBe(1);
    });

    it('re-reads once the TTL lapses', async () => {
      await service.read(db);
      clock.advance(30_001);
      await service.read(db);
      expect(db.queries).toBe(2);
    });

    // CLAUDE.md §6.5: "Changing it must not require a deploy." This is the test
    // of that claim - a value changed behind the service is picked up by a
    // running process, with no restart.
    it('picks up a change made outside this process once the TTL lapses', async () => {
      expect(await service.commissionBps(db)).toBe(0);

      db.rows.set('commission_bps', '1500');
      expect(await service.commissionBps(db)).toBe(0); // still cached

      clock.advance(30_001);
      expect(await service.commissionBps(db)).toBe(1_500);
    });

    it('invalidate() drops the cache immediately', async () => {
      await service.read(db);
      service.invalidate();
      await service.read(db);
      expect(db.queries).toBe(2);
    });
  });

  describe('tariff', () => {
    it('maps config onto the fare calculator shape', async () => {
      const tariff = await service.tariff(db);
      expect(tariff).toEqual({
        baseIqd: 2_000,
        perKmIqd: 500,
        perMinuteIqd: 50,
        minimumIqd: 3_000,
        roundingIqd: 250,
      });
    });

    it('produces whole-dinar amounts for every component', async () => {
      const tariff = await service.tariff(db);
      for (const value of Object.values(tariff)) {
        expect(Number.isInteger(value)).toBe(true);
      }
    });
  });

  describe('update', () => {
    it('changes only the supplied keys', async () => {
      const updated = await service.update(db, { commission_bps: 750 }, ADMIN);

      expect(updated.commission_bps).toBe(750);
      expect(updated.fare_base_iqd).toBe(CONFIG_DEFAULTS.fare_base_iqd);
    });

    // The change must be visible immediately on the instance that made it,
    // otherwise the admin panel shows the old value right after saving.
    it('is visible immediately without waiting for the TTL', async () => {
      await service.read(db);
      await service.update(db, { commission_bps: 750 }, ADMIN);
      expect(await service.commissionBps(db)).toBe(750);
    });

    it('rejects an out-of-range value and writes nothing', async () => {
      await expect(service.update(db, { commission_bps: 10_001 }, ADMIN)).rejects.toThrow(
        InvalidConfigValueError,
      );
      expect(db.rows.get('commission_bps')).toBe('0');
    });

    it('rejects a fractional value', async () => {
      await expect(service.update(db, { commission_bps: 12.5 }, ADMIN)).rejects.toThrow(
        InvalidConfigValueError,
      );
    });

    it('validates every key before writing any of them', async () => {
      await expect(
        service.update(db, { commission_bps: 500, fare_base_iqd: -1 }, ADMIN),
      ).rejects.toThrow(InvalidConfigValueError);

      // The valid half must not have been applied - a partial config change is
      // worse than none, because nobody knows which half landed.
      expect(db.rows.get('commission_bps')).toBe('0');
    });

    it('rejects an unknown key', async () => {
      await expect(
        service.update(db, { nonsense: 1 } as never, ADMIN),
      ).rejects.toThrow(/unknown configuration key/);
    });

    it('rejects an empty change set', async () => {
      await expect(service.update(db, {}, ADMIN)).rejects.toThrow(/No configuration changes/);
    });

    it('accepts the full permitted range for every key', async () => {
      await expect(
        service.update(
          db,
          {
            commission_bps: 10_000,
            fare_rounding_iqd: 1,
            offer_timeout_seconds: 120,
            search_radius_meters: 50_000,
          },
          ADMIN,
        ),
      ).resolves.toBeDefined();
    });
  });
});

describe('location retention', () => {
  /**
   * `driver_location_history` is written every 30 seconds per online driver and
   * was never deleted from. These pin the two ends of the policy, because both
   * are dangerous in opposite directions: too short silently destroys evidence
   * for a route dispute, and 0 restores the unbounded retention of the most
   * sensitive data the system holds (CLAUDE.md §9).
   */

  it('defaults to 90 days when the row is absent', async () => {
    const db = new FakeConfigDb(new Map());
    const config = new PlatformConfigService(new FakeClock());

    // Not 0. Every other policy in this repo ships disabled; this one must not,
    // because an absent retention policy is how data accumulates forever by
    // omission rather than by decision.
    expect(await config.locationRetentionDays(db)).toBe(90);
  });

  it('reads an operator-set window', async () => {
    const db = new FakeConfigDb(new Map([['location_retention_days', '30']]));
    const config = new PlatformConfigService(new FakeClock());
    expect(await config.locationRetentionDays(db)).toBe(30);
  });

  it('treats 0 as "keep everything", which the sweep skips entirely', async () => {
    const db = new FakeConfigDb(new Map([['location_retention_days', '0']]));
    const config = new PlatformConfigService(new FakeClock());
    expect(await config.locationRetentionDays(db)).toBe(0);
  });

  it('clamps a negative value up rather than deleting the future', async () => {
    // A negative interval would make `recorded_at < now() - (-5 days)` match
    // rows recorded up to five days from now - which is every row in the table.
    // Clamping, not rejecting: this is read on a background job and a bad value
    // typed into an admin form must not become a catastrophic DELETE.
    const db = new FakeConfigDb(new Map([['location_retention_days', '-5']]));
    const config = new PlatformConfigService(new FakeClock());
    expect(await config.locationRetentionDays(db)).toBe(0);
  });

  it('clamps an absurd value down to ten years', async () => {
    const db = new FakeConfigDb(new Map([['location_retention_days', '999999']]));
    const config = new PlatformConfigService(new FakeClock());
    expect(await config.locationRetentionDays(db)).toBe(3650);
  });

  it('falls back to the default on a non-numeric value', async () => {
    const db = new FakeConfigDb(new Map([['location_retention_days', 'forever']]));
    const config = new PlatformConfigService(new FakeClock());
    expect(await config.locationRetentionDays(db)).toBe(90);
  });
});
