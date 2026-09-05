import 'reflect-metadata';

import { loadConfig } from './common/config.js';
import { SystemClock } from './common/clock.js';
import { createLogger } from './common/logger.js';
import { PgDatabase } from './db/pg-database.js';
import { DriverPresenceService } from './matching/driver-presence.service.js';
import { MatchingService } from './matching/matching.service.js';
import { RideClaimService } from './matching/ride-claim.service.js';
import { IdempotencyService } from './idempotency/idempotency.service.js';
import { LedgerService } from './ledger/ledger.service.js';
import {
  CashProvider,
  GatewayProvider,
  PaymentProviderRegistry,
} from './payments/payment-provider.js';
import { FareCalculator } from './fare/fare-calculator.js';
import { PlatformConfigService } from './platform-config/platform-config.service.js';
import { IoRedisAdapter } from './redis/ioredis-adapter.js';
import { RideStateMachine } from './rides/ride-state-machine.js';
import { RideRepository } from './rides/ride.repository.js';
import { RealtimeGateway } from './realtime/realtime.gateway.js';
import { TokenService } from './auth/token.service.js';
import { RideService } from './rides/ride.service.js';
import { CapabilityService } from './capabilities/capability.service.js';
import { DriverComplianceService } from './compliance/driver-compliance.service.js';
import { NegotiationService } from './negotiation/negotiation.service.js';
import { SubscriptionService } from './subscriptions/subscription.service.js';
import {
  QUEUE_NAMES,
  QueueRegistry,
  createConnection,
  createWorker,
  type PushJob,
} from './queue/queues.js';
import type { RideDispatchJob } from './queue/queues.js';
import { FcmSender, parseServiceAccount } from './push/fcm-sender.js';
import { UnconfiguredPushSender, type PushSender } from './push/push.port.js';
import { PushService } from './push/push.service.js';

/**
 * Background workers.
 *
 * A SEPARATE PROCESS from the API, deliberately. CLAUDE.md §3.2 puts external
 * calls on a queue so they do not block a request handler; running the workers
 * inside the API process would defeat that entirely — a slow FCM call would
 * still steal event-loop time from request handling, just via a different code
 * path.
 *
 * Jobs here:
 *   location-flush     Redis buffer -> Postgres, every 30s (CLAUDE.md §3.1)
 *   offer-sweep        expire offers whose deadline passed
 *   presence-sweep     evict drivers who stopped reporting
 *   idempotency-purge  drop keys past their 24h TTL
 *   push               FCM delivery (the send itself is stubbed in v1)
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, 'worker');
  const clock = new SystemClock();

  const database = new PgDatabase({
    connectionString: config.DATABASE_URL,
    maxConnections: config.DATABASE_MAX_CONNECTIONS,
  });
  const redis = IoRedisAdapter.fromUrl(config.REDIS_URL);

  const platformConfig = new PlatformConfigService(clock);
  const presence = new DriverPresenceService(redis, clock, config.DRIVER_PRESENCE_TTL_SECONDS);
  const repository = new RideRepository();

  /**
   * The worker publishes ride events too, and this is not optional.
   *
   * Dispatch happens HERE, in the worker - so if only the API process has a
   * publisher, a ride is offered and the driver is never told. That is exactly
   * what happened: the ride reached OFFERED in the database and nothing arrived
   * on the driver's socket.
   *
   * The gateway is used here only as a publisher; `attach()` is never called,
   * so the worker runs no WebSocket server. Delivery goes through Redis pub/sub
   * to whichever API process holds the driver's connection, which is the same
   * path a second API process would use.
   */
  const realtime = new RealtimeGateway(
    new TokenService(
      config.JWT_SECRET,
      clock,
      config.JWT_ACCESS_TTL_SECONDS,
      config.JWT_REFRESH_TTL_SECONDS,
    ),
    redis,
    logger,
  );

  const workerLedger = new LedgerService();

  const rideService = new RideService(
    database,
    repository,
    new RideStateMachine(),
    new RideClaimService(redis, config.MATCH_CLAIM_TTL_MS, logger),
    workerLedger,
    new FareCalculator(),
    platformConfig,
    clock,
    logger,
    realtime,
    // The same seam the API uses. The worker completes rides too (a swept
    // ride settles here), and a second settlement path would be a second place
    // for the money rules to drift.
    new PaymentProviderRegistry([new CashProvider(workerLedger), new GatewayProvider()]),
  );

  const matching = new MatchingService(
    database,
    repository,
    rideService,
    presence,
    platformConfig,
    redis,
    clock,
    config.MATCH_MAX_DRIVERS_PER_RIDE,
    logger,
  );

  const idempotency = new IdempotencyService(clock, config.IDEMPOTENCY_TTL_SECONDS, logger);
  const subscriptions = new SubscriptionService(new LedgerService(), clock);

  // Built only for the bid-expiry sweep. The worker never places or accepts a
  // bid, so nothing here is on a request path - but the sweep has to close
  // windows that passed, or a rider keeps seeing bids the accept path will
  // refuse.
  const negotiation = new NegotiationService(
    database,
    repository,
    new RideStateMachine(),
    new RideClaimService(redis, config.MATCH_CLAIM_TTL_MS, logger),
    platformConfig,
    new CapabilityService(
      database,
      new DriverComplianceService(clock, () =>
        platformConfig.requiredDriverDocuments(database, (unknown) => {
          logger.warn(
            { event: 'compliance.unknown_document_type', value: unknown },
            'ignoring an unknown document type in required_driver_documents',
          );
        }),
      ),
      clock,
      () => platformConfig.subscriptionRequired(database),
    ),
    clock,
    realtime,
    logger,
  );
  const connection = createConnection(config.REDIS_URL);
  const queues = new QueueRegistry(connection);
  await queues.scheduleRecurring(config.LOCATION_FLUSH_INTERVAL_MS);

  // Same construction as the API process. The worker is where delivery
  // actually happens, so an unconfigured sender here is the difference between
  // "drivers get offers" and "drivers get nothing" - it is logged at warn on
  // startup rather than discovered when nobody accepts a ride.
  const pushSender: PushSender = config.FCM_SERVICE_ACCOUNT_JSON
    ? new FcmSender(parseServiceAccount(config.FCM_SERVICE_ACCOUNT_JSON), clock, logger)
    : new UnconfiguredPushSender('FCM_SERVICE_ACCOUNT_JSON is not set');

  if (!config.FCM_SERVICE_ACCOUNT_JSON) {
    logger.warn(
      { event: 'push.unconfigured' },
      'push notifications are DISABLED: FCM_SERVICE_ACCOUNT_JSON is not set',
    );
  }

  const push = new PushService(database, pushSender, clock, logger);

  const workers = [
    createWorker(
      QUEUE_NAMES.locationFlush,
      connection,
      async () => {
        const batch = await presence.drainFlushBuffer(config.LOCATION_FLUSH_BATCH_SIZE);
        if (batch.length === 0) return;

        // One multi-row INSERT, not N. This is the ONLY place location history
        // is written to Postgres (CLAUDE.md §3.1).
        const values: unknown[] = [];
        const tuples = batch.map((sample, index) => {
          const base = index * 7;
          values.push(
            sample.driverId,
            sample.lng,
            sample.lat,
            sample.accuracyM,
            sample.headingDeg,
            sample.speedMps,
            sample.recordedAt,
          );
          return `($${base + 1}, ST_SetSRID(ST_MakePoint($${base + 2}, $${base + 3}), 4326)::geography, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
        });

        await database.query(
          `INSERT INTO driver_location_history
             (driver_id, position, accuracy_m, heading_deg, speed_mps, recorded_at)
           VALUES ${tuples.join(', ')}`,
          values as never,
        );

        logger.debug({ event: 'location.flushed', count: batch.length }, 'flushed locations');
      },
      logger,
    ),

    /**
     * Offer a newly created ride to a driver.
     *
     * The job the whole product depends on: without it a ride is created and
     * never offered to anybody. It was missing entirely - `POST /rides`
     * returned 201 and the ride sat in REQUESTED.
     */
    createWorker(
      QUEUE_NAMES.rideDispatch,
      connection,
      async (job) => {
        const { rideId } = job.data as RideDispatchJob;
        const outcome = await matching.dispatch(rideId);
        logger.info(
          { event: 'ride.dispatched', ride_id: rideId, outcome },
          'dispatch attempted for a new ride',
        );
      },
      logger,
    ),

    createWorker(
      QUEUE_NAMES.offerSweep,
      connection,
      async () => {
        const swept = await matching.sweepExpiredOffers();
        if (swept.length > 0) {
          logger.info({ event: 'offer.swept', count: swept.length }, 'expired offers');
        }
      },
      logger,
    ),

    createWorker(
      QUEUE_NAMES.presenceSweep,
      connection,
      async () => {
        const stale = await presence.sweepStale();
        if (stale.length === 0) return;

        // Also mark them OFFLINE in Postgres, so the durable eligibility check
        // in matching agrees with the geo set.
        await database.query(
          `UPDATE drivers SET availability = 'OFFLINE', updated_at = now()
            WHERE user_id = ANY($1::uuid[]) AND availability = 'ONLINE'`,
          [stale as never],
        );
        logger.info({ event: 'presence.swept', count: stale.length }, 'evicted stale drivers');
      },
      logger,
    ),

    createWorker(
      QUEUE_NAMES.idempotencyPurge,
      connection,
      async () => {
        const purged = await idempotency.purgeExpired(database);
        if (purged > 0) {
          logger.debug({ event: 'idempotency.purged', count: purged }, 'purged keys');
        }
      },
      logger,
    ),

    createWorker(
      QUEUE_NAMES.subscriptionExpiry,
      connection,
      async () => {
        const expired = await subscriptions.expireLapsed(database);
        if (expired > 0) {
          logger.info(
            { event: 'subscription.expired', count: expired },
            'closed lapsed subscription periods',
          );
        }
      },
      logger,
    ),

    createWorker(
      QUEUE_NAMES.bidExpiry,
      connection,
      async () => {
        const expired = await negotiation.expireStaleBids();
        if (expired > 0) {
          logger.info({ event: 'bid.expired', count: expired }, 'closed stale bids');
        }
      },
      logger,
    ),

    createWorker(
      QUEUE_NAMES.locationRetention,
      connection,
      async () => {
        const days = await platformConfig.locationRetentionDays(database);

        // 0 means an operator explicitly chose to keep everything. Skipped
        // without a query rather than translated into a no-op DELETE, so
        // "retention is off" costs nothing and shows up in the logs as a
        // decision rather than as a sweep that found nothing.
        if (days <= 0) {
          logger.debug(
            { event: 'location.retention_disabled' },
            'location retention is disabled; keeping all history',
          );
          return;
        }

        // Batched, and capped per run.
        //
        // One unbounded DELETE across a table that reaches millions of rows
        // holds a lock long enough to stall the 30-second flush job writing to
        // it - so the sweep would degrade exactly the thing it exists to keep
        // healthy. 10k rows a batch, 100 batches a run: a million rows a day,
        // which outpaces any plausible accumulation, and the run ends rather
        // than grinding if it somehow does not.
        const BATCH = 10_000;
        const MAX_BATCHES = 100;
        let deleted = 0;

        for (let i = 0; i < MAX_BATCHES; i += 1) {
          const result = await database.query(
            `DELETE FROM driver_location_history
              WHERE id IN (
                SELECT id FROM driver_location_history
                 WHERE recorded_at < now() - ($1 || ' days')::interval
                 ORDER BY recorded_at
                 LIMIT $2
              )`,
            [String(days), BATCH],
          );

          const rows = result.rowCount ?? 0;
          deleted += rows;
          if (rows < BATCH) break;
        }

        if (deleted > 0) {
          // The COUNT is logged, never the rows. CLAUDE.md §9 - no exact
          // coordinates in a log line, which is the whole reason this job
          // exists.
          logger.info(
            { event: 'location.retention_swept', count: deleted, retention_days: days },
            'deleted location history past the retention window',
          );
        }
      },
      logger,
    ),

    createWorker(
      QUEUE_NAMES.push,
      connection,
      async (job) => {
        const data = job.data as PushJob;

        const summary = await push.pushToUser({
          userId: data.userId,
          title: data.title,
          body: data.body,
          data: data.data,
        });

        logger.info(
          { event: 'push.sent', job_id: job.id, ...summary },
          'push delivery attempted',
        );

        // Thrown so BullMQ retries. Deliberately only when NOTHING landed and
        // something failed: a partial delivery must not be retried, or the
        // devices that already received the notification would get it again
        // on every attempt.
        if (summary.delivered === 0 && summary.failed > 0) {
          throw new Error(`push delivery failed for all ${summary.failed} device(s)`);
        }
      },
      logger,
    ),
  ];

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ event: 'worker.shutdown', signal }, 'shutting down');
    await Promise.all(workers.map((w) => w.close().catch(() => undefined)));
    await queues.close().catch(() => undefined);
    await redis.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info({ event: 'worker.started' }, 'workers running');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`Failed to start workers: ${String(error)}\n`);
  process.exit(1);
});
