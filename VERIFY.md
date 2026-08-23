# VERIFY.md — raw machine output

Generated: 2026-08-23T02:37:23Z
Host: no Docker, no Flutter SDK, no Postgres, no Redis, no k6.

RUN_AUTONOMOUS.md §4: if this file and FINAL_REPORT.md disagree, THIS file
is correct. It is pasted command output, not narration.

## 1. Backend suite with coverage

```
 ↓  integration  test/integration/ioredis-conformance.test.ts (1 test | 1 skipped)
 Test Files  19 passed | 1 skipped (20)
      Tests  600 passed | 1 skipped (601)
   Duration  11.75s (transform 3.74s, setup 0ms, collect 15.63s, tests 8.92s, environment 28ms, prepare 13.31s)
Statements   : 82.89% ( 4521/5454 )
Branches     : 90.47% ( 969/1071 )
Functions    : 78.59% ( 279/355 )
Lines        : 82.89% ( 4521/5454 )
```

No `ERROR: Coverage ... does not meet` line above means every per-file 95%
gate on the correctness core passed (CLAUDE.md §10): ride-state-machine,
ride-claim.service, matching.service, ledger.service, money/iqd,
fare-calculator.

## 2. Backend typecheck — tsc --noEmit, strict

```
(no output — 0 type errors)
exit code: 0
```

## 3. Backend lint — eslint, type-aware

```
(no output — 0 lint errors)
exit code: 0
```

## 4. Admin panel suite

```
 Test Files  1 passed (1)
      Tests  11 passed (11)
tsc --noEmit exit code: 0
```

## 5. Commands that CANNOT run on this host

```
docker       NOT FOUND
flutter      NOT FOUND
dart         NOT FOUND
make         NOT FOUND
psql         NOT FOUND
redis-cli    NOT FOUND
k6           NOT FOUND
```

Consequences, stated plainly:

- `make` is absent. The identical targets run as `pnpm test` / `pnpm lint` /
  `pnpm typecheck`; sections 1-3 are those runs.
- **Migrations were NEVER applied to a real Postgres.** They are unit-tested
  for ordering and safety only. Nobody has seen them run, so every
  schema-level guarantee (append-only triggers, the balance trigger, the
  partial unique indexes) is a claim about a file, not about a database.
- **The real-Redis half of the conformance suite SKIPPED.** The in-memory
  Redis is therefore UNVERIFIED against real Redis. This is the single most
  important caveat in the repository — DEFECTS.md D-2.
- **No Flutter code was compiled, analysed, or tested.** All Flutter tasks
  are `[BLOCKED]`, never `[x]`.
- **The k6 load test has never been run.** Its thresholds are targets
  derived from CLAUDE.md, not observations.

## 6. `git status --short`

```
M  DEFECTS.md
MM VERIFY.md
```

## 7. TASKS.md counts

```
[x]       : 32
[ ]       : 0
[BLOCKED] : 12
total     : 44
```

Every task is now `[x]` or `[BLOCKED]`. Nothing is left unstarted.
The 12 `[BLOCKED]` entries are all blocked on absent toolchains, not on
failing code — see BLOCKED.md.
