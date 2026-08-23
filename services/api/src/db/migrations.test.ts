import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertMigrationIsSafe,
  discoverMigrations,
  MigrationSetError,
  readMigrationSql,
} from './migrations.js';

const REAL_MIGRATIONS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations',
);

async function scratchDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'migrations-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

describe('discoverMigrations', () => {
  it('orders by numeric prefix, not lexicographically', async () => {
    const dir = await scratchDir({
      '0002_b.up.sql': '', '0002_b.down.sql': '',
      '0010_j.up.sql': '', '0010_j.down.sql': '',
      '0001_a.up.sql': '', '0001_a.down.sql': '',
      '0009_i.up.sql': '', '0009_i.down.sql': '',
    });

    const found = await discoverMigrations(dir);

    // Lexicographic ordering would put 0010 before 0009. It does not matter at
    // four migrations and matters enormously at eleven.
    expect(found.map((m) => m.name)).toEqual(['a', 'b', 'i', 'j']);
  });

  it('rejects an up migration with no down', async () => {
    const dir = await scratchDir({ '0001_a.up.sql': '' });
    await expect(discoverMigrations(dir)).rejects.toThrow(/no \.down\.sql/);
  });

  it('rejects a down migration with no up', async () => {
    const dir = await scratchDir({ '0001_a.down.sql': '' });
    await expect(discoverMigrations(dir)).rejects.toThrow(/no matching up migration/);
  });

  it('rejects two migrations sharing a prefix', async () => {
    const dir = await scratchDir({
      '0001_a.up.sql': '', '0001_a.down.sql': '',
      '0001_b.up.sql': '', '0001_b.down.sql': '',
    });
    await expect(discoverMigrations(dir)).rejects.toThrow(/share the prefix/);
  });

  it('rejects a badly named file rather than skipping it', async () => {
    // Silently ignoring an unrecognised file is how a migration gets written,
    // committed, and never applied.
    const dir = await scratchDir({ 'add_column.sql': '' });
    await expect(discoverMigrations(dir)).rejects.toThrow(MigrationSetError);
  });

  it('ignores non-SQL files', async () => {
    const dir = await scratchDir({
      '0001_a.up.sql': '', '0001_a.down.sql': '', 'README.md': 'notes',
    });
    await expect(discoverMigrations(dir)).resolves.toHaveLength(1);
  });
});

describe('the real migration set', () => {
  it('discovers every migration in order', async () => {
    const found = await discoverMigrations(REAL_MIGRATIONS);
    expect(found.map((m) => `${m.id}_${m.name}`)).toEqual([
      '0001_identity',
      '0002_rides',
      '0003_ledger',
      '0004_operations',
      '0005_audit_log',
      '0006_sessions',
    ]);
  });

  it('every migration passes the safety check in both directions', async () => {
    for (const migration of await discoverMigrations(REAL_MIGRATIONS)) {
      for (const direction of ['up', 'down'] as const) {
        const sql = await readMigrationSql(migration, direction);
        expect(() =>
          assertMigrationIsSafe(sql, `${migration.id}_${migration.name}`, direction),
        ).not.toThrow();
      }
    }
  });

  // CLAUDE.md §6.1 / §12.2 - the money type, checked against the actual DDL.
  it('declares every money column as BIGINT and never as a float type', async () => {
    const migrations = await discoverMigrations(REAL_MIGRATIONS);
    let moneyColumns = 0;

    for (const migration of migrations) {
      const sql = await readMigrationSql(migration, 'up');

      for (const line of sql.split('\n')) {
        if (!/_iqd\s/i.test(line)) continue;
        if (/^\s*(--|CONSTRAINT|CHECK)/i.test(line)) continue;
        if (!/^\s+\w+_iqd\s+\w+/.test(line)) continue;

        moneyColumns++;
        expect(line).toMatch(/\bBIGINT\b/i);
        expect(line).not.toMatch(/\b(NUMERIC|DECIMAL|REAL|DOUBLE|FLOAT|MONEY)\b/i);
      }
    }

    // Pinned exactly, for two reasons. It stops the assertion above passing
    // vacuously if the scan ever stops matching, and it makes adding a money
    // column a deliberate act: the new column has to be counted here, which
    // means someone re-read this test and confirmed the new column is BIGINT.
    //
    // The six are: rides.estimated_fare_iqd, rides.final_fare_iqd,
    // rides.commission_iqd, ledger_entries.amount_iqd, payments.amount_iqd,
    // wallet_topups.amount_iqd.
    expect(moneyColumns).toBe(6);
  });

  it('creates the composite index CLAUDE.md §3.4 mandates for rides', async () => {
    const sql = await readMigrationSql(
      (await discoverMigrations(REAL_MIGRATIONS))[1]!,
      'up',
    );
    expect(sql).toMatch(/CREATE INDEX rides_status_created_at_idx ON rides \(status, created_at/i);
  });

  it('creates a GiST index on the geography column', async () => {
    const sql = await readMigrationSql(
      (await discoverMigrations(REAL_MIGRATIONS))[3]!,
      'up',
    );
    expect(sql).toMatch(/USING GIST \(position\)/i);
  });

  it('installs the append-only triggers on both audit tables', async () => {
    const migrations = await discoverMigrations(REAL_MIGRATIONS);
    const rides = await readMigrationSql(migrations[1]!, 'up');
    const ledger = await readMigrationSql(migrations[2]!, 'up');

    expect(rides).toMatch(/ride_events_no_update/);
    expect(rides).toMatch(/ride_events_no_delete/);
    expect(ledger).toMatch(/ledger_entries_no_update/);
    expect(ledger).toMatch(/ledger_entries_no_delete/);
    expect(ledger).toMatch(/ledger_entries_balanced/);
  });

  it('defends against a second live ride per driver at the database level', async () => {
    const sql = await readMigrationSql(
      (await discoverMigrations(REAL_MIGRATIONS))[1]!,
      'up',
    );
    expect(sql).toMatch(/CREATE UNIQUE INDEX rides_one_active_per_driver_uq/i);
    expect(sql).toMatch(/CREATE UNIQUE INDEX rides_one_active_per_rider_uq/i);
  });

  it('seeds commission_bps at the CLAUDE.md §6.5 default of 0', async () => {
    const sql = await readMigrationSql(
      (await discoverMigrations(REAL_MIGRATIONS))[0]!,
      'up',
    );
    expect(sql).toMatch(/\('commission_bps',\s*'0'/);
  });
});

describe('assertMigrationIsSafe', () => {
  it.each([
    ['UPDATE ledger_entries SET amount_iqd = 0;', /append-only/],
    ['DELETE FROM ledger_entries WHERE id = 1;', /append-only/],
    ['TRUNCATE TABLE ledger_entries;', /append-only/],
    ['UPDATE ride_events SET to_state = %s;', /append-only/],
    ['DELETE FROM ride_events;', /append-only/],
  ])('refuses %s', (sql, expected) => {
    expect(() => assertMigrationIsSafe(sql, '0005_bad', 'up')).toThrow(expected);
  });

  // CLAUDE.md §12.9
  it('refuses an unacknowledged DROP COLUMN in an up migration', () => {
    expect(() =>
      assertMigrationIsSafe('ALTER TABLE rides DROP COLUMN pickup_address;', '0005_x', 'up'),
    ).toThrow(/two-phase plan/);
  });

  it('allows a DROP COLUMN once the two-phase plan is acknowledged', () => {
    expect(() =>
      assertMigrationIsSafe(
        '-- two-phase-drop-approved: unused since v1.4, verified on 2026-03-01\n' +
          'ALTER TABLE rides DROP COLUMN pickup_address;',
        '0005_x',
        'up',
      ),
    ).not.toThrow();
  });

  it('allows a DROP COLUMN in a down migration, which reverses a recent add', () => {
    expect(() =>
      assertMigrationIsSafe('ALTER TABLE rides DROP COLUMN new_thing;', '0005_x', 'down'),
    ).not.toThrow();
  });

  it('allows ordinary DDL', () => {
    expect(() =>
      assertMigrationIsSafe('CREATE INDEX foo ON rides (status);', '0005_x', 'up'),
    ).not.toThrow();
  });
});
