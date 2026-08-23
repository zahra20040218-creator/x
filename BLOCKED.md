# BLOCKED.md

The 12 tasks that could not be **verified** on this host, with the exact
command output that blocks them.

Per `AGENT_LOOP_PROMPT.md`, a task is only `[x]` when its tests were written
**and pass**. Every task below has code written; none has running tests here.
None is marked `[x]`, regardless of how finished the code looks.

**Nothing here is blocked on failing code.** All 12 are blocked on a toolchain
that is not installed.

---

## Root cause: four toolchains are absent

```
$ for c in docker flutter dart make psql redis-cli k6; do printf "%-12s " "$c"; command -v $c >/dev/null 2>&1 && echo present || echo "NOT FOUND"; done
docker       NOT FOUND
flutter      NOT FOUND
dart         NOT FOUND
make         NOT FOUND
psql         NOT FOUND
redis-cli    NOT FOUND
k6           NOT FOUND
```

```
$ docker info
/usr/bin/bash: line 1: docker: command not found
```

This is an environment gap, not the "3 failed attempts" case from
`AGENT_LOOP_PROMPT.md`. Retrying cannot install Docker.

---

## T002, T003, T004, T005, T006 — migrations and the migration runner

**Written:** `services/api/migrations/000{1,2,3,4}_*.{up,down}.sql`,
`src/db/migrate.ts`, `src/db/migrations.ts`

**Tested statically** — 23 passing tests assert, against the actual DDL text:
- all 6 money columns are `BIGINT`, never `NUMERIC`/`REAL`/`FLOAT`
- the CLAUDE.md §3.4 composite index and the GiST index are present
- the append-only and balance triggers are present
- migration text contains no `UPDATE`/`DELETE` against an append-only table
- ordering is numeric, not lexicographic (0010 after 0009)

**Blocked:** never applied to a database. `CREATE EXTENSION postgis` in
particular is unverified — it fails on a plain `postgres:16` image and needs the
`postgis/postgis` image `infra/docker-compose.yml` specifies but which nobody
has started.

**What this means:** the schema-level guarantees this whole system leans on —
the append-only triggers, the deferred balance trigger, the partial unique
indexes that stop a second live ride — are currently **claims about a file**.

**To close:**
```bash
docker compose -f infra/docker-compose.yml up -d postgres
pnpm --filter @rideapp/api migrate:up
pnpm --filter @rideapp/api migrate:down 4
pnpm --filter @rideapp/api migrate:up
```
CI already runs exactly this sequence.

---

## T009 — PgBouncer-safe pg pool

**Written:** `services/api/src/db/pg-database.ts`

**Blocked:** cannot be exercised without a Postgres behind a PgBouncer. The
transaction-joining behaviour, the `onCommit` ordering, and the BIGINT
string-parser registration are all **unverified at runtime**.

---

## T031 — the 30s location flush job

**Written:** `services/api/src/worker.ts`

**Blocked:** the job body issues a `ST_SetSRID(ST_MakePoint(...))::geography`
multi-row INSERT that has never touched PostGIS. The Redis-side drain
(`drainFlushBuffer`) IS tested; the Postgres write is not.

---

## T036, T037, T038, T039 — the three Flutter targets

```
$ flutter --version
/usr/bin/bash: line 1: flutter: command not found
```

**Written:** `packages/core` (models, API client, design system, localisation,
location buffer), `apps/rider`, `apps/driver` including the §5.3 foreground
location service and the Android manifest.

**Blocked:** no Flutter or Dart SDK. `flutter test`, `flutter analyze` and
`flutter build apk` cannot run. CLAUDE.md §10 states a task is not complete
until `flutter test` passes, so no Flutter task can be `[x]` here.

**T039 deserves specific mention.** CLAUDE.md §5.3 calls background location
"the single most common cause of ride-hailing MVP failure in production", and
`RUN_AUTONOMOUS.md` §5 predicts it "will be done in theory and fail on a real
phone". Both are right. Every requirement §5.3 lists is implemented —
foreground service, Doze exemption with an explanatory screen, offline buffer,
no WorkManager — and **none of that is sufficient**. MIUI, One UI, EMUI and
ColorOS each add their own process killer, and they differ from each other and
from the emulator.

`ACCEPTANCE_CHECKLIST.md` check 2 — twenty minutes of real driving with the
screen off, repeated on a Xiaomi and a Samsung — is the only test that means
anything for it.

**To close:**
```bash
cd packages/core && flutter pub get && flutter analyze && flutter test
cd apps/driver  && flutter pub get && flutter analyze && flutter test
cd apps/rider   && flutter pub get && flutter analyze && flutter test
```

---

## T043 — load test at 500 concurrent users

**Written:** `services/api/test/load/matching.load.js` (k6)

**Blocked:** no k6, no running server. The thresholds — `double_accepts` and
`duplicate_rides_created` both `count==0`, accept p95 under 1s, location ingest
p95 under 200ms — are **targets derived from CLAUDE.md, not observations**.

**Also worth saying:** even once run, this measures the API. It says nothing
about whether a 4-core VPS holds 500 users, because that depends on the VPS.

---

## The real-Redis conformance run — not a task, but the most important gap

```
$ npx vitest run --project integration
 ↓  integration  test/integration/ioredis-conformance.test.ts (1 test | 1 skipped)
 Test Files  1 skipped (1)
      Tests  1 skipped (1)
```

`src/redis/in-memory-redis.test.ts` runs 46 conformance assertions against the
in-memory implementation and they pass. The **identical** assertions are meant
to run against a real Redis via `TEST_REDIS_URL`, and did not.

This is DEFECTS.md D-2, the one P0-class risk in the repository.

**To close:**
```bash
docker compose -f infra/docker-compose.yml up -d redis
TEST_REDIS_URL=redis://localhost:6379 pnpm --filter @rideapp/api test:integration
```

Expected: a suite named `IoRedisAdapter (real Redis)` runs and passes. If it
says `skipped`, nothing has changed.

CI sets `TEST_REDIS_URL` **and fails the build if the suite skips**, so this
closes automatically the first time CI runs.
