import { Redis } from 'ioredis';

import { PgDatabase } from '../../src/db/pg-database.js';
import type { Database } from '../../src/db/db.port.js';
import { IoRedisAdapter } from '../../src/redis/ioredis-adapter.js';
import type { RedisPort } from '../../src/redis/redis.port.js';

/**
 * Running the suite against REAL PostgreSQL and REAL Redis.
 *
 * ## Why this file exists at all
 *
 * The commercial audit found that every test in this repository runs against
 * in-memory fakes, and that one of those fakes actively diverges from the real
 * thing under concurrency (D-15: `FakeDatabase.transaction` snapshots the whole
 * database and restores it on any failure, so concurrent rollbacks erase a
 * committed write). D-2 is the same problem for Redis.
 *
 * The obvious way to close those is "run the same tests against the real
 * services". The non-obvious risk is the failure mode that would make that
 * worthless: a harness that *quietly falls back to the fake* when the real
 * service is missing, and then reports green. Someone reads "687 tests passed
 * against real infrastructure" and believes a thing that never happened.
 *
 * So the contract here is deliberately blunt:
 *
 *   - Real infrastructure is opt-IN via `REAL_INFRA=1`.
 *   - When it is opted in and the connection details are missing, every helper
 *     **throws**. It never returns a fake, and it never skips.
 *   - `assertRealDatabase` / `assertRealRedis` re-check the object that was
 *     actually handed to the app, so a wiring mistake upstream surfaces as a
 *     failure rather than as a silent fake.
 *
 * There is no mode in which asking for real infrastructure gets you a fake.
 */

/** Set `REAL_INFRA=1` to demand real services. */
export function isRealInfraRequested(): boolean {
  return process.env['REAL_INFRA'] === '1';
}

const SETUP_HINT = `
Real infrastructure was requested (REAL_INFRA=1) but is not configured.

  docker compose -f infra/docker-compose.yml up -d

  export REAL_INFRA=1
  export TEST_DATABASE_URL=postgres://rideapp:rideapp@localhost:5432/rideapp_test
  export TEST_REDIS_URL=redis://localhost:6379
  pnpm --filter @rideapp/api migrate:up
  pnpm --filter @rideapp/api test

This throws instead of falling back to the in-memory fakes on purpose. A
harness that silently substitutes a fake here would report "passed against real
infrastructure" for a run that never touched a database.
`;

export class RealInfraUnavailableError extends Error {
  constructor(variable: string) {
    super(`${variable} is not set.\n${SETUP_HINT}`);
    this.name = 'RealInfraUnavailableError';
  }
}

export function realDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new RealInfraUnavailableError('TEST_DATABASE_URL');
  return url;
}

export function realRedisUrl(): string {
  const url = process.env['TEST_REDIS_URL'];
  if (!url) throw new RealInfraUnavailableError('TEST_REDIS_URL');
  return url;
}

/**
 * A real connection pool.
 *
 * `maxConnections` is small because the suite runs several files in parallel
 * and PgBouncer's pool is the documented bottleneck at 500 users
 * (CLAUDE.md §3.3). A test run that exhausts the pool fails in a way that looks
 * like a product bug, so it is capped low and deliberately.
 */
export function createRealDatabase(maxConnections = 5): PgDatabase {
  return new PgDatabase({ connectionString: realDatabaseUrl(), maxConnections });
}

export interface RealRedis {
  adapter: IoRedisAdapter;
  /** Empty the selected database. Test-only; see the note below. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The harness owns the raw ioredis client so that it can `FLUSHDB` between
 * tests.
 *
 * `FLUSHDB` is deliberately NOT added to `RedisPort`. That interface is the
 * production contract, and putting "erase everything" on it so that tests can
 * tidy up would put a foot-gun one autocomplete away from the request path.
 * The blast radius is bounded by the database index in TEST_REDIS_URL - point
 * it at a dedicated db (e.g. `redis://localhost:6379/15`), never at db 0 of
 * anything you care about.
 */
export function createRealRedis(): RealRedis {
  const client = new Redis(realRedisUrl(), { maxRetriesPerRequest: 2 });
  const adapter = new IoRedisAdapter(client);

  return {
    adapter,
    flush: async () => {
      await client.flushdb();
    },
    close: async () => {
      await adapter.close();
    },
  };
}

/**
 * The anti-lying guard.
 *
 * Call it with the object the application was actually built with. If a test
 * claims to be running against real infrastructure, this is what makes the
 * claim checkable rather than a comment.
 */
export function assertRealDatabase(database: Database): void {
  if (!(database instanceof PgDatabase)) {
    throw new Error(
      `Expected a real PgDatabase, got ${database.constructor.name}. ` +
        'This run is NOT against real infrastructure and must not be reported as one.',
    );
  }
}

export function assertRealRedis(redis: RedisPort): void {
  if (!(redis instanceof IoRedisAdapter)) {
    throw new Error(
      `Expected a real IoRedisAdapter, got ${redis.constructor.name}. ` +
        'This run is NOT against real infrastructure and must not be reported as one.',
    );
  }
}

/**
 * Empty every table without dropping the schema.
 *
 * `TRUNCATE ... RESTART IDENTITY CASCADE` in one statement so that foreign keys
 * do not dictate an ordering, and so it is a single round trip between tests.
 *
 * Deliberately NOT re-running migrations per test: applying six migrations
 * before every test file would dominate the runtime, and a truncate leaves the
 * schema, the triggers and the constraints in place - which are precisely the
 * things these tests exist to exercise.
 */
export async function truncateAll(database: Database): Promise<void> {
  assertRealDatabase(database);

  // Excludes two categories that must survive:
  //   schema_migrations - truncating it would make the next run re-apply every
  //     migration on top of an existing schema.
  //   PostGIS's own tables - `spatial_ref_sys` holds several thousand
  //     projection definitions that the extension installs. Emptying it does
  //     not fail loudly; it makes every later coordinate transform wrong.
  const result = await database.query<{ tablename: string }>(
    `SELECT c.relname AS tablename
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relkind = 'r'
        AND c.relname <> 'schema_migrations'
        AND c.oid NOT IN (
          SELECT objid FROM pg_depend WHERE deptype = 'e' AND classid = 'pg_class'::regclass
        )`,
  );

  if (result.rows.length === 0) {
    throw new Error(
      'No tables found. Run the migrations first: pnpm --filter @rideapp/api migrate:up',
    );
  }

  const tables = result.rows.map((r) => `"${r.tablename}"`).join(', ');
  await database.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}

