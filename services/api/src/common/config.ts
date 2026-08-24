import { z } from 'zod';

/**
 * Environment configuration. CLAUDE.md §9: every boundary is validated with
 * Zod, and env is a boundary - it is the one place where a typo does not fail
 * until 3am under load.
 *
 * Everything is parsed and coerced ONCE at boot. Nothing anywhere else reads
 * process.env.
 */

const intFromEnv = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromEnv(1, 65_535).default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // CLAUDE.md §3.3 - this must point at PgBouncer, never at Postgres directly.
  DATABASE_URL: z.string().min(1),
  DATABASE_MAX_CONNECTIONS: intFromEnv(1, 100).default(10),
  DATABASE_MIGRATION_URL: z.string().min(1).optional(),

  REDIS_URL: z.string().min(1),

  FIREBASE_PROJECT_ID: z.string().min(1),

  // A short secret is a real vulnerability, not a style preference: HS256 with
  // a guessable key means anyone can mint an admin token.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: intFromEnv(60, 86_400).default(3_600),
  JWT_REFRESH_TTL_SECONDS: intFromEnv(3_600, 31_536_000).default(2_592_000),

  MATCH_SEARCH_RADIUS_METERS: intFromEnv(500, 50_000).default(5_000),
  MATCH_OFFER_TIMEOUT_SECONDS: intFromEnv(5, 120).default(15),
  MATCH_CLAIM_TTL_MS: intFromEnv(5_000, 300_000).default(30_000),
  MATCH_MAX_DRIVERS_PER_RIDE: intFromEnv(1, 50).default(8),

  LOCATION_FLUSH_INTERVAL_MS: intFromEnv(1_000, 300_000).default(30_000),
  LOCATION_FLUSH_BATCH_SIZE: intFromEnv(1, 5_000).default(500),
  DRIVER_PRESENCE_TTL_SECONDS: intFromEnv(10, 600).default(60),

  IDEMPOTENCY_TTL_SECONDS: intFromEnv(60, 604_800).default(86_400),

  /**
   * Divides a route's Redis rate limit to produce the per-instance limit used
   * while Redis is unreachable. SET THIS TO YOUR INSTANCE COUNT.
   *
   * The fallback counter lives in process memory, so N instances each permit
   * this many. Leaving it at 1 with 4 instances means the effective limit
   * during an outage is 4x what you intended.
   */
  RATE_LIMIT_LOCAL_DIVISOR: intFromEnv(1, 64).default(4),

  /**
   * How long the limiter waits for Redis before treating it as unavailable.
   *
   * Small on purpose. ioredis queues commands while disconnected rather than
   * rejecting them, so without this a hung Redis would add its full latency to
   * every request on the hot path.
   */
  RATE_LIMIT_REDIS_TIMEOUT_MS: intFromEnv(5, 5_000).default(50),

  GATEWAY_WEBHOOK_SECRET: z.string().min(16).optional(),

  /**
   * Firebase service account JSON, for FCM HTTP v1.
   *
   * Optional: without it the API still boots and still enqueues push jobs, but
   * every delivery is reported as a transient failure and logged. That is the
   * honest degradation - reporting success would make the metrics claim
   * notifications work, and treating it as fatal would stop a developer
   * running the stack locally.
   *
   * THIS IS A SECRET. It contains a private key. ENV only, never committed.
   */
  FCM_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),

  /**
   * Bearer token required to scrape `/v1/metrics`.
   *
   * When unset the endpoint returns 404 and the metrics are simply not
   * exposed. Fail-closed on purpose: metrics describe traffic shape, ride
   * volume and error rates, which is competitive and operational information,
   * and an endpoint that is open by default is open in production too.
   *
   * 404 rather than 401 so an unauthenticated scan cannot even learn that
   * metrics exist here.
   */
  METRICS_TOKEN: z.string().min(16).optional(),

  /**
   * Comma-separated origins allowed to call the API from a browser.
   *
   * An ALLOWLIST, never `*`. The admin panel sends a bearer token, and `*` with
   * credentials would let any site on the internet issue admin requests from a
   * logged-in operator's browser. Empty means "no browser client", which is
   * correct for a deployment that only serves the mobile apps.
   */
  CORS_ALLOWED_ORIGINS: z.string().default(''),
});

export type AppConfig = Readonly<z.infer<typeof ConfigSchema>>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}


/**
 * The port a PostgreSQL URL actually resolves to.
 *
 * Returns 5432 when the URL names no port, because that is what the driver
 * will connect to — the whole point of parsing rather than matching text.
 *
 * Throws on something that is not a URL: a DATABASE_URL that cannot be parsed
 * is a configuration error in its own right, and silently skipping the
 * PgBouncer check for it would turn one mistake into two.
 */
function databasePort(url: string): number {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError([`DATABASE_URL is not a valid URL: ${redactUrl(url)}`]);
  }

  return parsed.port ? Number(parsed.port) : 5432;
}

/** A URL with its password removed, safe to put in an error message. */
function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]*@/, '//***@');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }

  const config = parsed.data;

  // A production deployment pointed straight at Postgres would work fine in
  // testing and then exhaust connections at ~100 concurrent users. Fail at boot
  // rather than discovering it in the field (CLAUDE.md §3.3).
  //
  // This was a regex against `:5432/`, which missed the likeliest form of the
  // mistake: `postgres://host/rideapp` names no port at all and PostgreSQL
  // defaults to 5432. It also missed a URL with no trailing slash, and matched
  // a password that happened to contain the text.
  if (config.NODE_ENV === 'production' && databasePort(config.DATABASE_URL) === 5432) {
    throw new ConfigError([
      'DATABASE_URL points at port 5432, which is Postgres itself. ' +
        'All application DB access must go through PgBouncer (CLAUDE.md §3.3). ' +
        'Use DATABASE_MIGRATION_URL for the direct connection migrations need.',
    ]);
  }

  // `*` is refused outright rather than warned about. With credentials it is
  // not a lax setting, it is an open door to every admin action.
  if (config.CORS_ALLOWED_ORIGINS.split(',').some((o) => o.trim() === '*')) {
    throw new ConfigError([
      'CORS_ALLOWED_ORIGINS must not contain "*". The API is called with a ' +
        'bearer token, and a wildcard origin would let any website issue ' +
        'admin requests from a logged-in operator browser. List origins explicitly.',
    ]);
  }

  return Object.freeze(config);
}

/** Parsed allowlist. Empty array means no browser client is permitted. */
export function corsOrigins(config: AppConfig): string[] {
  return config.CORS_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** DI token for the config object. */
export const APP_CONFIG = Symbol('APP_CONFIG');
