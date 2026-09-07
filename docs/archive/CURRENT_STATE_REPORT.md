# CURRENT_STATE_REPORT.md

Audit of the repository **as it actually exists**, performed before modifying
anything. Nothing here is taken from prior messages, prior reports, file names,
or comments. Every row is backed by a command that was run and whose output is
quoted.

**Audit date:** 2026-08-23
**Method:** static scans + real build + real process start + real HTTP requests.

---

## 0. STOP — a conflict that must be resolved by the owner

The continuation brief specifies a **different technology stack** from the one
in `CLAUDE.md`, which is the project's binding constitution and which states
(§0): *"If a user request in a session conflicts with a rule in this file, stop
and say so before writing code. Do not silently comply."*

| Layer | `CLAUDE.md` §1 (binding) | Continuation brief §5 | What exists on disk |
|---|---|---|---|
| Mobile | **Flutter / Dart** | **Kotlin / Jetpack Compose** | Flutter — 25 `.dart` files, **0** `.kt` files |
| Admin | **Refine (React)** | **Next.js App Router** | Refine + Vite |
| DB access | (unspecified) | **Prisma or TypeORM** | Raw `pg` + hand-written SQL |

**Evidence:**
```
$ find apps packages -name "*.kt" -o -name "build.gradle*" | wc -l
0
$ find apps packages -name "*.dart" | wc -l
25
$ grep -oE '"(next|@refinedev/core|vite)"' apps/admin/package.json | sort -u
"@refinedev/core"
"vite"
$ grep -rniE "prisma|typeorm" services/api/package.json | wc -l
0
```

**This is a commercial decision, not an engineering one.** Rewriting two mobile
apps from Flutter to Kotlin/Compose is weeks of work that discards working
code, and it contradicts a document the brief itself tells me to treat as
binding. Per the brief's own rule — *"لا تسأل عن قرار تقني إلا إذا كان القرار
تجارياً أو يتطلب اختياراً من المالك"* — this is exactly the case that must be
escalated.

**Recorded in `docs/BLOCKERS.md` as BLOCKER-1. Work continues on everything
that is stack-independent.**

The same applies to scope: the brief §15/§16 requires **KYC/documents, surge,
zones, promotions**. `CLAUDE.md` §2 lists all four as explicitly **OUT OF
SCOPE**, and §12.7 forbids scaffolding them. Recorded as BLOCKER-2.

---

## 1. Verified working — with reproducible evidence

### The backend builds and runs

```
$ npx tsc -p tsconfig.build.json
build exit: 0

$ node dist/main.js
{"event":"api.started","port":3999,"msg":"api listening"}
$ grep -c "Mapped {" server.log
36
```

**36 routes mapped.** The process starts, binds a port, and serves traffic:

```
$ curl -s http://localhost:3999/v1/health
{"status":"ok"}                                          HTTP 200

$ curl -s http://localhost:3999/v1/me
{"type":"https://api.rideapp.iq/problems/unauthorized",
 "title":"Unauthorized","status":401,
 "detail":"A bearer token is required.",
 "instance":"/v1/me",
 "requestId":"5d04737d-0fbf-454d-aae0-c17822c58588"}      HTTP 401

$ curl -s http://localhost:3999/v1/health/ready
{"status":"degraded","checks":{"postgres":"fail","redis":"fail"}}  HTTP 503
```

That third response is worth naming: with **no Postgres and no Redis running**,
the API starts anyway, serves liveness, refuses unauthenticated requests
correctly, and reports readiness as `degraded` with a 503 — rather than
crashing. That is the graceful degradation the brief §22 asks for, demonstrated
rather than asserted.

### Test suites

| Suite | Command | Result |
|---|---|---|
| Backend unit + e2e | `npx vitest run` | **600 passed, 1 skipped** |
| Admin | `npx vitest run` | **11 passed** |
| Backend types | `npx tsc --noEmit` | **0 errors** |
| Backend lint | `npx eslint src test` | **0 errors** |
| Admin types | `npx tsc --noEmit` | **0 errors** |
| Coverage gates | `npx vitest run --coverage` | **no threshold failures** |

The 1 skipped test is the real-Redis conformance suite, which self-skips when
`TEST_REDIS_URL` is unset. That skip is the single most important gap in the
repository — see §3.

### Forbidden-marker scan — clean

```
TODO             0 real   (12 hits were all `toDouble()` false positives)
FIXME            0
hardcoded        0
placeholder      1        (a documented map-picker surface, not a code stub)
not implemented  3        (all intentional: the GatewayProvider stub CLAUDE.md §7 mandates)
```

No mock, fake, or stub sits in a production path. The `return null` / `return []`
hits are guard clauses in parsers and lookups, not unimplemented functions —
verified by reading each of the 14 occurrences.

---

## 2. Component-by-component

| Component | State | Implemented | Missing / Broken | Evidence | Required action |
|---|---|---|---|---|---|
| **Backend — money** | DONE | Branded whole-IQD type, integer-only bps, 6 BIGINT columns asserted against DDL | — | 59 tests | none |
| **Backend — ledger** | DONE | Double-entry, append-only, derived balances, reconciliation query | DB triggers never executed | 33 tests | run migrations |
| **Backend — state machine** | DONE | 16-rule table, actor auth inside transition, all 121 pairs tested | — | 28 tests | none |
| **Backend — atomic claim** | DONE (unverified) | `SET NX PX`, compare-and-delete release, rollback on failure | **fake Redis unverified** | 27 tests | run real-Redis suite |
| **Backend — matching** | DONE | Nearest-eligible, one-at-a-time offers, timeout chain, sweeper | — | 28 tests | none |
| **Backend — idempotency** | DONE | Replay, body-mismatch 409, concurrent-retry, failure release | response stored outside tx (P2) | 24 tests | see D-4 |
| **Backend — auth** | DONE | Firebase verify, JWT, refresh rotation, hashed storage | **no rate limiting** | 40 tests | **implement** |
| **Backend — HTTP** | DONE | 36 routes, Zod at every boundary, RFC 9457, guards | **no rate limiting** | 26 e2e | **implement** |
| **Backend — realtime** | PARTIAL | WS gateway, token-derived channels, no client-named channel | **no automated test** | code review only | add test |
| **Backend — queues** | PARTIAL | BullMQ wiring, 4 recurring jobs, separate worker process | **never run**; FCM send is a stub | code review only | needs Redis |
| **Backend — DB layer** | BLOCKED | PgBouncer pool, tx helper, `onCommit` | **never executed** | — | needs Postgres |
| **Migrations** | BLOCKED | 4 forward + 4 down, triggers, indexes | **never applied** | 23 static tests | needs Postgres |
| **Admin panel** | PARTIAL | Data provider, money formatter, contract-path mapping | **no UI screens**; no audit log | 11 tests | build screens |
| **Flutter core** | BLOCKED | Models, API client, design system, l10n, location buffer | **never compiled** | — | needs Flutter |
| **Rider app** | BLOCKED | Auth, request, track, rate | **never compiled**; map picker is a surface | — | needs Flutter |
| **Driver app** | BLOCKED | Auth, online toggle, offer sheet, trip, §5.3 location service | **never compiled** | — | needs Flutter + device |
| **Load test** | BLOCKED | k6 script with hard thresholds | **never run** | — | needs k6 + server |
| **CI** | PARTIAL | Full workflow incl. real-Redis skip-detector | **never executed** | — | needs a push |

---

## 3. The highest-risk incomplete items, ranked

### RISK-1 · The atomic claim is proved against a fake Redis · **P0-class**

Every guarantee about CLAUDE.md §5.1 rests on an in-memory Redis written in the
same session as the code it verifies. The conformance suite that would catch a
divergence **skipped**:

```
↓ integration test/integration/ioredis-conformance.test.ts (1 test | 1 skipped)
```

A divergence would break double-accept protection **while the tests stay
green**. This is not hypothetical: one divergence has already been caught and
fixed (`DEL` only removed string keys).

**Blocked on Docker.** Four independent layers sit beneath Redis, so a
divergence must defeat all four to cause a double dispatch.

### RISK-2 · No rate limiting anywhere · **P1, and FIXABLE NOW**

```
$ grep -rniE "throttle|rate.?limit" services/api/src | grep -v .test. | wc -l
0
```

`POST /v1/auth/otp/verify` can be called in an unbounded loop. Each call costs a
real Firebase verification, and the endpoint is unauthenticated by necessity.
The brief §6 requires rate limiting on **every** endpoint and §23 names
"rate-limit bypass" and "OTP abuse" as required attack cases.

**This is the highest-priority item that can actually be built and verified in
this environment. Starting here.**

### RISK-3 · No admin audit log · **P1, and FIXABLE NOW**

```
$ grep -rniE "audit" services/api/src services/api/migrations | grep -v .test. | wc -l
0        (the 4 hits are references to docs/security-audit.md, not code)
```

The brief §16 requires every sensitive admin action to emit an audit event with
`adminId, action, timestamp, correlationId, target, result`. Admin actions
today — suspending a driver, topping up a wallet, changing commission, resolving
a dispute with a monetary adjustment — leave **no attributable trail**.

### RISK-4 · Migrations have never been executed · **P1**

Every schema-level guarantee this system leans on — append-only triggers, the
deferred balance trigger, the partial unique indexes that make a second live
ride impossible — is currently a claim about a *file*. **Blocked on Postgres.**

### RISK-5 · Nothing Flutter has ever been compiled · **P1**

25 Dart files, zero compilations. Expect compile errors on first run.
**Blocked on the Flutter SDK.**

---

## 4. What I am NOT claiming

- **Not** production ready.
- **Not** fully tested — realtime and queues have no automated tests.
- **Not** verified against a real database, a real Redis, a real device, or
  real load.
- The 611 passing tests prove the **logic** is internally consistent. They
  prove nothing about the schema, the OEM power managers, or the VPS.

---

## 5. Immediate plan

1. **P0-a — Rate limiting** (RISK-2). Buildable and verifiable here. Starting now.
2. **P0-b — Admin audit log** (RISK-3). Buildable and verifiable here.
3. Escalate BLOCKER-1 (stack) and BLOCKER-2 (scope) to the owner.
4. Everything else is gated on Docker, Flutter, or a device.
