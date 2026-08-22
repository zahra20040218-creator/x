import { Module, type DynamicModule } from '@nestjs/common';

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
import { DriverController } from './http/driver.controller.js';
import { OpsController } from './http/ops.controller.js';
import { RidesController } from './http/rides.controller.js';
import { IdempotencyService } from './idempotency/idempotency.service.js';
import { LedgerService } from './ledger/ledger.service.js';
import { DriverPresenceService } from './matching/driver-presence.service.js';
import { MatchingService } from './matching/matching.service.js';
import { RideClaimService } from './matching/ride-claim.service.js';
import {
  CashProvider,
  GatewayProvider,
  PaymentProviderRegistry,
} from './payments/payment-provider.js';
import { PlatformConfigService } from './platform-config/platform-config.service.js';
import { IoRedisAdapter } from './redis/ioredis-adapter.js';
import { REDIS, type RedisPort } from './redis/redis.port.js';
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
    const ledger = new LedgerService();
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
    );

    const idempotency = new IdempotencyService(clock, config.IDEMPOTENCY_TTL_SECONDS);

    const payments = new PaymentProviderRegistry([
      new CashProvider(ledger),
      new GatewayProvider(),
    ]);

    const realtime = new RealtimeGateway(tokens, redis, logger);
    const queues = new QueueRegistry(createConnection(config.REDIS_URL));

    return {
      module: AppModule,
      controllers: [
        AuthController,
        RidesController,
        DriverController,
        AdminController,
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
        { provide: LedgerService, useValue: ledger },
        { provide: FareCalculator, useValue: fare },
        { provide: PlatformConfigService, useValue: platformConfig },
        { provide: RideStateMachine, useValue: stateMachine },
        { provide: RideRepository, useValue: rideRepository },
        { provide: RideClaimService, useValue: claims },
        { provide: DriverPresenceService, useValue: presence },
        { provide: RideService, useValue: rideService },
        { provide: MatchingService, useValue: matching },
        { provide: IdempotencyService, useValue: idempotency },
        { provide: PaymentProviderRegistry, useValue: payments },
        { provide: RealtimeGateway, useValue: realtime },
        { provide: QueueRegistry, useValue: queues },

        AuthGuard,

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
