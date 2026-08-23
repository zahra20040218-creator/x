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
import { FareCalculator } from './fare/fare-calculator.js';
import { PlatformConfigService } from './platform-config/platform-config.service.js';
import { IoRedisAdapter } from './redis/ioredis-adapter.js';
import { RideStateMachine } from './rides/ride-state-machine.js';
import { RideRepository } from './rides/ride.repository.js';
import { RideService } from './rides/ride.service.js';
import {
  QUEUE_NAMES,
  type PushJob,
  QueueRegistry,
  createConnection,
  createWorker,
} from './queue/queues.js';
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

  const rideService = new RideService(
    database,
    repository,
    new RideStateMachine(),
    new RideClaimService(redis, config.MATCH_CLAIM_TTL_MS, logger),
    new LedgerService(),
    new FareCalculator(),
    platformConfig,
    clock,
    logger,
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

  const idempotency = new IdempotencyService(clock, config.IDEMPOTENCY_TTL_SECONDS);
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
