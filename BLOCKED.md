# BLOCKED.md

Tasks that could not be completed or verified on this host, with the exact
command output that blocks them. Nothing here is an opinion.

Per `AGENT_LOOP_PROMPT.md`, a task is only `[x]` when its tests were written
**and pass**. None of the tasks below can have their tests run here, so none of
them are marked done — regardless of how finished the code looks.

---

## Root cause: three toolchains are absent

```
$ for c in docker flutter dart make psql redis-cli; do printf "%-12s " "$c"; command -v $c >/dev/null 2>&1 && echo present || echo "NOT FOUND"; done
docker       NOT FOUND
flutter      NOT FOUND
dart         NOT FOUND
make         NOT FOUND
psql         NOT FOUND
redis-cli    NOT FOUND
```

```
$ docker info
/usr/bin/bash: line 1: docker: command not found
```

This is an environment gap, not a code defect, and it is **not** the "3 failed
attempts" case from `AGENT_LOOP_PROMPT.md` — retrying cannot install Docker.

---

## T002 — migration runner

**Written:** `services/api/src/db/migrate.ts`, `services/api/src/db/migrations.ts`

**Tested:** ordering, up/down pairing, and the safety checks — 23 tests in
`src/db/migrations.test.ts`, all passing.

**Blocked:** the task requires "a fresh-DB test". Applying migrations needs a
Postgres. There is none.

**What this means for the product:** the migration *files* have never been
executed. A syntax error, a bad constraint, or a PostGIS incompatibility would
not have been caught. `make migrate` is unproven.

---

## T003, T004, T005, T006 — the four migrations

**Written:** `services/api/migrations/000{1,2,3,4}_*.{up,down}.sql`

**Tested only statically:**
- money columns are `BIGINT`, never `NUMERIC`/`REAL`/`FLOAT` — asserted against
  the actual DDL text (6 columns found and checked)
- the CLAUDE.md §3.4 composite index and the GiST index are present
- the append-only and balance triggers are present
- migration text contains no `UPDATE`/`DELETE` against an append-only table

**Blocked:** never applied. `CREATE EXTENSION postgis` in particular is
unverified — it fails on a plain `postgres:16` image and needs the
`postgis/postgis` image that `infra/docker-compose.yml` specifies but which
nobody has started.

---

## T009 — PgBouncer-safe pg pool

**Written:** `services/api/src/db/pg-database.ts`

**Blocked:** it cannot be exercised without a Postgres behind a PgBouncer. The
transaction-joining behaviour, the `onCommit` ordering, and the BIGINT
string-parser registration are all **unverified at runtime**.

---

## The real-Redis half of the conformance suite

```
$ npx vitest run --project integration
 ↓  integration  test/integration/ioredis-conformance.test.ts (1 test | 1 skipped)
 Test Files  1 skipped (1)
      Tests  1 skipped (1)
```

`src/redis/in-memory-redis.test.ts` runs 40 conformance assertions against the
in-memory implementation and they pass. The identical assertions are meant to
run against a real Redis via `TEST_REDIS_URL`, and did not.

**This is the single most important caveat in the whole repository.** Every
claim about the atomic claim (CLAUDE.md §5.1) — including "exactly one of fifty
concurrent drivers wins" — was proved against a fake Redis written in the same
session as the code it verifies. The fake was built to match Redis semantics and
the conformance suite exists precisely to detect divergence, but on this host
**that check did not run.**

**To close it:** start Redis, then

```bash
TEST_REDIS_URL=redis://localhost:6379 pnpm --filter @rideapp/api test:integration
```

Until that passes, treat the concurrency guarantees as designed-and-unit-tested,
not as verified.

---

## T036–T039 — the three Flutter targets

```
$ flutter --version
/usr/bin/bash: line 1: flutter: command not found
```

No Flutter or Dart SDK. `flutter test`, `flutter analyze`, and `flutter build
apk` cannot run. CLAUDE.md §10 states a task is not complete until
`flutter test` passes, so no Flutter task can be marked done here.

**T039 (background location) deserves specific mention.** CLAUDE.md §5.3 calls
it "the single most common cause of ride-hailing MVP failure in production", and
`RUN_AUTONOMOUS.md` §5 predicts it "will be done in theory and fail on a real
phone". Both are right: it cannot be validated without a physical Android
device, and `ACCEPTANCE_CHECKLIST.md` check 2 — 20 minutes of driving with the
screen off, repeated on Xiaomi and Samsung — is the only test that means
anything for it.

---

## Not blocked — simply not built yet

These are `[ ]` in `TASKS.md`, not `[BLOCKED]`. There is no environmental
obstacle; the session ended with them unwritten. Listing them here so the two
categories are not confused:

T007 (config/logger tests), T008 (Zod pipe + exception filter), T013 (platform
config service), T015/T017/T018 (Firebase verifier, JWT, guards), T021/T025/T026/T033
(ride HTTP endpoints), T022/T024 (driver presence and the offer worker),
T027/T028 (payment provider + webhook), T029 (BullMQ), T030/T031 (location
ingest and flush), T032 (WebSocket gateway), T034/T035 (admin API), T040 (admin
web), T041 (CI), T042 (e2e), T043 (load test), T044 (security audit).
