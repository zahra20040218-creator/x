# VERIFY.md — raw machine output

Generated: 2026-08-22T21:59:24Z
Host: no Docker, no Flutter SDK, no Postgres, no Redis (see BLOCKED.md).

RUN_AUTONOMOUS.md §4: if this file and FINAL_REPORT.md disagree, THIS file
is correct. It is pasted command output, not narration.

## 1. Full suite with coverage

```
 ↓  integration  test/integration/ioredis-conformance.test.ts (1 test | 1 skipped)
 Test Files  16 passed | 1 skipped (17)
      Tests  524 passed | 1 skipped (525)
   Duration  5.88s (transform 2.10s, setup 0ms, collect 6.42s, tests 4.67s, environment 11ms, prepare 8.52s)
Statements   : 88.43% ( 3297/3728 )
Branches     : 93.22% ( 798/856 )
Functions    : 83.26% ( 199/239 )
Lines        : 88.43% ( 3297/3728 )
```

No `ERROR: Coverage ... does not meet` line above means every per-file 95%
gate on the correctness core passed (CLAUDE.md §10). Those files are:
ride-state-machine, ride-claim.service, matching.service, ledger.service,
money/iqd, fare-calculator.

## 2. Typecheck — tsc --noEmit, strict

```
(no output — 0 type errors)
exit code: 0
```

## 3. Lint — eslint, type-aware

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

- `make` is absent. The identical commands run as `pnpm test` / `pnpm lint` /
  `pnpm typecheck`; sections 1-3 are those runs.
- Migrations were NEVER applied to a real Postgres. Unit-tested for
  ordering and safety only. **Nobody has seen them run.**
- The real-Redis half of the conformance suite SKIPPED, so the in-memory
  Redis is UNVERIFIED against real Redis on this host. This is the single
  most important caveat in the repository — see DEFECTS.md D-2.
- No Flutter code exists and none was compiled, analysed, or tested.

## 5. `git status --short`

```
 M VERIFY.md
 M services/api/src/matching/matching.service.ts
 M services/api/test/fakes/fake-database.ts
 M services/api/test/unit/matching.service.test.ts
```

## 6. TASKS.md counts

```
[x]       : 15
[ ]       : 23
[BLOCKED] : 6
total     : 44
```
