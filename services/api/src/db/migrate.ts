import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import pg from 'pg';

import {
  assertMigrationIsSafe,
  discoverMigrations,
  readMigrationSql,
  type Migration,
} from './migrations.js';

/**
 * Migration runner.
 *
 * Connects DIRECTLY to Postgres, not through PgBouncer. This is the single
 * documented exception to CLAUDE.md §3.3, and it is necessary: DDL and
 * `CREATE EXTENSION` need a session, and PgBouncer in transaction pooling mode
 * does not give a stable one. Application code still goes through PgBouncer -
 * see PgDatabase.
 *
 *   pnpm migrate:up      apply everything pending
 *   pnpm migrate:down    roll back the most recent migration
 *   pnpm migrate:down 3  roll back the last three
 */

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations',
);

const HISTORY_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id          TEXT PRIMARY KEY,
    name        TEXT        NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

async function appliedIds(client: pg.Client): Promise<Set<string>> {
  const result = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
  return new Set(result.rows.map((r) => r.id));
}

/**
 * Each migration runs in its OWN transaction, and the history row is written in
 * that same transaction. A failure therefore leaves the database at a known
 * migration boundary rather than half-way through one.
 */
async function applyOne(
  client: pg.Client,
  migration: Migration,
  direction: 'up' | 'down',
): Promise<void> {
  const label = `${migration.id}_${migration.name}`;
  const sql = await readMigrationSql(migration, direction);

  assertMigrationIsSafe(sql, label, direction);

  process.stdout.write(`  ${direction === 'up' ? 'applying' : 'reverting'} ${label} ... `);

  await client.query('BEGIN');
  try {
    await client.query(sql);
    if (direction === 'up') {
      await client.query(
        'INSERT INTO schema_migrations (id, name) VALUES ($1, $2)',
        [migration.id, migration.name],
      );
    } else {
      await client.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
    }
    await client.query('COMMIT');
    process.stdout.write('ok\n');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    process.stdout.write('FAILED\n');
    throw error;
  }
}

export async function migrateUp(connectionString: string): Promise<number> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query(HISTORY_TABLE);
    const applied = await appliedIds(client);
    const migrations = await discoverMigrations(MIGRATIONS_DIR);
    const pending = migrations.filter((m) => !applied.has(m.id));

    if (pending.length === 0) {
      process.stdout.write('No pending migrations.\n');
      return 0;
    }

    for (const migration of pending) {
      await applyOne(client, migration, 'up');
    }
    return pending.length;
  } finally {
    await client.end();
  }
}

export async function migrateDown(connectionString: string, steps = 1): Promise<number> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query(HISTORY_TABLE);
    const applied = await appliedIds(client);
    const migrations = await discoverMigrations(MIGRATIONS_DIR);

    const toRevert = migrations
      .filter((m) => applied.has(m.id))
      .reverse()
      .slice(0, steps);

    if (toRevert.length === 0) {
      process.stdout.write('Nothing to revert.\n');
      return 0;
    }

    for (const migration of toRevert) {
      await applyOne(client, migration, 'down');
    }
    return toRevert.length;
  } finally {
    await client.end();
  }
}

/**
 * CLI entry point.
 *
 * `pathToFileURL`, not string concatenation. The previous check was
 * `import.meta.url === \`file://${process.argv[1]}\``, which on Windows
 * compares `file:///C:/Users/.../migrate.js` against
 * `file://C:\Users\...\migrate.js` and never matches — so
 * `migrate:up` exited 0 having applied nothing. A migration command that
 * reports success and does nothing is worse than one that fails: it produces
 * an empty schema that everyone believes is migrated.
 *
 * Found the first time the migrations were ever executed.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const command = process.argv[2] ?? 'up';
  const steps = Number(process.argv[3] ?? 1);

  const connectionString =
    process.env['DATABASE_MIGRATION_URL'] ?? process.env['DATABASE_URL'];

  if (!connectionString) {
    process.stderr.write(
      'DATABASE_MIGRATION_URL (or DATABASE_URL) must be set. ' +
        'Migrations connect directly to Postgres, not through PgBouncer.\n',
    );
    process.exit(1);
  }

  const run = command === 'down' ? migrateDown(connectionString, steps) : migrateUp(connectionString);

  run
    .then((count) => {
      process.stdout.write(`Done: ${count} migration(s) ${command === 'down' ? 'reverted' : 'applied'}.\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`Migration failed: ${String(error)}\n`);
      process.exit(1);
    });
}
