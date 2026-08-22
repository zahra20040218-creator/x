# VERIFY.md — raw machine output

Generated: 2026-08-22T19:01:22Z
Host: no Docker, no Flutter SDK, no Postgres, no Redis (see BLOCKED.md).

RUN_AUTONOMOUS.md §4: if this file and FINAL_REPORT.md disagree, THIS file
is correct. It is pasted command output, not narration.

## 1. `pnpm --filter @rideapp/api test` (vitest, all projects, with coverage)

```
 ↓  integration  test/integration/ioredis-conformance.test.ts (1 test | 1 skipped)
 Test Files  9 passed | 1 skipped (10)
      Tests  296 passed | 1 skipped (297)
   Duration  5.06s (transform 1.75s, setup 0ms, collect 4.54s, tests 4.87s, environment 6ms, prepare 5.74s)
Statements   : 78.45% ( 1854/2363 )
Branches     : 95.18% ( 455/478 )
Functions    : 71.42% ( 115/161 )
Lines        : 78.45% ( 1854/2363 )
```

## 2. `pnpm --filter @rideapp/api typecheck` (tsc --noEmit, strict)

```
(no output — 0 type errors)
exit code: 0
```

## 3. `pnpm --filter @rideapp/api lint` (eslint, type-aware)

```
(no output — 0 lint errors)
exit code: 0
```

## 4. Commands that CANNOT run on this host

```
docker       NOT FOUND
flutter      NOT FOUND
dart         NOT FOUND
make         NOT FOUND
psql         NOT FOUND
redis-cli    NOT FOUND
```

Consequences, stated plainly:

- `make test` cannot be invoked (no `make`). The identical commands run as
  `pnpm test` / `pnpm lint` / `pnpm typecheck`; sections 1-3 are those runs.
- Migrations were never applied to a real Postgres. They are syntax-reviewed
  and unit-tested for ordering/safety only. **Nobody has seen them run.**
- The real-Redis half of the conformance suite skipped, so the in-memory
  Redis is UNVERIFIED against real Redis on this host.
- No Flutter code was compiled, analysed, or tested.

## 5. `git status --short`

```
?? VERIFY.md
(clean)
```

## 6. TASKS.md counts

```
[x]       : 0
[ ]       : 44
[BLOCKED] : 0
total     : 44
```
