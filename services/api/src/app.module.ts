import { Module, type DynamicModule } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AuditService } from './audit/audit.service.js';
import { AuthService } from './auth/auth.service.js';
import {
  FIREBASE_VERIFIER,
  GoogleFirebaseVerifier,
  type FirebaseVerifier,
} from './auth/firebase-verifier.js';
import { TokenService } from './auth/token.service.js';
import { CLOCK, SystemClock, type Clock } from './common/clock.js';
import { APP_CONFIG, type AppConfig } from './common/config.js';
import { createLogger, LOGGER } from './common/logger.js';
import { DATABASE, type Database } from './db/db.port.js';
import { PgDatabase } from './db/pg-database.js';
import { FareCalculator } from './fare/fare-calculator.js';
import { AdminController } from './http/admin.controller.js';
import { AuthController } from './http/auth.controller.js';
import { AuthGuard } from './http/auth.guard.js';
import { RateLimitGuard } from './http/rate-limit.js';
import { DriverController } from './http/driver.controller.js';
import { NegotiationController } from './http/negotiation.controller.js';
import { OpsController } from './http/ops.controller.js';
import { RidesController } from './http/rides.controller.js';
import { IdempotencyService } from './idempotency/idempotency.service.js';
import { LedgerService } from './ledger/ledger.service.js';
import { FcmSender, parseServiceAccount } from './push/fcm-sender.js';
import { UnconfiguredPushSender, type PushSender } from './push/push.port.js';
import { PushService } from './push/push.service.js';
import { METRICS, MetricsRegistry } from './observability/metrics.js';
import { DriverPresenceService } from './matching/driver-presence.service.js';
import { MatchingService } from './matching/matching.service.js';
import { RideClaimService } from './matching/ride-claim.service.js';
import {
  CashProvider,
  GatewayProvider,
  PaymentProviderRegistry,
} from './payments/payment-provider.js';
import { DriverComplianceService } from './compliance/driver-compliance.service.js';
import { PlatformConfigService } from './platform-config/platform-config.service.js';
import { CapabilityService } from './capabilities/capability.service.js';
import { NegotiationService } from './negotiation/negotiation.service.js';
import { SubscriptionService } from './subscriptions/subscription.service.js';
import { IoRedisAdapter } from './redis/ioredis-adapter.js';
import { REDIS, type RedisPort } from './redis/redis.port.js';
import { RideDispatcher } from './matching/ride-dispatcher.js';
import { RealtimeGateway } from './realtime/realtime.gateway.js';
import { RideStateMachine } from './rides/ride-state-machine.js';
import { RideRepository } from './rides/ride.repository.js';
import { RideService } from './rides/ride.service.js';
import { QueueRegistry, createConnection } from './queue/queues.js';

/**
 * The composition root.
 *
 * Domain services are plain classes with explicit constructors — no decorators,
 * no field injection. That is deliberate: it is what lets the whole correctness
 * core be unit-tested with fakes and no framework, which is where the 95%
 * coverage in CLAUDE.md §10 actually comes from.
 *
 * The cost is this file: every dependency is wired by hand. That is the right
 * trade, and it keeps the graph visible in one place instead of implied across
 * forty decorators.
 */
@Module({})
export class AppModule {
  static forRoot(options: {
    config: AppConfig;
    database?: Database;
    redis?: RedisPort;
    firebase?: FirebaseVerifier;
    clock?: Clock;
  }): DynamicModule {
    const { config } = options;

    const clock = options.clock ?? new SystemClock();
    const logger = createLogger(config.LOG_LEVEL);

    const database =
      options.database ??
      new PgDatabase({
        connectionString: config.DATABASE_URL,
        maxConnections: config.DATABASE_MAX_CONNECTIONS,
      });

    const redis = options.redis ?? IoRedisAdapter.fromUrl(config.REDIS_URL);

    const firebase =
      options.firebase ?? new GoogleFirebaseVerifier(config.FIREBASE_PROJECT_ID);

    const tokens = new TokenService(
      config.JWT_SECRET,
      clock,
      config.JWT_ACCESS_TTL_SECONDS,
      config.JWT_REFRESH_TTL_SECONDS,
    );

    const auth = new AuthService(database, firebase, tokens);
    const audit = new AuditService(logger);
    const ledger = new LedgerService();

    // Push is optional configuration, not optional behaviour: without a
    // service account the API still enqueues jobs and the sender reports every
    // one as a transient failure, loudly. It never reports success it did not
    // achieve, and it never marks a real device token invalid because OUR
    // credentials are missing - that would delete the fleet on first deploy.
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

    const metrics = new MetricsRegistry();
    const fare = new FareCalculator();
    const platformConfig = new PlatformConfigService(clock);
    const stateMachine = new RideStateMachine();
    const rideRepository = new RideRepository();

    const claims = new RideClaimService(redis, config.MATCH_CLAIM_TTL_MS, logger);

    const presence = new DriverPresenceService(
      redis,
      clock,
      config.DRIVER_PRESENCE_TTL_SECONDS,
    );

    // Constructed BEFORE RideService so ride events have somewhere to go. It
    // used to be built after, which is part of why nothing ever published to
    // it: there was no way to hand it to the service that produces the events.
    const realtime = new RealtimeGateway(tokens, redis, logger);

    // Built BEFORE RideService, because settlement goes through it.
    //
    // It was constructed here and injected into nothing: the seam CLAUDE.md §7
    // exists to prove had never carried a payment, because `RideService`
    // inlined the cash path instead. Passing it in is what makes §7's promise -
    // "adding ZainCash means implementing three methods" - a tested claim
    // rather than an assertion in a comment.
    const payments = new PaymentProviderRegistry([
      new CashProvider(ledger),
      new GatewayProvider(),
    ]);

    const rideService = new RideService(
      database,
      rideRepository,
      stateMachine,
      claims,
      ledger,
      fare,
      platformConfig,
      clock,
      logger,
      realtime,
      payments,
    );

    // Document compliance. Reads its policy from platform_config, so an owner
    // can turn it on without a deploy (the same mechanism as commission,
    // CLAUDE.md §6.5). Empty policy - the default - means no check runs at all.
    //
    // An unknown document name in the configured list is logged rather than
    // thrown: it comes from a text field in an admin form, and an exception
    // here would take driver matching down for the whole city over a typo.
    const compliance = new DriverComplianceService(clock, () =>
      platformConfig.requiredDriverDocuments(database, (unknown) => {
        logger.warn(
          { event: 'compliance.unknown_document_type', value: unknown },
          'ignoring an unknown document type in required_driver_documents',
        );
      }),
    );

    // The one place that answers "may this user drive" (CLAUDE.md §1.1).
    //
    // Built AFTER compliance because it composes it rather than repeating it:
    // documents are one of six conditions, and the other five live in columns
    // this service joins. Nothing else in the codebase should re-derive the
    // answer - a second derivation is a second thing to keep in step.
    const subscriptions = new SubscriptionService(ledger, clock);

    const capabilities = new CapabilityService(database, compliance, clock, () =>
      platformConfig.subscriptionRequired(database),
    );

    // Negotiation. Registered in no module until now, while
    // docs/api-contract.yaml documented three endpoints for it - so the
    // contract promised paths that answered 404 and 600 tested lines were
    // unreachable. `negotiation_enabled` ships FALSE, so wiring it changes
    // nothing for anyone until an owner switches it on; every method answers
    // 501 before that.
    const negotiation = new NegotiationService(
      database,
      rideRepository,
      stateMachine,
      claims,
      platformConfig,
      capabilities,
      clock,
      realtime,
      logger,
    );

    const matching = new MatchingService(
      database,
      rideRepository,
      rideService,
      presence,
      platformConfig,
      redis,
      clock,
      config.MATCH_MAX_DRIVERS_PER_RIDE,
      logger,
      compliance,
    );

    const idempotency = new IdempotencyService(clock, config.IDEMPOTENCY_TTL_SECONDS, logger);

    const queues = new QueueRegistry(createConnection(config.REDIS_URL));

    // Wired at last: this is what turns a created ride into an offered one.
    const dispatcher = new RideDispatcher(queues, logger);

    return {
      module: AppModule,
      controllers: [
        AuthController,
        RidesController,
        DriverController,
        AdminController,
        NegotiationController,
        OpsController,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
        { provide: CLOCK, useValue: clock },
        { provide: DATABASE, useValue: database },
        { provide: REDIS, useValue: redis },
        { provide: FIREBASE_VERIFIER, useValue: firebase },

        { provide: TokenService, useValue: tokens },
        { provide: AuthService, useValue: auth },
        { provide: AuditService, useValue: audit },
        { provide: LedgerService, useValue: ledger },
        { provide: PushService, useValue: push },
        { provide: METRICS, useValue: metrics },
        { provide: 'METRICS_TOKEN', useValue: config.METRICS_TOKEN },
        { provide: FareCalculator, useValue: fare },
        { provide: PlatformConfigService, useValue: platformConfig },
        { provide: DriverComplianceService, useValue: compliance },
        { provide: CapabilityService, useValue: capabilities },
        { provide: SubscriptionService, useValue: subscriptions },
        { provide: NegotiationService, useValue: negotiation },
        { provide: RideStateMachine, useValue: stateMachine },
        { provide: RideRepository, useValue: rideRepository },
        { provide: RideClaimService, useValue: claims },
        { provide: DriverPresenceService, useValue: presence },
        { provide: RideService, useValue: rideService },
        { provide: MatchingService, useValue: matching },
        { provide: IdempotencyService, useValue: idempotency },
        { provide: PaymentProviderRegistry, useValue: payments },
        { provide: RealtimeGateway, useValue: realtime },
        { provide: RideDispatcher, useValue: dispatcher },
        { provide: QueueRegistry, useValue: queues },

        AuthGuard,
        {
          provide: RateLimitGuard,
          useFactory: (reflector: Reflector) =>
            new RateLimitGuard(redis, clock, reflector, logger, {
              localDivisor: config.RATE_LIMIT_LOCAL_DIVISOR,
              redisTimeoutMs: config.RATE_LIMIT_REDIS_TIMEOUT_MS,
            }),
          inject: [Reflector],
        },

        // Controllers take these by symbol rather than by class, because
        // Database and RedisPort are interfaces with no runtime identity.
        { provide: 'Database', useValue: database },
        { provide: 'RedisPort', useValue: redis },
        { provide: 'GATEWAY_WEBHOOK_SECRET', useValue: config.GATEWAY_WEBHOOK_SECRET },
      ],
      exports: [DATABASE, REDIS, RealtimeGateway, QueueRegistry, MatchingService],
    };
  }
}
