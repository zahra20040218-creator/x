import { beforeEach, describe, expect, it } from 'vitest';

import { FakeClock } from '../common/clock.js';
import { FakeDatabase } from '../../test/fakes/fake-database.js';
import { InMemoryPushSender, UnconfiguredPushSender } from './push.port.js';
import { PushService } from './push.service.js';

/**
 * Push delivery.
 *
 * The behaviour worth testing is not "does it call the sender" — it is the
 * distinction between a token FCM says is DEAD and a delivery that merely
 * FAILED. Getting that wrong in the wrong direction empties the device table
 * during an outage and silently stops notifications for everyone afterwards,
 * which is a failure nobody would notice until drivers stopped accepting
 * rides.
 */

const RIDER = 'r-1';
const DRIVER = 'd-1';

describe('PushService', () => {
  let db: FakeDatabase;
  let clock: FakeClock;
  let sender: InMemoryPushSender;
  let push: PushService;

  beforeEach(() => {
    db = new FakeDatabase();
    clock = new FakeClock();
    sender = new InMemoryPushSender();
    push = new PushService(db, sender, clock);
  });

  describe('registration', () => {
    it('registers a device and delivers to it', async () => {
      await push.register(DRIVER, 'token-a', 'ANDROID');

      const summary = await push.pushToUser({
        userId: DRIVER,
        title: 'رحلة جديدة',
        body: 'لديك عرض رحلة',
        data: { rideId: 'ride-1' },
      });

      expect(summary).toEqual({ delivered: 1, failed: 0, revoked: 0 });
      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0]).toMatchObject({
        token: 'token-a',
        title: 'رحلة جديدة',
        data: { rideId: 'ride-1' },
      });
    });

    it('is idempotent - re-registering does not duplicate the device', async () => {
      // The apps re-register on every launch, so this is the common case, not
      // an edge case. A duplicate would mean two notifications per event.
      await push.register(DRIVER, 'token-a', 'ANDROID');
      await push.register(DRIVER, 'token-a', 'ANDROID');
      await push.register(DRIVER, 'token-a', 'ANDROID');

      expect(await push.liveTokensFor(db, DRIVER)).toEqual(['token-a']);
    });

    it('delivers to every device a user has', async () => {
      await push.register(DRIVER, 'phone', 'ANDROID');
      await push.register(DRIVER, 'tablet', 'ANDROID');

      const summary = await push.pushToUser({
        userId: DRIVER,
        title: 't',
        body: 'b',
        data: {},
      });

      expect(summary.delivered).toBe(2);
    });

    /**
     * Two people sharing a handset. The token identifies the DEVICE, so the
     * newer registration has to take it over — otherwise ride offers for the
     * previous owner keep arriving on a phone somebody else is now using.
     */
    it('reassigns a token when a different user registers it', async () => {
      await push.register(DRIVER, 'shared-phone', 'ANDROID');
      await push.register(RIDER, 'shared-phone', 'ANDROID');

      expect(await push.liveTokensFor(db, DRIVER)).toEqual([]);
      expect(await push.liveTokensFor(db, RIDER)).toEqual(['shared-phone']);
    });

    it('stops delivering after unregister', async () => {
      await push.register(DRIVER, 'token-a', 'ANDROID');
      await push.unregister(DRIVER, 'token-a');

      const summary = await push.pushToUser({
        userId: DRIVER,
        title: 't',
        body: 'b',
        data: {},
      });

      expect(summary.delivered).toBe(0);
      expect(sender.sent).toHaveLength(0);
    });

    it('will not let one user unregister another user device', async () => {
      await push.register(DRIVER, 'token-a', 'ANDROID');

      await push.unregister(RIDER, 'token-a');

      // Still live for its actual owner.
      expect(await push.liveTokensFor(db, DRIVER)).toEqual(['token-a']);
    });

    it('re-registering revives a revoked token', async () => {
      // A driver signing back in on the same phone. If this did not work they
      // would silently receive no offers until they reinstalled.
      await push.register(DRIVER, 'token-a', 'ANDROID');
      await push.unregister(DRIVER, 'token-a');
      await push.register(DRIVER, 'token-a', 'ANDROID');

      expect(await push.liveTokensFor(db, DRIVER)).toEqual(['token-a']);
    });
  });

  describe('what happens to a token after a send', () => {
    // THE test. Getting this backwards deletes the fleet.
    it('revokes a token FCM reports as permanently invalid', async () => {
      await push.register(DRIVER, 'dead-token', 'ANDROID');
      sender.invalidTokens.add('dead-token');

      const summary = await push.pushToUser({
        userId: DRIVER,
        title: 't',
        body: 'b',
        data: {},
      });

      expect(summary).toEqual({ delivered: 0, failed: 0, revoked: 1 });
      expect(await push.liveTokensFor(db, DRIVER)).toEqual([]);
    });

    it('KEEPS a token whose delivery merely failed', async () => {
      await push.register(DRIVER, 'good-token', 'ANDROID');
      sender.failingTokens.add('good-token');

      const summary = await push.pushToUser({
        userId: DRIVER,
        title: 't',
        body: 'b',
        data: {},
      });

      expect(summary).toEqual({ delivered: 0, failed: 1, revoked: 0 });

      // The device is still a delivery target. An FCM outage must not
      // deregister every phone on the platform.
      expect(await push.liveTokensFor(db, DRIVER)).toEqual(['good-token']);
    });

    it('revokes only the dead token when a user has several', async () => {
      await push.register(DRIVER, 'alive', 'ANDROID');
      await push.register(DRIVER, 'dead', 'ANDROID');
      sender.invalidTokens.add('dead');

      const summary = await push.pushToUser({
        userId: DRIVER,
        title: 't',
        body: 'b',
        data: {},
      });

      expect(summary).toEqual({ delivered: 1, failed: 0, revoked: 1 });
      expect(await push.liveTokensFor(db, DRIVER)).toEqual(['alive']);
    });

    it('never fails the caller, whatever the sender reports', async () => {
      // CLAUDE.md §3.2 puts push behind a queue so the request path never
      // waits on it. A throw here would surface as a failed ride.
      await push.register(DRIVER, 'a', 'ANDROID');
      sender.failingTokens.add('a');

      await expect(
        push.pushToUser({ userId: DRIVER, title: 't', body: 'b', data: {} }),
      ).resolves.toBeDefined();
    });
  });

  describe('with no devices registered', () => {
    it('reports nothing delivered rather than throwing', async () => {
      const summary = await push.pushToUser({
        userId: DRIVER,
        title: 't',
        body: 'b',
        data: {},
      });

      expect(summary).toEqual({ delivered: 0, failed: 0, revoked: 0 });
    });
  });

  describe('when push is not configured', () => {
    it('reports failure, never success, and revokes nothing', async () => {
      const unconfigured = new PushService(
        db,
        new UnconfiguredPushSender('FCM_SERVICE_ACCOUNT_JSON is not set'),
        clock,
      );
      await unconfigured.register(DRIVER, 'token-a', 'ANDROID');

      const summary = await unconfigured.pushToUser({
        userId: DRIVER,
        title: 't',
        body: 'b',
        data: {},
      });

      // Reporting `delivered` would make the metrics claim notifications work.
      expect(summary.delivered).toBe(0);
      expect(summary.failed).toBe(1);

      // And crucially: our missing credentials say nothing about whether the
      // device is real, so the token must survive.
      expect(summary.revoked).toBe(0);
      expect(await push.liveTokensFor(db, DRIVER)).toEqual(['token-a']);
    });
  });
});
