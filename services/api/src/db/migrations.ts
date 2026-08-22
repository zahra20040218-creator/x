import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Migration discovery and ordering.
 *
 * Split out from the runner so it can be unit-tested without a database: the
 * ordering rule and the up/down pairing are exactly the parts that go wrong
 * silently, and they need a test that runs on every commit rather than only
 * when Docker is up.
 *
 * CLAUDE.md §9: migrations are forward-only and reversible. "Forward-only"
 * means an APPLIED migration is never edited - a mistake is corrected by a new
 * migration. "Reversible" means each has a `.down.sql` that undoes it, and
 * `make migrate-down` on a fresh database must run clean.
 */

export interface Migration {
  id: string;
  name: string;
  upPath: string;
  downPath: string;
}

const FILENAME = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;

export class MigrationSetError extends Error {}

/**
 * Read a migrations directory and return the migrations in application order.
 *
 * Ordering is by the numeric prefix, compared as a NUMBER rather than
 * lexicographically. That distinction does not matter at 0004 and matters a
 * great deal at 0010 - lexicographic ordering would run 0010 before 0009.
 */
export async function discoverMigrations(directory: string): Promise<Migration[]> {
  const files = await readdir(directory);

  const ups = new Map<string, { name: string; file: string }>();
  const downs = new Map<string, string>();

  for (const file of files) {
    if (!file.endsWith('.sql')) continue;

    const match = FILENAME.exec(file);
    if (!match) {
      throw new MigrationSetError(
        `Migration file "${file}" does not match NNNN_name.(up|down).sql`,
      );
    }

    const [, id, name, direction] = match as unknown as [string, string, string, string];

    if (direction === 'up') {
      const existing = ups.get(id);
      if (existing) {
        throw new MigrationSetError(
          `Two migrations share the prefix ${id}: "${existing.name}" and "${name}".`,
        );
      }
      ups.set(id, { name, file });
    } else {
      downs.set(id, file);
    }
  }

  const migrations: Migration[] = [];
  for (const [id, { name, file }] of ups) {
    const downFile = downs.get(id);
    if (!downFile) {
      throw new MigrationSetError(
        `Migration ${id}_${name} has no .down.sql. CLAUDE.md §9 requires migrations to be reversible.`,
      );
    }
    migrations.push({
      id,
      name,
      upPath: path.join(directory, file),
      downPath: path.join(directory, downFile),
    });
  }

  // Numeric, not lexicographic.
  migrations.sort((a, b) => Number(a.id) - Number(b.id));

  const orphanDowns = [...downs.keys()].filter((id) => !ups.has(id));
  if (orphanDowns.length > 0) {
    throw new MigrationSetError(
      `Down migrations with no matching up migration: ${orphanDowns.join(', ')}`,
    );
  }

  return migrations;
}

export async function readMigrationSql(
  migration: Migration,
  direction: 'up' | 'down',
): Promise<string> {
  return readFile(direction === 'up' ? migration.upPath : migration.downPath, 'utf8');
}

/**
 * Statements a migration must never contain.
 *
 * CLAUDE.md §12.9 forbids dropping a column holding production data without an
 * explicit two-phase plan, and §6.3 forbids mutating ledger rows. A migration
 * is the one place where both are easy to do by accident and impossible to
 * undo, so the runner refuses rather than trusting review.
 */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\bUPDATE\s+ledger_entries\b/i,
    reason: 'the ledger is append-only (CLAUDE.md §6.3 / §12.3)',
  },
  {
    pattern: /\bDELETE\s+FROM\s+ledger_entries\b/i,
    reason: 'the ledger is append-only (CLAUDE.md §6.3 / §12.3)',
  },
  {
    pattern: /\bTRUNCATE\s+(TABLE\s+)?ledger_entries\b/i,
    reason: 'the ledger is append-only (CLAUDE.md §6.3 / §12.3)',
  },
  {
    pattern: /\bUPDATE\s+ride_events\b/i,
    reason: 'ride_events is append-only (CLAUDE.md §4)',
  },
  {
    pattern: /\bDELETE\s+FROM\s+ride_events\b/i,
    reason: 'ride_events is append-only (CLAUDE.md §4)',
  },
];

/**
 * A DROP COLUMN in an UP migration needs an explicit acknowledgement comment
 * naming the two-phase plan, because the data is gone the moment it runs.
 */
const DROP_COLUMN = /\bALTER\s+TABLE\s+\S+\s+DROP\s+COLUMN\b/i;
const TWO_PHASE_ACK = /--\s*two-phase-drop-approved:/i;

export function assertMigrationIsSafe(
  sql: string,
  migrationName: string,
  direction: 'up' | 'down',
): void {
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(sql)) {
      throw new MigrationSetError(
        `Migration ${migrationName} (${direction}) is refused: it mutates an append-only table, and ${reason}.`,
      );
    }
  }

  if (direction === 'up' && DROP_COLUMN.test(sql) && !TWO_PHASE_ACK.test(sql)) {
    throw new MigrationSetError(
      `Migration ${migrationName} drops a column without a two-phase plan. ` +
        `CLAUDE.md §12.9 requires one. Add a comment "-- two-phase-drop-approved: <plan>" ` +
        `once the column is confirmed unused by every deployed version.`,
    );
  }
}
