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

    /**
     * Serial file execution, but ONLY when running against real services.
     *
     * The integration files share one real Postgres database and one real
     * Redis database, and they clean up with TRUNCATE and FLUSHDB. Run in
     * parallel they erase each other's state mid-test - the claim suite
     * flushed the conformance suite's keys, and BOTH reported failures that
     * had nothing to do with the code. One of them looked exactly like the
     * P0 this repository exists to close.
     *
     * Parallel execution over shared mutable external state is not a
     * speed-versus-safety trade. It is simply wrong, and the failures it
     * invents are indistinguishable from real ones.
     *
     * Conditional because the unit and e2e tiers use in-memory fakes with no
     * shared state, and making 700 of them serial to protect 63 would be a
     * poor trade. `fileParallelism` is a ROOT option - setting it inside a
     * project entry is silently ignored, which is how this was missed the
     * first time.
     */
    fileParallelism: process.env['REAL_INFRA'] !== '1',
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
