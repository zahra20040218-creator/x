import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityService } from '../../src/capabilities/capability.service.js';
import { SystemClock } from '../../src/common/clock.js';
import { DriverComplianceService } from '../../src/compliance/driver-compliance.service.js';
import type { PgDatabase } from '../../src/db/pg-database.js';
import {
  assertRealDatabase,
  createRealDatabase,
  isRealInfraRequested,
  truncateAll,
} from '../support/real-infra.js';

/**
 * Who may enter Driver mode.
 *
 * ## Why this is the most important authorisation test in the codebase
 *
 * ALY ships as one binary containing both modes (CLAUDE.md §1.1). Before that,
 * "is this person a driver" was answered by which app they had installed - a
 * weak guarantee, but a real one, because a rider was never given the driver
 * APK. That guarantee is now gone. Every rider is carrying the driver code, and
 * the only thing between them and a dispatch is this service.
 *
 * The codebase has already been bitten by exactly this shape once: `accept`
 * looked authorised because the screen that called it was only shown to the
 * offered driver, and D-14 found that any driver holding a ride id could take
 * someone else's ride. A guard that is really a screen is the failure mode to
 * design against, so these tests never go through a screen.
 *
 * ## Real Postgres
 *
 * Every condition below is a column, a partial index or a `platform_config`
 * row. The fake enforces none of them, so a green run against it would mean
 * nothing at all.
 */

const RUN = isRealInfraRequested();
const describeReal = RUN ? describe : describe.skip;

const RIDER = '11111111-1111-4111-8111-111111111111';
const DRIVER = 'aaaaaaaa-1111-4111-8111-111111111111';

describeReal('who may drive', () => {
  let db: PgDatabase;
  let capabilities: CapabilityService;
  let subscriptionRequired = false;

  beforeAll(() => {
    db = createRealDatabase(10);
    assertRealDatabase(db);

    const clock = new SystemClock();
    const compliance = new DriverComplianceService(clock, async () => {
      const result = await db.query<{ value: string }>(
        `SELECT value FROM platform_config WHERE key = 'required_driver_documents'`,
      );
      const raw = (result.rows[0]?.value ?? '').trim();
      return raw ? (raw.split(',').map((s) => s.trim()) as never) : [];
    });

    capabilities = new CapabilityService(
      db,
      compliance,
      clock,
      async () => subscriptionRequired,
    );
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    subscriptionRequired = false;
    await truncateAll(db);

    await db.query(
      `INSERT INTO platform_config (key, value)
       VALUES ('required_driver_documents',''), ('subscription_required','false')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    await db.query(
      `INSERT INTO users (id, role, phone_e164, display_name)
       VALUES ($1,'RIDER','+9647700000001','راكب'), ($2,'DRIVER','+9647700000002','سائق')`,
      [RIDER, DRIVER],
    );
    await db.query(`INSERT INTO riders (user_id) VALUES ($1)`, [RIDER]);
    await db.query(
      `INSERT INTO drivers (user_id, vehicle_plate, vehicle_model, vehicle_color)
       VALUES ($1,'11111','Corolla','أبيض')`,
      [DRIVER],
    );
  });

  // -------------------------------------------------------------------------

  async function planFor(days: number, priceIqd = 25_000): Promise<string> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO subscription_plans (code, name_ar, name_en, price_iqd, duration_days)
       VALUES ($1,'شهري','Monthly',$2,$3) RETURNING id`,
      [`plan-${randomUUID().slice(0, 8)}`, priceIqd, days],
    );
    return result.rows[0]!.id;
  }

  /**
   * `expiresInDays` may be negative, for a subscription that has already
   * lapsed. `started_at` is backdated a full period rather than left at `now()`,
   * because `driver_subscriptions_period` requires `expires_at > started_at` -
   * a lapsed subscription is one that STARTED in the past and ran out, not one
   * that expired before it began. The constraint caught the first version of
   * this helper, which is what it is for.
   */
  async function subscribe(driverId: string, expiresInDays: number): Promise<void> {
    const planId = await planFor(30);
    await db.query(
      `INSERT INTO driver_subscriptions
         (driver_id, plan_id, charged_iqd, started_at, expires_at)
       VALUES ($1, $2, 25000,
               now() - ($3 || ' days')::interval,
               now() + ($4 || ' days')::interval)`,
      [driverId, planId, String(Math.abs(expiresInDays) + 30), String(expiresInDays)],
    );
  }

  // -------------------------------------------------------------------------
  // The ordinary cases
  // -------------------------------------------------------------------------

  it('lets an approved, unsuspended driver drive', async () => {
    const result = await capabilities.evaluate(DRIVER);

    expect(result.driver.allowed).toBe(true);
    expect(result.driver.blockers).toEqual([]);
    expect(result.canRide).toBe(true);
  });

  it('lets a driver ride as well - the modes are not exclusive', async () => {
    // A driver taking a ride home after their shift is an ordinary customer.
    const result = await capabilities.evaluate(DRIVER);
    expect(result.canRide).toBe(true);
  });

  it('refuses driver mode to a rider, without calling it an error', async () => {
    const result = await capabilities.evaluate(RIDER);

    expect(result.canRide).toBe(true);
    expect(result.driver.allowed).toBe(false);
    expect(result.driver.blockers).toEqual(['NOT_A_DRIVER']);
  });

  // -------------------------------------------------------------------------
  // Each blocker, on its own
  // -------------------------------------------------------------------------

  it('refuses a disabled account both modes', async () => {
    await db.query(`UPDATE users SET is_active = false WHERE id = $1`, [DRIVER]);
    const result = await capabilities.evaluate(DRIVER);

    expect(result.canRide).toBe(false);
    expect(result.driver.allowed).toBe(false);
    expect(result.driver.blockers).toEqual(['ACCOUNT_DISABLED']);
  });

  it('gives an unknown account exactly what a disabled one gets', async () => {
    // Distinguishing them would confirm which user ids exist.
    const unknown = await capabilities.evaluate(randomUUID());
    const disabled = await (async () => {
      await db.query(`UPDATE users SET is_active = false WHERE id = $1`, [DRIVER]);
      return capabilities.evaluate(DRIVER);
    })();

    expect(unknown.driver.blockers).toEqual(disabled.driver.blockers);
    expect(unknown.canRide).toBe(disabled.canRide);
  });

  it('refuses a driver whose approval is still pending', async () => {
    await db.query(
      `UPDATE drivers SET approval_status = 'PENDING' WHERE user_id = $1`,
      [DRIVER],
    );
    const result = await capabilities.evaluate(DRIVER);

    expect(result.driver.allowed).toBe(false);
    expect(result.driver.blockers).toContain('APPROVAL_PENDING');
  });

  it('refuses a rejected driver', async () => {
    await db.query(
      `UPDATE drivers SET approval_status = 'REJECTED' WHERE user_id = $1`,
      [DRIVER],
    );
    const result = await capabilities.evaluate(DRIVER);

    expect(result.driver.blockers).toContain('APPROVAL_REJECTED');
  });

  it('refuses a suspended driver and passes on the reason they were given', async () => {
    await db.query(
      `UPDATE drivers SET is_suspended = true, suspended_reason = $2 WHERE user_id = $1`,
      [DRIVER, 'شكاوى متكررة'],
    );
    const result = await capabilities.evaluate(DRIVER);

    expect(result.driver.blockers).toContain('SUSPENDED');
    expect(result.driver.suspendedReason).toBe('شكاوى متكررة');
  });

  it('refuses a driver missing a required document', async () => {
    await db.query(
      `UPDATE platform_config SET value = 'DRIVING_LICENCE'
        WHERE key = 'required_driver_documents'`,
    );
    const result = await capabilities.evaluate(DRIVER);

    expect(result.driver.blockers).toContain('DOCUMENTS_INCOMPLETE');
    expect(result.driver.missingDocuments).toContain('DRIVING_LICENCE');
  });

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  describe('subscriptions', () => {
    it('ignores a missing subscription while the policy is off', async () => {
      subscriptionRequired = false;
      const result = await capabilities.evaluate(DRIVER);

      expect(result.driver.allowed).toBe(true);
      expect(result.driver.blockers).not.toContain('SUBSCRIPTION_REQUIRED');
    });

    it('refuses a driver with no subscription once the policy is on', async () => {
      subscriptionRequired = true;
      const result = await capabilities.evaluate(DRIVER);

      expect(result.driver.blockers).toContain('SUBSCRIPTION_REQUIRED');
    });

    it('accepts a live subscription', async () => {
      subscriptionRequired = true;
      await subscribe(DRIVER, 30);

      const result = await capabilities.evaluate(DRIVER);
      expect(result.driver.allowed).toBe(true);
      expect(result.driver.subscriptionExpiresAt).toBeInstanceOf(Date);
    });

    it('refuses one that has lapsed, even while its status still says ACTIVE', async () => {
      // The reason expiry is compared rather than trusted: a status column needs
      // a sweep to stay true, and between two runs of that sweep it is wrong -
      // which here means a driver working on a subscription they stopped paying
      // for. This row is exactly what the gap looks like.
      subscriptionRequired = true;
      await subscribe(DRIVER, -1);

      const result = await capabilities.evaluate(DRIVER);
      expect(result.driver.blockers).toContain('SUBSCRIPTION_REQUIRED');
      expect(result.driver.allowed).toBe(false);
    });

    it('shows the expiry even when the policy is off', async () => {
      // A driver should be able to see what they bought whether or not it
      // currently gates anything.
      subscriptionRequired = false;
      await subscribe(DRIVER, 10);

      const result = await capabilities.evaluate(DRIVER);
      expect(result.driver.allowed).toBe(true);
      expect(result.driver.subscriptionExpiresAt).not.toBeNull();
    });

    it('allows only one live subscription per driver, at the database level', async () => {
      await subscribe(DRIVER, 30);

      let violated = false;
      try {
        await subscribe(DRIVER, 30);
      } catch {
        violated = true;
      }
      // The partial unique index, not application code, is what makes a double
      // charge impossible.
      expect(violated).toBe(true);
    });

    it('lets a lapsed subscription be replaced by a new one', async () => {
      await subscribe(DRIVER, 30);
      await db.query(
        `UPDATE driver_subscriptions SET status = 'EXPIRED' WHERE driver_id = $1`,
        [DRIVER],
      );

      // The index is partial on ACTIVE precisely so history does not block a
      // renewal.
      await expect(subscribe(DRIVER, 30)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Several at once
  // -------------------------------------------------------------------------

  it('reports every blocker, not just the first', async () => {
    // A driver who fixes one of three and is still refused, with no idea why,
    // is the reason this returns a list.
    subscriptionRequired = true;
    await db.query(
      `UPDATE drivers SET approval_status = 'PENDING', is_suspended = true
        WHERE user_id = $1`,
      [DRIVER],
    );
    await db.query(
      `UPDATE platform_config SET value = 'DRIVING_LICENCE'
        WHERE key = 'required_driver_documents'`,
    );

    const result = await capabilities.evaluate(DRIVER);

    expect(result.driver.blockers).toEqual(
      expect.arrayContaining([
        'APPROVAL_PENDING',
        'SUSPENDED',
        'DOCUMENTS_INCOMPLETE',
        'SUBSCRIPTION_REQUIRED',
      ]),
    );
    expect(result.driver.allowed).toBe(false);
  });

  it('never reports allowed while any blocker stands', async () => {
    // `allowed` is derived, never set. This is the invariant the whole service
    // rests on, so it is asserted directly rather than inferred from the cases
    // above.
    const cases: Array<() => Promise<void>> = [
      async () => {
        await db.query(`UPDATE users SET is_active = false WHERE id = $1`, [DRIVER]);
      },
      async () => {
        await db.query(
          `UPDATE drivers SET approval_status = 'PENDING' WHERE user_id = $1`,
          [DRIVER],
        );
      },
      async () => {
        await db.query(`UPDATE drivers SET is_suspended = true WHERE user_id = $1`, [DRIVER]);
      },
    ];

    for (const applyCase of cases) {
      await applyCase();
      const result = await capabilities.evaluate(DRIVER);
      expect(result.driver.allowed).toBe(result.driver.blockers.length === 0);
      expect(result.driver.allowed).toBe(false);

      // Reset for the next case.
      await db.query(`UPDATE users SET is_active = true WHERE id = $1`, [DRIVER]);
      await db.query(
        `UPDATE drivers SET approval_status = 'APPROVED', is_suspended = false
          WHERE user_id = $1`,
        [DRIVER],
      );
    }
  });

  it('throws rather than returning a refusal, when asked to require', async () => {
    await db.query(`UPDATE drivers SET is_suspended = true WHERE user_id = $1`, [DRIVER]);

    // `requireDriver` exists so a guard cannot forget to check the boolean -
    // the same reason `claimOrThrow` sits beside `claim`.
    await expect(capabilities.requireDriver(DRIVER)).rejects.toThrow(/driver mode unavailable/);
    await expect(capabilities.requireDriver(RIDER)).rejects.toThrow(/NOT_A_DRIVER/);
  });
});
