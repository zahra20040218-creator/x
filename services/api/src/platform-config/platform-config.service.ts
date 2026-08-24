import { z } from 'zod';

import type { Clock } from '../common/clock.js';
import type { Queryable } from '../db/db.port.js';
import { iqd, type IqdAmount } from '../money/iqd.js';
import type { FareTariff } from '../fare/fare-calculator.js';
import {
  parseRequiredDocuments,
  type DriverDocumentType,
} from '../compliance/driver-compliance.service.js';

/**
 * CLAUDE.md §6.5 - "Commission rate is config, not a constant. Changing it must
 * not require a deploy."
 *
 * Which means it is read at runtime, from the database, on the request path.
 * That creates a tension: a DB round trip per fare quote is wasteful on a
 * 4-core box, but a cached value that never refreshes reintroduces the deploy.
 *
 * Resolved with a short TTL cache. An admin changing the commission sees it take
 * effect within `cacheTtlMs` (default 30s) with no deploy and no restart, and
 * the hot path does at most two reads a minute.
 *
 * The commission a ride actually settles at is snapshotted onto the ride when it
 * is created (`rides.commission_bps_snapshot`), so a mid-trip config change
 * cannot alter the terms a driver already accepted.
 */

export const CONFIG_KEYS = [
  'commission_bps',
  'fare_base_iqd',
  'fare_per_km_iqd',
  'fare_per_minute_iqd',
  'fare_minimum_iqd',
  'fare_rounding_iqd',
  'offer_timeout_seconds',
  'search_radius_meters',
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

/**
 * Bounds are enforced here as well as at the HTTP boundary, because this reads
 * from the database - and a row edited by hand with `psql` never passed through
 * the API's validation.
 */
export const ConfigValueSchema: Record<ConfigKey, z.ZodType<number>> = {
  commission_bps: z.number().int().min(0).max(10_000),
  fare_base_iqd: z.number().int().min(0).max(1_000_000),
  fare_per_km_iqd: z.number().int().min(0).max(1_000_000),
  fare_per_minute_iqd: z.number().int().min(0).max(1_000_000),
  fare_minimum_iqd: z.number().int().min(0).max(1_000_000),
  fare_rounding_iqd: z.number().int().min(1).max(100_000),
  offer_timeout_seconds: z.number().int().min(5).max(120),
  search_radius_meters: z.number().int().min(500).max(50_000),
};

/**
 * Used only when a key is missing from the database entirely. Matches the seed
 * in migration 0001 - notably `commission_bps: 0` (CLAUDE.md §6.5).
 *
 * These are a last resort, not a normal path: a missing key means the seed did
 * not run, which is worth noticing rather than papering over. `readAll` logs
 * nothing but `missingKeys` reports it.
 */
export const CONFIG_DEFAULTS: Record<ConfigKey, number> = {
  commission_bps: 0,
  fare_base_iqd: 2_000,
  fare_per_km_iqd: 500,
  fare_per_minute_iqd: 50,
  fare_minimum_iqd: 3_000,
  fare_rounding_iqd: 250,
  offer_timeout_seconds: 15,
  search_radius_meters: 5_000,
};

export type PlatformConfig = Record<ConfigKey, number>;

export class InvalidConfigValueError extends Error {
  constructor(
    readonly key: string,
    readonly value: string,
    reason: string,
  ) {
    super(`platform_config.${key} = "${value}" is invalid: ${reason}`);
    this.name = 'InvalidConfigValueError';
  }
}

export class PlatformConfigService {
  private cache: { value: PlatformConfig; expiresAtMs: number } | null = null;

  /**
   * Cached separately from the numeric config: this is a list of strings and
   * does not fit `PlatformConfig`, and widening that type would put a string
   * member on the fare hot path for the sake of a check that is off by default.
   */
  private documentsCache: { value: DriverDocumentType[]; expiresAtMs: number } | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly cacheTtlMs = 30_000,
  ) {}

  async read(q: Queryable): Promise<PlatformConfig> {
    const now = this.clock.nowMs();
    if (this.cache && this.cache.expiresAtMs > now) return this.cache.value;

    const result = await q.query<{ key: string; value: string }>(
      'SELECT key, value FROM platform_config',
    );

    const raw = new Map(result.rows.map((r) => [r.key, r.value]));
    const config = {} as PlatformConfig;

    for (const key of CONFIG_KEYS) {
      const stored = raw.get(key);
      if (stored === undefined) {
        config[key] = CONFIG_DEFAULTS[key];
        continue;
      }

      // A hand-edited row can hold anything. Parse strictly rather than
      // Number()-ing it and getting NaN into a fare.
      if (!/^-?\d+$/.test(stored)) {
        throw new InvalidConfigValueError(key, stored, 'not an integer');
      }

      const parsed = ConfigValueSchema[key].safeParse(Number(stored));
      if (!parsed.success) {
        throw new InvalidConfigValueError(
          key,
          stored,
          parsed.error.issues.map((i) => i.message).join('; '),
        );
      }
      config[key] = parsed.data;
    }

    this.cache = { value: config, expiresAtMs: now + this.cacheTtlMs };
    return config;
  }

  /**
   * Which documents a driver must hold to go online.
   *
   * Empty unless an owner has configured it — see migration 0010. Empty is not
   * "a policy that allows everyone": the compliance service issues no query at
   * all for it.
   *
   * [onUnknown] receives any configured name that is not a real document type,
   * so a typo in the admin form is logged rather than silently narrowing the
   * policy.
   */
  async requiredDriverDocuments(
    q: Queryable,
    onUnknown?: (value: string) => void,
  ): Promise<DriverDocumentType[]> {
    const now = this.clock.nowMs();
    if (this.documentsCache && this.documentsCache.expiresAtMs > now) {
      return this.documentsCache.value;
    }

    const result = await q.query<{ value: string }>(
      `SELECT value FROM platform_config WHERE key = 'required_driver_documents'`,
    );

    // Absent means the migration has not run. Treated as empty, which is the
    // same as disabled - the safe direction for a check that gates earning.
    const value = parseRequiredDocuments(result.rows[0]?.value ?? '', onUnknown);

    this.documentsCache = { value, expiresAtMs: now + this.cacheTtlMs };
    return value;
  }

  /** Keys absent from the database, i.e. running on a built-in default. */
  async missingKeys(q: Queryable): Promise<ConfigKey[]> {
    const result = await q.query<{ key: string }>('SELECT key FROM platform_config');
    const present = new Set(result.rows.map((r) => r.key));
    return CONFIG_KEYS.filter((k) => !present.has(k));
  }

  async commissionBps(q: Queryable): Promise<number> {
    return (await this.read(q)).commission_bps;
  }

  async tariff(q: Queryable): Promise<FareTariff> {
    const config = await this.read(q);
    return {
      baseIqd: iqd(config.fare_base_iqd),
      perKmIqd: iqd(config.fare_per_km_iqd),
      perMinuteIqd: iqd(config.fare_per_minute_iqd),
      minimumIqd: iqd(config.fare_minimum_iqd),
      roundingIqd: config.fare_rounding_iqd,
    };
  }

  /**
   * Apply an admin change. Only the supplied keys move.
   *
   * The cache is invalidated on THIS instance immediately; other API processes
   * pick the change up when their own TTL lapses. That is the deliberate
   * trade-off recorded above - bounded staleness, no deploy.
   */
  async update(
    q: Queryable,
    changes: Partial<Record<ConfigKey, number>>,
    adminId: string,
  ): Promise<PlatformConfig> {
    const entries = Object.entries(changes) as Array<[ConfigKey, number]>;
    if (entries.length === 0) {
      throw new Error('No configuration changes supplied.');
    }

    for (const [key, value] of entries) {
      if (!CONFIG_KEYS.includes(key)) {
        throw new InvalidConfigValueError(key, String(value), 'unknown configuration key');
      }
      const parsed = ConfigValueSchema[key].safeParse(value);
      if (!parsed.success) {
        throw new InvalidConfigValueError(
          key,
          String(value),
          parsed.error.issues.map((i) => i.message).join('; '),
        );
      }
    }

    for (const [key, value] of entries) {
      await q.query(
        `UPDATE platform_config
            SET value = $1, updated_at = $2, updated_by = $3
          WHERE key = $4`,
        [String(value), this.clock.now(), adminId, key],
      );
    }

    this.invalidate();
    return this.read(q);
  }

  invalidate(): void {
    this.cache = null;
  }
}

export type { IqdAmount };
