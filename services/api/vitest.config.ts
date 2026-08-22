import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Three projects, because they have three different requirements:
 *
 *   unit        - no Docker, no network. Runs anywhere, always. This is the
 *                 tier that carries the CLAUDE.md §10 95% correctness-core
 *                 threshold.
 *   integration - needs a real Postgres and Redis. SKIPS ITSELF (rather than
 *                 failing) when TEST_DATABASE_URL / TEST_REDIS_URL are absent,
 *                 so `make test` stays green on a laptop without Docker while
 *                 still being a hard gate in CI where those vars are set.
 *   e2e         - full HTTP surface against an in-process Nest app.
 */
export default defineConfig({
  plugins: [
    // Nest's DI reads design:paramtypes metadata, which esbuild does not emit.
    // swc does. Without this, every injected controller resolves to undefined.
    swc.vite({ module: { type: 'es6' } }),
  ],
  test: {
    globals: true,
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: '../../coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/main.ts',
        'src/worker.ts',
        'src/**/*.module.ts',
        'src/db/migrate.ts',
        'src/db/seed.ts',
      ],
      // CLAUDE.md §10 - "other backend services: 70%".
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
        // The correctness core carries 95%. These are per-file globs, so a
        // regression in ONE of these files fails the build even if the overall
        // number still looks healthy.
        'src/rides/ride-state-machine.ts': {
          lines: 95, functions: 95, branches: 95, statements: 95,
        },
        'src/matching/ride-claim.service.ts': {
          lines: 95, functions: 95, branches: 95, statements: 95,
        },
        'src/matching/matching.service.ts': {
          lines: 95, functions: 95, branches: 95, statements: 95,
        },
        'src/ledger/ledger.service.ts': {
          lines: 95, functions: 95, branches: 95, statements: 95,
        },
        'src/money/iqd.ts': {
          lines: 95, functions: 95, branches: 95, statements: 95,
        },
        'src/fare/fare-calculator.ts': {
          lines: 95, functions: 95, branches: 95, statements: 95,
        },
      },
    },
  },
});
