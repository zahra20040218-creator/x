import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';

import { AppModule } from './app.module.js';
import { corsOrigins, loadConfig } from './common/config.js';
import { createLogger, newRequestId, runWithRequestContext } from './common/logger.js';
import { DATABASE, type Database } from './db/db.port.js';
import { ProblemFilter } from './http/problem.filter.js';
import { AuthGuard } from './http/auth.guard.js';
import { RealtimeGateway } from './realtime/realtime.gateway.js';

/**
 * API entry point.
 *
 * Config is loaded and validated FIRST, before anything else is constructed.
 * A bad `DATABASE_URL` or a short `JWT_SECRET` fails here, at boot, rather than
 * on the first request at 3am (see common/config.ts).
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({ config }),
    { bufferLogs: true, bodyParser: false },
  );

  // The webhook signature is computed over the RAW bytes (CLAUDE.md §7). Parsing
  // and re-serialising reorders keys, and the signature would never match - so
  // the raw body is captured here and carried on the parsed object.
  app.use(
    express.json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        if (req.url?.startsWith('/v1/payments/webhook')) {
          (req as unknown as { rawBody: string }).rawBody = buf.toString('utf8');
        }
      },
    }),
  );

  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const body = req.body as Record<string, unknown> | undefined;
    const raw = (req as unknown as { rawBody?: string }).rawBody;
    if (raw && body && typeof body === 'object') {
      Object.defineProperty(body, '__raw', { value: raw, enumerable: false });
    }
    next();
  });

  // CLAUDE.md §9 - every log line carries request_id, taken from async context
  // so no call site has to remember to pass it.
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const header = req.headers['x-request-id'];
    const requestId = typeof header === 'string' && header.length <= 200 ? header : newRequestId();
    res.setHeader('X-Request-Id', requestId);
    runWithRequestContext({ requestId }, () => next());
  });

  // S-5 from docs/security-audit.md. Without this the admin panel simply does
  // not work; with a wildcard it would be a hole. Allowlist only.
  const origins = corsOrigins(config);
  if (origins.length > 0) {
    app.enableCors({
      origin: origins,
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    });
  }

  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new ProblemFilter(logger));
  app.useGlobalGuards(app.get(AuthGuard));
  app.enableShutdownHooks();

  const server = await app.listen(config.PORT);

  const realtime = app.get(RealtimeGateway);
  realtime.attach(server as never);

  const database = app.get<Database>(DATABASE);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ event: 'api.shutdown', signal }, 'shutting down');
    await realtime.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info({ event: 'api.started', port: config.PORT }, 'api listening');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`Failed to start API: ${String(error)}\n`);
  process.exit(1);
});
