# FINAL REPORT

**Date:** 2026-08-23 (third pass) · Every number below is counted
from `docs/COMPLETION_MATRIX.md` or read from a command's output. None are
estimated.

---

## FINAL STATUS

**NOT PRODUCTION READY.** The backend is built, compiles clean, and genuinely
runs — but it has never once been executed against a real PostgreSQL or a real
Redis, and the mobile apps have never been compiled at all.

---

## DONE: 33
## PARTIAL: 12
## BLOCKED: 13
## FAILED: 0

Counted by machine from the 58 rows of `docs/COMPLETION_MATRIX.md`, not by
hand. **Both earlier totals in this file (30/13/17 and 32/16/16) were wrong** —
hand-arithmetic that did not match the file. Corrected.

**Nothing moved from BLOCKED to DONE because code appeared.** The stack
conflict closed because the **owner decided it**, which was the dependency it
was blocked on. Every environment blocker was re-checked by running the
commands this session and every one is still present.

Session revocation and rate limiting are `PARTIAL`, not `DONE`, even though
both are implemented, mutation-tested, and proved over HTTP: migration 0006 has
never been applied to a real PostgreSQL and no counter has ever run against a
real Redis.

---

## REAL INFRASTRUCTURE: **BLOCKED**

Re-checked by running the commands, not by reading a prior report:

```
docker --version   -> command not found
psql / pg_isready  -> NOT FOUND
redis-cli          -> NOT FOUND
k6 / flutter / dart / gradle -> NOT FOUND
netstat :5432 :6432 :6379    -> nothing listening
adb devices        -> daemon started; list empty
```

## REAL DATABASE: **BLOCKED**
5 up + 5 down migrations exist and are statically checked. **Never executed.**
The append-only ledger trigger and the balanced-entry deferred constraint are
written and have never run. Postgres-level guarantees are unproven.

## REAL REDIS: **BLOCKED — this is the one P0**
`DEFECTS.md D-2` remains **UNRESOLVED**. The atomic claim
`SET ride:{id}:claim {driverId} NX PX 30000` is proved only against my own
in-memory fake. That fake has already diverged from real Redis once in this
project — `DEL` failed to remove hash keys, which would have left an offline
driver visible. The conformance suite that would catch the next divergence
exists and **skips**, loudly, with no real Redis to run against.

**Consequence if it diverges again: two drivers accept the same ride.**

## REAL HTTP: **PASS**
A freshly built binary answered real requests. Verified the responding process
was the new one by matching the PID in the boot log (`16224`) against the PID
holding the socket — an earlier proof in this project was invalid because a
stale process held the port.

| Request | Result |
|---|---|
| `GET /v1/health` | 200 `{"status":"ok"}` |
| `GET /v1/health/ready` | **503** `postgres:fail, redis:fail` |
| `GET /v1/me` no token | 401 RFC 9457 |
| `alg:none` forged JWT on an admin route | **401** |
| bad body | 422 problem+json, per-field paths |

## REAL E2E: **PARTIAL**
38 end-to-end tests run over real HTTP through the real Nest stack — real
routing, guards, validation, serialisation. **Against in-memory Postgres and
Redis fakes.** So the wiring is proved and the storage semantics are not.

## LOAD TEST: **BLOCKED**
`test/load/matching.load.js` is written with `double_accepts == 0` and
`duplicate_rides_created == 0` as hard thresholds. k6 is not installed; it has
never run. The 500-concurrent / p95 < 200ms target is **unmeasured**. Even once
run here it would say nothing about a 4-core VPS.

## SECURITY: **PASS with one open item** (was two)

Verified live, not asserted: CSP `default-src 'none'`, HSTS 180d, `X-Frame-Options: DENY`,
nosniff, `Referrer-Policy: no-referrer`, `x-powered-by` count **0**.
CORS proved in three directions — allowed origin echoed, disallowed origin gets
no ACAO, and `CORS_ALLOWED_ORIGINS="*"` **refuses to boot**.
SQL injection re-audited line by line across all 3 interpolation sites: every
interpolated value is a string literal in source; 97 `$n` placeholders, zero
interpolated user input. IDOR returns **404, not 403**. PII scrubbed before the
audit-log DB write. 0 phone numbers in the live log.

**S-7 closed.** Rate limiting no longer fails open on endpoints that matter.
The failure policy is now per-endpoint by risk tier; verified on the compiled
binary with no Redis: `/auth/otp/verify` allowed 3 then returned 429 instead of
being unlimited. Health probes are exempt entirely — 400 live requests, 0
non-200 — because a 429 on a liveness probe makes a load balancer eject a
healthy instance.

**S-3 closed, and corrected.** The finding was written too broadly: account
deactivation *always* revoked immediately, because the guard reloads the user
from the database on every request. The real gap — logout leaving the access
token alive for up to an hour — is closed by migration 0006. Proved by
disabling the check and watching the original bug return as `expected 401, got
200`.

**Still open: D-13 (P2).** A driver who goes OFFLINE while holding an offer can
still accept it, after their Redis presence has been deleted — so the rider
gets an assigned driver with no location. Found while auditing, recorded with a
characterisation test, deliberately not fixed in this pass.

## ANDROID REAL DEVICE: **BLOCKED**
`adb` is present, **zero devices attached**. The 20-minute screen-off driving
test on a Xiaomi and a Samsung has not happened. Automated buffer/sampling logic
passes; **the field test is not claimed to pass.** MIUI/One UI process killers
have no emulator substitute, and `CLAUDE.md` §5.3 calls this the single most
common cause of ride-hailing MVP death in production.

## STACK CONFLICT: **RESOLVED — OWNER DECIDED**
**Keep the existing stack.** Flutter, Refine, NestJS, raw `pg`. No migration.
The brief's Kotlin/Next.js/Prisma requirement is recorded as a documented
conflict and is not being acted on (DECISIONS.md D-013).

**This unblocked nothing by itself** — the apps still have never been compiled,
because that depends on the Flutter SDK, not on the stack question.

## SCOPE CONFLICT: **SCOPE DECISION PENDING**
KYC, driver approval, surge, zones, promotions: required by brief §15–16,
forbidden by `CLAUDE.md` §2. Owner deferred the decision (DECISIONS.md D-014).
Neither built nor deleted, and `CLAUDE.md` was not edited to make the conflict
disappear.

## PRODUCTION READY: **NO**

Not "close to production ready." The precise truth: a backend that compiles,
lints, passes 694 tests, boots, serves correct HTTP, degrades gracefully, and
now survives a Redis outage without dropping its guard on the endpoints that
matter — whose money, matching, and state-machine guarantees have still never
touched the databases they depend on, and whose two client apps have still
never been compiled.

The gap between this and production is not more code. It is Docker.

---

## EXACT REMAINING BLOCKERS

| # | Blocker | Needs | Unblocks |
|---|---|---|---|
| 1 | ~~Stack conflict~~ | **DECIDED — keep existing stack** | — |
| 2 | **Scope conflict** | **your decision, deferred** | KYC, surge, zones, promos |
| 3 | Docker not installed | Docker Desktop | migrations, PgBouncer, **the P0 real-Redis run**, workers, integration tests |
| 4 | Flutter SDK not installed | Flutter 3.24+ | 25 Dart files never compiled — **expect first-run compile errors** |
| 5 | No Android device | a real Xiaomi + Samsung | the §5.3 background-location field test |
| 6 | Third-party credentials | Firebase, Maps, FCM, keystore, Play | OTP, maps, push, signed build |
| 7 | k6 not installed | k6 | the 500-user load target |

**Order that matters: 3 first.** It closes the only P0 and the largest share of
`BLOCKED` rows.

## Reproduce every claim here

```bash
cd services/api && rm -rf dist && npx tsc --noEmit && npx eslint "src/**/*.ts" "test/**/*.ts" \
  && npx tsc -p tsconfig.build.json && npx vitest run
cd apps/admin && npx vitest run
```
Full evidence with raw output: `VERIFY.md`, `docs/COMPLETION_MATRIX.md`,
`docs/BLOCKERS.md`, `docs/security-audit.md`, `docs/UI_STATE_MATRIX.md`, `DEFECTS.md`.
