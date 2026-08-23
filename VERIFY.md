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

---

# CLEAN-FROM-ZERO VERIFICATION — 2026-08-23

`dist/` was deleted first, so nothing below reuses an earlier build.

```
$ rm -rf dist && ls dist
ls: cannot access 'dist': No such file or directory

$ npx tsc --noEmit                              TYPECHECK_EXIT=0
$ npx eslint "src/**/*.ts" "test/**/*.ts"       LINT_EXIT=0
$ npx tsc -p tsconfig.build.json                BUILD_EXIT=0   -> dist/main.js exists
$ npx vitest run                                21 files, 643 passed, 0 skipped
$ cd apps/admin && npx vitest run               11 passed
```

## The binary that answered was the one just built

An earlier rate-limit "proof" in this project was **invalid** because a stale
process still held the port, so the requests hit an older binary. The port is
now checked before and the owning PID after:

```
$ netstat -ano | grep ":4811"          (empty -> free)
$ node dist/main.js &
   boot log:  {"event":"api.started","pid":16224,"port":4811}
$ netstat -ano | grep ":4811.*LISTENING"
   TCP 0.0.0.0:4811 ... LISTENING 16224
$ Get-CimInstance Win32_Process -Filter "ProcessId=16224" | % CommandLine
   "C:\Program Files\nodejs\node.exe" dist/main.js
```

**PID in the log == PID holding the socket.** Same for the second run (21784 on
4812). Both were killed afterwards and the ports released.

## Live responses from that binary

| Request | Result |
|---|---|
| `GET /v1/health` | **200** `{"status":"ok"}` |
| `GET /v1/health/ready` (no PG, no Redis) | **503** `{"status":"degraded","checks":{"postgres":"fail","redis":"fail"}}` |
| `GET /v1/me` no token | **401** RFC 9457 with `requestId` |
| `GET /v1/admin/drivers` with `alg:none` forged JWT | **401** — the unsigned-token attack fails on the running server |
| `POST /v1/auth/otp/verify` bad body | **422** problem+json with per-field `path` |

## Security headers — on the live response, not asserted in a test

```
Content-Security-Policy: default-src 'none';frame-ancestors 'none';base-uri 'self';object-src 'none';...
Strict-Transport-Security: max-age=15552000; includeSubDomains
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Resource-Policy: same-site
x-powered-by count: 0
```

## CORS — allowlist proved in all three directions

| Case | Result |
|---|---|
| `Origin: https://admin.example.com` (allowed) | `Access-Control-Allow-Origin: https://admin.example.com` + `Allow-Credentials: true` |
| `Origin: https://evil.example.com` | **no ACAO header** — browser blocks |
| Preflight `OPTIONS` from evil origin | 204 **with no ACAO** — 204 alone is not a pass; the missing header is what blocks it |
| `CORS_ALLOWED_ORIGINS="*"` | **process refuses to boot**: `ConfigError: CORS_ALLOWED_ORIGINS must not contain "*"` |

**A mistake worth recording:** the first CORS run showed no ACAO on the *allowed*
origin too. That was my error, not the code's — I passed `CORS_ORIGINS` when the
variable is `CORS_ALLOWED_ORIGINS`, so the allowlist was empty and CORS was never
enabled. Re-running with the correct name passed. Noted because the first result
looked like a defect and reporting it as one would have been wrong.

## PII in the live log

```
$ grep -cE "\+?964[0-9]{9}" /tmp/clean_boot.log
0
```

## What this run does NOT prove

Still no Postgres, no Redis, no Docker, no Flutter, no device, no k6. Readiness
returning 503 above **is** the evidence that both datastores were absent. Every
`PARTIAL` and `BLOCKED` in `docs/COMPLETION_MATRIX.md` remains exactly as it was.

---

# PHASES 5 & 6 VERIFICATION — 2026-08-23

## Environment re-checked first (not assumed)

```
docker / psql / pg_isready / redis-cli / redis-server / k6 / flutter / dart / gradle
  -> ALL NOT FOUND
netstat :5432 :6432 :6379 -> nothing listening
adb devices -> daemon running, list EMPTY
```

Unchanged. Phases 3, 4, 7, 9, 10 and 11 of the brief remain unreachable.

## Gates

```
$ npx tsc --noEmit                              TYPECHECK=0
$ npx eslint "src/**/*.ts" "test/**/*.ts"       LINT=0
$ npx tsc -p tsconfig.build.json                BUILD=0
$ npx vitest run                                22 files, 683 passed, 0 skipped
$ cd apps/admin && npx vitest run               11 passed
```

Up from 643. **No test was deleted or skipped to get there.**

## The two mutation tests that make the rest of it mean something

A passing test proves nothing unless it can fail. Both new mechanisms were
broken on purpose and the suite was watched to catch it.

**Rate limiting** — reverted `CRITICAL` to the old blanket fail-open:

```
× a CRITICAL endpoint does NOT become unlimited
  → expected 30 to be 3
× records the degraded decision so an outage is visible in logs
× refuses rather than waves through once the fallback table saturates
```

**Session revocation** — disabled the liveness check, reproducing pre-0006:

```
× logout invalidates the access token immediately, not in an hour
  → expected 401 "Unauthorized", got 200 "OK"
× revokes every device, not just the one that called logout
× logout after a rotation still kills the whole session
```

Note which tests **kept passing** under that second mutation: *"deactivating
the account cuts a live session off"* and *"survives refresh rotation"*. That
is the evidence for the claim that account deactivation never depended on the
new code — and it is why the S-3 finding was corrected rather than simply
marked fixed.

Both mutations were reverted and the suite re-run green.

## Live, on the compiled binary, with no Redis and no Postgres

PID checked both ways again: boot log `pid: 23604, port: 4901`, and
`netstat` shows 23604 owning 4901.

**A CRITICAL endpoint no longer becomes unlimited when Redis is gone:**

```
$ curl -X POST /v1/auth/otp/verify   (×6)
req 1 -> 401     req 4 -> 429
req 2 -> 401     req 5 -> 429
req 3 -> 401     req 6 -> 429
```

401 means the limiter *allowed* it and auth rejected the fake token. Three
allowed, then refused — `ceil(10/4)`. Under the previous policy all six, and
the six-hundredth, would have been allowed.

Log decisions: `degraded 3 · rejected 3 · allowed 0 · local_saturated 0`.

**Health probes are exempt:**

```
$ 400 consecutive GET /v1/health
non-200 responses: 0
ratelimit events logged for GET:/v1/health: 0
```

Zero events means it was exempted before any counting. Without the exemption
the degrade policy would have cut health to 75/min per instance and rejected
roughly 325 of those 400.

## An invalid check I ran, and am not counting

I also fired 200 requests at `GET /v1/driver/offers/current` (OPERATIONAL) with
a junk bearer token and recorded 0 × 429. **That proves nothing.**
`main.ts:122` runs `AuthGuard` before `RateLimitGuard`, so those requests were
rejected 401 by auth and never reached the limiter at all — confirmed by
`decision: allowed` appearing **0** times in the log.

The OPERATIONAL-stays-open claim rests on the e2e test *"keeps an operational
endpoint open when Redis dies"*, which holds a real session, not on that run.

Recorded because the result looked like confirmation and would have been
reported as such.

## What none of this proves

No PostgreSQL, no Redis, no Docker, no Flutter, no device, no k6. Migration
0006 has never been applied to a real database: `session_id` and the partial
index that serves the per-request liveness check exist only as SQL text and in
the fake. Every rate-limit count was produced by the in-memory Redis fake.

---

# REAL POSTGRESQL — 2026-08-23

**Achieved without administrator rights, without Docker, and without restarting
the machine.** Docker was installed but needs a reboot to start its engine; the
disk was also 100% full. Neither turned out to be a hard blocker for PostgreSQL.

## How

```
pnpm store prune                       # 2.6 GB -> 6.5 GB free
PostgreSQL 17.11 binaries (EnterpriseDB ZIP, no installer, no service)
PostGIS 3.6.2 bundle (OSGeo), added with cp -n so nothing EDB shipped is overwritten
initdb -D data -U postgres -A trust
pg_ctl start -o "-p 5433 -c listen_addresses=127.0.0.1"
```

## Migrations — executed for the first time

```
$ node dist/db/migrate.js up
  applying 0001_identity ... ok      applying 0004_operations ... ok
  applying 0002_rides ... ok         applying 0005_audit_log ... ok
  applying 0003_ledger ... ok        applying 0006_sessions ... ok
Done: 6 migration(s) applied.

$ node dist/db/migrate.js down 6     # all six reverted, 2 tables left
$ node dist/db/migrate.js up         # clean re-apply
```

**Two defects were found in the first minute of doing this** — see D-17 and
D-18. `migrate:up` had never been runnable, and the compiled path exited **0
while applying nothing**.

## Results — 16 integration tests against real PostgreSQL

```
[REAL_INFRA=on] postgres=REAL redis=FAKE

✓ transaction isolation > keeps a committed write when concurrent transactions roll back
✓ transaction isolation > rolls back only the failing transaction
✓ concurrent acceptance > lets exactly one of twenty real concurrent transactions accept
✓ concurrent acceptance > enforces one active ride per driver at the index level
✓ ledger > is append-only: UPDATE is refused by the trigger
✓ ledger > is append-only: DELETE is refused by the trigger
✓ money columns > are BIGINT in every table that stores money
✓ money columns > returns wallet balances as strings, which the code must parse
✓ money columns > rejects a phone number that is not E.164 Iraqi
✓ sessions (migration 0006) > has the session_id column and its partial index

Tests  16 passed (16)
```

**D-15 is closed.** The fake erased a committed write when concurrent
transactions rolled back; real PostgreSQL keeps it. That divergence was real,
and the guarantee now rests on the real thing.

**D-2's Postgres half is closed.** Twenty real concurrent transactions ran the
production guard `UPDATE ... WHERE status = 'OFFERED'`; exactly one matched a
row. The `rides_one_active_per_driver_uq` backstop fires as designed. **The
Redis half remains open** — Redis has no official Windows build.

## Four failures on the first run, all mine

Recorded because "the tests failed" is the interesting part:

| Failure | Cause |
|---|---|
| `rides_one_active_per_rider_uq` violated | My test made two rides for one rider. There is a per-rider constraint the fake never enforced |
| `rides_completed_has_fare` violated (×2) | My test created COMPLETED rides with no fare. A real CHECK rejects that |
| `expected 'numeric' to be 'bigint'` | My assertion matched a **view** column. `driver_wallet_balances.balance_iqd` is `numeric` because `SUM(bigint)` is numeric in PostgreSQL — not a §6.1 violation, and nothing is stored as numeric |

**None was a product defect.** The last one did surface something worth having:
node-postgres returns `numeric` and `bigint` as **strings**, while the fake
returns JS numbers. The production code already handles this correctly
(`parseSignedIqdFromDb`, `Number(row.balance_iqd)`) — but nothing had ever
proved it, so there is now a test that does.

## Full suite

```
$ REAL_INFRA=1 TEST_DATABASE_URL=... npx vitest run
  Test Files  24 passed (24)
       Tests  702 passed (702)      # 0 skipped
$ npx tsc --noEmit    -> 0
$ npx eslint          -> 0
```

## Restarting this environment later

```bash
/c/Users/moaay/pg17/pgsql/bin/pg_ctl.exe \
  -D /c/Users/moaay/pg17/data -l /c/Users/moaay/pg17/pg.log \
  -o "-p 5433 -c listen_addresses=127.0.0.1" start
```
Stop with `pg_ctl -D ... stop -m fast`. Delete `C:\Users\moaay\pg17` to remove
it entirely — it is a plain directory, not a Windows service.

## What this run does NOT prove

Redis is still a fake in every test. The API has never been run as more than
one instance. No load test. The mobile apps still cannot be built. `REAL_INFRA`
runs print `redis=FAKE` precisely so this cannot be misread later.
