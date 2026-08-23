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
