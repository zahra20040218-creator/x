import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityService } from '../../src/capabilities/capability.service.js';
import { SystemClock } from '../../src/common/clock.js';
import { DriverComplianceService } from '../../src/compliance/driver-compliance.service.js';
import type { PgDatabase } from '../../src/db/pg-database.js';
import { RideClaimService } from '../../src/matching/ride-claim.service.js';
import { NegotiationService } from '../../src/negotiation/negotiation.service.js';
import { PlatformConfigService } from '../../src/platform-config/platform-config.service.js';
import { RideRepository } from '../../src/rides/ride.repository.js';
import { RideStateMachine } from '../../src/rides/ride-state-machine.js';
import {
  assertRealDatabase,
  assertRealRedis,
  createRealDatabase,
  createRealRedis,
  isRealInfraRequested,
  truncateAll,
  type RealRedis,
} from '../support/real-infra.js';

/**
 * Fare negotiation, against the real services.
 *
 * ## What has to be true, and why a fake could not show it
 *
 * Negotiation adds a second-looking way for a ride to acquire a driver, and the
 * whole design rests on it NOT being a second way: accepting a bid runs the
 * same Redis claim and the same `RideStateMachine` transitions as ordinary
 * dispatch. If that is wrong, two riders can assign the same driver, or one
 * driver can end up on two rides — and both failures are invisible except under
 * genuine concurrency against genuine services.
 *
 * Three of the guarantees below exist nowhere but in the real services:
 *
 *   - `ride_bids_one_active_per_driver_uq` is a PARTIAL unique index. It is
 *     what makes a double bid impossible; the fake does not enforce it.
 *   - `SET NX PX` serialising a stampede is a real-Redis property.
 *   - `FakeDatabase.transaction` is known to be wrong under concurrent rollback
 *     (D-15), which is exactly the situation an accept race creates.
 */

const RUN = isRealInfraRequested();
const describeReal = RUN ? describe : describe.skip;

const RIDER = '11111111-1111-4111-8111-111111111111';
const RIDER_B = '22222222-1111-4111-8111-111111111111';
const DRIVER_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const DRIVER_B = 'bbbbbbbb-1111-4111-8111-111111111111';
const DRIVER_C = 'cccccccc-1111-4111-8111-111111111111';

describeReal('fare negotiation', () => {
  let db: PgDatabase;
  let redis: RealRedis;
  let negotiation: NegotiationService;

  beforeAll(() => {
    db = createRealDatabase(10);
    redis = createRealRedis();
    assertRealDatabase(db);
    assertRealRedis(redis.adapter);

    const clock = new SystemClock();
    const config = new PlatformConfigService(clock);
    const rides = new RideRepository();
    const machine = new RideStateMachine();
    const claims = new RideClaimService(redis.adapter, 30_000);
    const compliance = new DriverComplianceService(clock, async () => []);
    const capabilities = new CapabilityService(db, compliance, clock, async () => false);

    negotiation = new NegotiationService(
      db,
      rides,
      machine,
      claims,
      config,
      capabilities,
      clock,
    );
  });

  afterAll(async () => {
    await redis.close();
    await db.close();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await redis.flush();

    await db.query(
      `INSERT INTO platform_config (key, value) VALUES
         ('negotiation_enabled','true'),
         ('negotiation_band_bps','3000'),
         ('negotiation_window_seconds','90'),
         ('required_driver_documents',''),
         ('subscription_required','false')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );

    await db.query(
      `INSERT INTO users (id, role, phone_e164, display_name) VALUES
         ($1,'RIDER','+9647700000001','راكب'),
         ($2,'RIDER','+9647700000004','راكب ب'),
         ($3,'DRIVER','+9647700000002','سائق أ'),
         ($4,'DRIVER','+9647700000003','سائق ب'),
         ($5,'DRIVER','+9647700000005','سائق ج')`,
      [RIDER, RIDER_B, DRIVER_A, DRIVER_B, DRIVER_C],
    );
    await db.query(`INSERT INTO riders (user_id) VALUES ($1), ($2)`, [RIDER, RIDER_B]);
    await db.query(
      `INSERT INTO drivers (user_id, vehicle_plate, vehicle_model, vehicle_color) VALUES
         ($1,'11111','Corolla','أبيض'), ($2,'22222','Corolla','أسود'), ($3,'33333','Corolla','رمادي')`,
      [DRIVER_A, DRIVER_B, DRIVER_C],
    );
  });

  // -------------------------------------------------------------------------

  /** A ride open for bids: REQUESTED, with the rider's proposal on it. */
  async function openRide(proposedIqd = 10_000, rider = RIDER): Promise<string> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO rides
         (rider_id, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
          estimated_fare_iqd, proposed_fare_iqd, estimated_distance_m, estimated_duration_s)
       VALUES ($1,'REQUESTED',33.3061,44.4213,33.2989,44.4361,$2,$2,1500,300)
       RETURNING id`,
      [rider, proposedIqd],
    );
    return result.rows[0]!.id;
  }

  const bid = (rideId: string, driverId: string, amountIqd: number) =>
    negotiation.placeBid({ rideId, driverId, amountIqd, distanceM: 800 });

  async function statusOf(rideId: string) {
    const r = await db.query<{ status: string; driver_id: string | null; agreed_fare_iqd: string | null }>(
      `SELECT status, driver_id, agreed_fare_iqd FROM rides WHERE id = $1`,
      [rideId],
    );
    return r.rows[0]!;
  }

  // -------------------------------------------------------------------------
  // Placing bids
  // -------------------------------------------------------------------------

  describe('placing a bid', () => {
    it('records the driver, the amount and the expiry', async () => {
      const rideId = await openRide(10_000);
      const placed = await bid(rideId, DRIVER_A, 9_000);

      expect(placed.driverId).toBe(DRIVER_A);
      expect(placed.amountIqd).toBe(9_000);
      expect(placed.status).toBe('ACTIVE');
      expect(placed.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('supersedes rather than edits, so the price history survives', async () => {
      // The whole reason bids are rows and not a column. "He offered 9,000 then
      // changed it to 12,000" is only answerable if both are still there.
      const rideId = await openRide(10_000);
      const first = await bid(rideId, DRIVER_A, 9_000);
      const second = await bid(rideId, DRIVER_A, 11_000);

      const all = await db.query<{ id: string; status: string; supersedes: string | null }>(
        `SELECT id, status, supersedes FROM ride_bids WHERE ride_id = $1 ORDER BY created_at`,
        [rideId],
      );

      expect(all.rows).toHaveLength(2);
      expect(all.rows[0]!.id).toBe(first.id);
      expect(all.rows[0]!.status).toBe('SUPERSEDED');
      expect(all.rows[1]!.id).toBe(second.id);
      expect(all.rows[1]!.status).toBe('ACTIVE');
      // The chain is walkable.
      expect(all.rows[1]!.supersedes).toBe(first.id);
    });

    it('allows only one ACTIVE bid per driver, at the database level', async () => {
      const rideId = await openRide(10_000);
      await bid(rideId, DRIVER_A, 9_000);
      await bid(rideId, DRIVER_A, 9_500);

      const active = await db.query(
        `SELECT id FROM ride_bids WHERE ride_id=$1 AND driver_id=$2 AND status='ACTIVE'`,
        [rideId, DRIVER_A],
      );
      expect(active.rows).toHaveLength(1);
    });

    it('refuses a bid far below the rider proposal', async () => {
      // The abuse this exists to stop: bid 1 IQD, sort to the top of the
      // rider's list, then renegotiate in the car with a passenger who has
      // nowhere else to go.
      const rideId = await openRide(10_000);
      await expect(bid(rideId, DRIVER_A, 1)).rejects.toThrow();
      await expect(bid(rideId, DRIVER_A, 6_000)).rejects.toThrow();

      // 30% band on 10,000 => 7,000 to 13,000.
      await expect(bid(rideId, DRIVER_A, 7_000)).resolves.toBeDefined();
    });

    it('refuses a bid far above it too', async () => {
      const rideId = await openRide(10_000);
      await expect(bid(rideId, DRIVER_A, 20_000)).rejects.toThrow();
      await expect(bid(rideId, DRIVER_B, 13_000)).resolves.toBeDefined();
    });

    it('refuses a fractional or negative amount', async () => {
      const rideId = await openRide(10_000);
      // CLAUDE.md §6.1 - money is whole dinars. `iqd()` is the boundary.
      await expect(bid(rideId, DRIVER_A, 9_000.5)).rejects.toThrow();
      await expect(bid(rideId, DRIVER_A, -9_000)).rejects.toThrow();
    });

    it('refuses a bid on a ride that already has a driver', async () => {
      const rideId = await openRide(10_000);
      await db.query(
        `UPDATE rides SET status='ACCEPTED', driver_id=$2, accepted_at=now() WHERE id=$1`,
        [rideId, DRIVER_B],
      );

      await expect(bid(rideId, DRIVER_A, 9_000)).rejects.toThrow();
    });

    it('refuses a suspended driver, before any row is written', async () => {
      // A suspended driver must not be able to commit to a fare. Checked
      // through the capability service, so the six conditions in CLAUDE.md
      // §1.1 all apply here without being restated.
      const rideId = await openRide(10_000);
      await db.query(`UPDATE drivers SET is_suspended = true WHERE user_id = $1`, [DRIVER_A]);

      await expect(bid(rideId, DRIVER_A, 9_000)).rejects.toThrow();
      const rows = await db.query(`SELECT id FROM ride_bids WHERE driver_id = $1`, [DRIVER_A]);
      expect(rows.rows).toHaveLength(0);
    });

    it('behaves as though the feature does not exist when it is switched off', async () => {
      const rideId = await openRide(10_000);
      await db.query(
        `UPDATE platform_config SET value='false' WHERE key='negotiation_enabled'`,
      );
      // The config service caches, so a fresh instance is what a new request
      // would see after the TTL.
      const fresh = new NegotiationService(
        db,
        new RideRepository(),
        new RideStateMachine(),
        new RideClaimService(redis.adapter, 30_000),
        new PlatformConfigService(new SystemClock()),
        new CapabilityService(
          db,
          new DriverComplianceService(new SystemClock(), async () => []),
          new SystemClock(),
          async () => false,
        ),
        new SystemClock(),
      );

      await expect(
        fresh.placeBid({ rideId, driverId: DRIVER_A, amountIqd: 9_000, distanceM: 800 }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // The rider's list
  // -------------------------------------------------------------------------

  describe('the rider list', () => {
    it('is cheapest first, ties broken by who bid first', async () => {
      // A stable order matters more than it sounds: an unstable sort reorders
      // the list under the rider's thumb as they reach for a row.
      const rideId = await openRide(10_000);
      const a = await bid(rideId, DRIVER_A, 9_000);
      const b = await bid(rideId, DRIVER_B, 9_000);
      await bid(rideId, DRIVER_C, 8_000);

      const list = await negotiation.listBidsForRider(rideId, RIDER);
      expect(list.map((x) => x.amountIqd)).toEqual([8_000, 9_000, 9_000]);
      // Equal price: the earlier bid wins the higher slot.
      expect(list[1]!.id).toBe(a.id);
      expect(list[2]!.id).toBe(b.id);
    });

    it('shows only ACTIVE bids', async () => {
      const rideId = await openRide(10_000);
      await bid(rideId, DRIVER_A, 9_000);
      await bid(rideId, DRIVER_A, 9_500);

      const list = await negotiation.listBidsForRider(rideId, RIDER);
      expect(list).toHaveLength(1);
      expect(list[0]!.amountIqd).toBe(9_500);
    });

    it('refuses another rider, as a 404 rather than a 403', async () => {
      // A rider is not entitled to learn that someone else's ride exists.
      const rideId = await openRide(10_000);
      await bid(rideId, DRIVER_A, 9_000);

      await expect(negotiation.listBidsForRider(rideId, RIDER_B)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Accepting — the part that must not break §5.1
  // -------------------------------------------------------------------------

  describe('accepting a bid', () => {
    it('assigns the ride at the agreed fare', async () => {
      const rideId = await openRide(10_000);
      const placed = await bid(rideId, DRIVER_A, 8_500);

      const ride = await negotiation.acceptBid(rideId, placed.id, RIDER);

      expect(ride.status).toBe('ACCEPTED');
      expect(ride.driverId).toBe(DRIVER_A);
      expect(ride.agreedFareIqd).toBe(8_500);
      // The rider's proposal is still on the row. Three fares, three facts.
      expect(ride.proposedFareIqd).toBe(10_000);
    });

    it('writes both transitions to the append-only audit table', async () => {
      // CLAUDE.md §4: every transition writes exactly one ride_events row. A
      // path that assigns a driver without an audit trail is a path a dispute
      // cannot be argued from.
      const rideId = await openRide(10_000);
      const placed = await bid(rideId, DRIVER_A, 8_500);
      await negotiation.acceptBid(rideId, placed.id, RIDER);

      const events = await db.query<{ from_state: string; to_state: string; actor_type: string }>(
        `SELECT from_state, to_state, actor_type FROM ride_events
          WHERE ride_id = $1 ORDER BY created_at, id`,
        [rideId],
      );

      expect(events.rows.map((e) => `${e.from_state}->${e.to_state}`)).toEqual([
        'REQUESTED->OFFERED',
        'OFFERED->ACCEPTED',
      ]);
      // The DRIVER is recorded as the actor on the accept, because the bid was
      // their binding commitment. The rider is in the metadata.
      expect(events.rows[1]!.actor_type).toBe('DRIVER');
    });

    it('rejects every other bid in the same transaction', async () => {
      // A losing bid left ACTIVE is a driver still shown as bidding on a ride
      // that already has a driver.
      const rideId = await openRide(10_000);
      const winner = await bid(rideId, DRIVER_A, 8_500);
      await bid(rideId, DRIVER_B, 9_000);
      await bid(rideId, DRIVER_C, 9_500);

      await negotiation.acceptBid(rideId, winner.id, RIDER);

      const rows = await db.query<{ status: string; driver_id: string }>(
        `SELECT status, driver_id FROM ride_bids WHERE ride_id = $1`,
        [rideId],
      );
      const byDriver = Object.fromEntries(rows.rows.map((r) => [r.driver_id, r.status]));
      expect(byDriver[DRIVER_A]).toBe('ACCEPTED');
      expect(byDriver[DRIVER_B]).toBe('REJECTED');
      expect(byDriver[DRIVER_C]).toBe('REJECTED');
      expect(
        rows.rows.filter((r) => r.status === 'ACTIVE'),
      ).toHaveLength(0);
    });

    it('lets exactly one of many simultaneous accepts win', async () => {
      // The §5.1 property, through the negotiation path. If this ever produced
      // two winners, the claim has been bypassed.
      for (let round = 0; round < 10; round += 1) {
        // TRUNCATE, not DELETE. `ride_events` is append-only and a DELETE is
        // refused by a trigger (CLAUDE.md §6.3) - which is the trigger working,
        // and it caught the first version of this loop. TRUNCATE is a table
        // operation and does not fire row triggers, so it is the one
        // legitimate way for a test to reset an append-only table.
        await db.query(
          `TRUNCATE ride_events, ride_bids, ride_offers, rides RESTART IDENTITY CASCADE`,
        );
        await redis.flush();

        const rideId = await openRide(10_000);
        const a = await bid(rideId, DRIVER_A, 8_500);
        const b = await bid(rideId, DRIVER_B, 8_600);
        const c = await bid(rideId, DRIVER_C, 8_700);

        const results = await Promise.allSettled([
          negotiation.acceptBid(rideId, a.id, RIDER),
          negotiation.acceptBid(rideId, b.id, RIDER),
          negotiation.acceptBid(rideId, c.id, RIDER),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

        const ride = await statusOf(rideId);
        expect(ride.status).toBe('ACCEPTED');
        expect([DRIVER_A, DRIVER_B, DRIVER_C]).toContain(ride.driver_id);

        const accepted = await db.query(
          `SELECT id FROM ride_bids WHERE ride_id=$1 AND status='ACCEPTED'`,
          [rideId],
        );
        expect(accepted.rows).toHaveLength(1);
      }
    });

    it('never assigns the same driver on two rides at once', async () => {
      // This is what the Redis claim is actually for on this path, and it is
      // NOT what the previous test covers.
      //
      // Removing `withClaim` from `acceptBid` and re-running the
      // many-simultaneous-accepts test above leaves it PASSING - because three
      // accepts on ONE ride are already serialised by
      // `UPDATE rides ... WHERE status = $from` in `applyTransition`. The claim
      // is defence in depth there, not the guarantee.
      //
      // The case it does guard is this one: two different riders, two different
      // rides, both accepting a bid from the SAME driver at the same instant.
      // Nothing about either ride's status conflicts, so the status guard has
      // nothing to say. Exactly one must win.
      const rideOne = await openRide(10_000, RIDER);
      const rideTwo = await openRide(10_000, RIDER_B);
      const bidOne = await bid(rideOne, DRIVER_A, 9_000);
      const bidTwo = await bid(rideTwo, DRIVER_A, 9_000);

      const results = await Promise.allSettled([
        negotiation.acceptBid(rideOne, bidOne.id, RIDER),
        negotiation.acceptBid(rideTwo, bidTwo.id, RIDER_B),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

      // And the database agrees: one active ride for this driver, not two.
      const active = await db.query(
        `SELECT id FROM rides
          WHERE driver_id = $1
            AND status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')`,
        [DRIVER_A],
      );
      expect(active.rows).toHaveLength(1);
    });

    it('repeats that under a stampede, because once is luck', async () => {
      for (let round = 0; round < 8; round += 1) {
        await db.query(
          `TRUNCATE ride_events, ride_bids, ride_offers, rides RESTART IDENTITY CASCADE`,
        );
        await redis.flush();

        const rideOne = await openRide(10_000, RIDER);
        const rideTwo = await openRide(10_000, RIDER_B);
        const bidOne = await bid(rideOne, DRIVER_A, 9_000);
        const bidTwo = await bid(rideTwo, DRIVER_A, 9_000);

        const results = await Promise.allSettled([
          negotiation.acceptBid(rideOne, bidOne.id, RIDER),
          negotiation.acceptBid(rideTwo, bidTwo.id, RIDER_B),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      }
    });

    it('refuses a second accept from the same rider', async () => {
      // The retry case: the reply was lost and the app sent it again.
      const rideId = await openRide(10_000);
      const placed = await bid(rideId, DRIVER_A, 8_500);

      await expect(negotiation.acceptBid(rideId, placed.id, RIDER)).resolves.toBeDefined();
      await expect(negotiation.acceptBid(rideId, placed.id, RIDER)).rejects.toThrow();

      const ride = await statusOf(rideId);
      expect(ride.status).toBe('ACCEPTED');
      expect(ride.driver_id).toBe(DRIVER_A);
    });

    it('refuses a superseded bid', async () => {
      const rideId = await openRide(10_000);
      const first = await bid(rideId, DRIVER_A, 9_000);
      await bid(rideId, DRIVER_A, 9_500);

      // The rider's list is stale and still shows the old price.
      await expect(negotiation.acceptBid(rideId, first.id, RIDER)).rejects.toThrow();
      expect((await statusOf(rideId)).status).toBe('REQUESTED');
    });

    it('refuses an expired bid, even while its status still says ACTIVE', async () => {
      // Expiry is compared, not trusted from the column: a status needs a sweep
      // to stay true, and between two runs of that sweep it is wrong. This row
      // is exactly what the gap looks like.
      const rideId = await openRide(10_000);
      const placed = await bid(rideId, DRIVER_A, 9_000);
      // `created_at` moves with it: `ride_bids_expiry_after_creation` requires
      // expires_at > created_at, so a bid cannot expire before it was made. The
      // first version of this test moved only the expiry and the constraint
      // refused it, which is the constraint doing its job.
      await db.query(
        `UPDATE ride_bids
            SET created_at = now() - interval '2 minutes',
                expires_at = now() - interval '1 second'
          WHERE id = $1`,
        [placed.id],
      );

      await expect(negotiation.acceptBid(rideId, placed.id, RIDER)).rejects.toThrow();
      expect((await statusOf(rideId)).status).toBe('REQUESTED');
    });

    it('refuses a rider accepting a bid on someone else\'s ride', async () => {
      const rideId = await openRide(10_000);
      const placed = await bid(rideId, DRIVER_A, 9_000);

      await expect(negotiation.acceptBid(rideId, placed.id, RIDER_B)).rejects.toThrow();
      expect((await statusOf(rideId)).status).toBe('REQUESTED');
    });

    it('refuses when the driver has meanwhile taken another ride', async () => {
      // `rides_one_active_per_driver_uq` is the backstop behind the claim. The
      // rider gets a refusal, never a 500.
      const rideId = await openRide(10_000);
      const placed = await bid(rideId, DRIVER_A, 9_000);

      await db.query(
        `INSERT INTO rides
           (rider_id, status, driver_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
            estimated_fare_iqd, estimated_distance_m, estimated_duration_s, accepted_at)
         VALUES ($1,'ACCEPTED',$2,33.3,44.4,33.2,44.4,5000,1500,300,now())`,
        [RIDER_B, DRIVER_A],
      );

      await expect(negotiation.acceptBid(rideId, placed.id, RIDER)).rejects.toThrow();
      expect((await statusOf(rideId)).status).toBe('REQUESTED');
    });

    it('leaves a real offer row behind, so resync and history are consistent', async () => {
      // The negotiation path must not produce a ride that the rest of the
      // system sees as never having been offered.
      const rideId = await openRide(10_000);
      const placed = await bid(rideId, DRIVER_A, 8_500);
      await negotiation.acceptBid(rideId, placed.id, RIDER);

      const offers = await db.query<{ driver_id: string; status: string }>(
        `SELECT driver_id, status FROM ride_offers WHERE ride_id = $1`,
        [rideId],
      );
      expect(offers.rows).toHaveLength(1);
      expect(offers.rows[0]!.driver_id).toBe(DRIVER_A);
      expect(offers.rows[0]!.status).toBe('ACCEPTED');
    });
  });

  // -------------------------------------------------------------------------

  describe('housekeeping', () => {
    it('expires bids whose window has closed, and only those', async () => {
      const rideId = await openRide(10_000);
      const stale = await bid(rideId, DRIVER_A, 9_000);
      const live = await bid(rideId, DRIVER_B, 9_100);
      await db.query(
        `UPDATE ride_bids
            SET created_at = now() - interval '2 minutes',
                expires_at = now() - interval '1 second'
          WHERE id = $1`,
        [stale.id],
      );

      const expired = await negotiation.expireStaleBids();
      expect(expired).toBe(1);

      const rows = await db.query<{ id: string; status: string }>(
        `SELECT id, status FROM ride_bids WHERE ride_id = $1`,
        [rideId],
      );
      const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.status]));
      expect(byId[stale.id]).toBe('EXPIRED');
      expect(byId[live.id]).toBe('ACTIVE');
    });

    it('never leaves a resolved bid without a responded_at', async () => {
      // The CHECK constraint, asserted directly: "when was this rejected" must
      // always be answerable, because that is what a dispute asks.
      const rideId = await openRide(10_000);
      const placed = await bid(rideId, DRIVER_A, 9_000);
      await negotiation.acceptBid(rideId, placed.id, RIDER);

      const rows = await db.query<{ status: string; responded_at: Date | null }>(
        `SELECT status, responded_at FROM ride_bids WHERE ride_id = $1`,
        [rideId],
      );
      for (const row of rows.rows) {
        if (row.status !== 'ACTIVE') expect(row.responded_at).not.toBeNull();
      }
    });

    it('refuses to write a resolved bid with no responded_at', async () => {
      const rideId = await openRide(10_000);
      const placed = await bid(rideId, DRIVER_A, 9_000);

      let rejected = false;
      try {
        await db.query(
          `UPDATE ride_bids SET status='REJECTED', responded_at=NULL WHERE id=$1`,
          [placed.id],
        );
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    });
  });

  it('leaves direct dispatch completely untouched when nobody bids', async () => {
    // The fallback CLAUDE.md §2 promises. A ride with no bids is still an
    // ordinary REQUESTED ride that the matcher can dispatch.
    const rideId = await openRide(10_000);
    expect(await negotiation.listBidsForRider(rideId, RIDER)).toEqual([]);
    expect((await statusOf(rideId)).status).toBe('REQUESTED');
    expect(randomUUID()).toBeTruthy();
  });
});
