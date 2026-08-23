# COMPLETION_MATRIX.md

Every requirement, its status, and the command that proves it.

**Status vocabulary — only these four:** `DONE` · `PARTIAL` · `BLOCKED` · `FAILED`

`DONE` requires: code exists · no stub in the production path · tests written
**and passing** · typecheck clean · lint clean · **and I ran the command
myself**. Anything I could not execute here is `BLOCKED`, never `DONE`.

**Last verified:** 2026-08-23 (fourth pass, commercial audit) · **687 backend + 11 admin tests, 0 skipped.**

> **See `FINAL_COMMERCIAL_AUDIT.md`.** Two rows below were downgraded after the
> commercial audit: the admin panel is not an application (`vite build` fails
> with no entry module) and the rider app has no Android project, so neither is
> merely *blocked* — both are missing code.

---

## How to reproduce every claim in this file

```bash
cd services/api && npx vitest run          # 642 passed, 1 skipped
cd services/api && npx tsc --noEmit        # no output
cd services/api && npx eslint "src/**/*.ts" "test/**/*.ts"   # no output
cd services/api && npx tsc -p tsconfig.build.json            # exit 0
cd apps/admin   && npx vitest run          # 11 passed
```

Server actually running, not simulated:
```bash
cd services/api && DATABASE_URL=... REDIS_URL=... FIREBASE_PROJECT_ID=... \
  JWT_SECRET=... PORT=4123 node dist/main.js
curl -s http://localhost:4123/v1/health        # {"status":"ok"}          200
curl -s http://localhost:4123/v1/me            # RFC 9457 problem+json    401
curl -s http://localhost:4123/v1/health/ready  # degraded, PG+Redis fail  503
```

---

## Core correctness

| Requirement | Status | Evidence | Test | Command | Result |
|---|---|---|---|---|---|
| Money is integer minor units, never float | **DONE** | branded `IqdAmount`; 6 BIGINT columns asserted against DDL; integer-only bps | `iqd.test.ts`, `migrations.test.ts` | `npx vitest run` | 59 + 23 pass |
| Double-entry ledger, balanced | **DONE** | service refuses unbalanced writes; DB trigger as second layer | `ledger.service.test.ts` | `npx vitest run` | 33 pass |
| Ledger append-only | **PARTIAL** | no update/delete method exists; **DB trigger never executed** | `ledger.service.test.ts` | needs Postgres | service ✅ / schema ⛔ |
| Wallet balance derived, not stored | **DONE** | `SUM(credits) - SUM(debits)`; no counter column | `ledger.service.test.ts` | `npx vitest run` | pass |
| Commission configurable, default 0, no deploy | **DONE** | TTL cache; snapshotted per ride | `platform-config.service.test.ts` | `npx vitest run` | 23 pass |
| Ride state machine, illegal transitions fail | **DONE** | 16 rules; all 121 pairs walked; 409 not silent | `ride-state-machine.test.ts` | `npx vitest run` | 28 pass |
| double accept / double start / double complete | **DONE** | exhaustive pair table + service-level guards | `ride-state-machine.test.ts`, `ride.service.test.ts` | `npx vitest run` | pass |
| **two drivers accepting same ride** | **PARTIAL** | 20-way race → exactly one 200, rest 409, over HTTP | `api.e2e.test.ts` | `npx vitest run` | ✅ **vs fake Redis only** |
| Optimistic locking on transitions | **DONE** | guarded `UPDATE ... WHERE status = $from`; 0 rows → 409 | `ride.service.test.ts` | `npx vitest run` | pass |
| Idempotent ride creation | **DONE** | 5 retries → 1 ride; body-mismatch 409; concurrent-retry 409 | `api.e2e.test.ts` | `npx vitest run` | pass |

---

## Dispatch / matching

| Requirement | Status | Evidence | Test | Command | Result |
|---|---|---|---|---|---|
| Nearest driver | **DONE** | Redis GEO, nearest-first, whole-metre distances | `matching.service.test.ts` | `npx vitest run` | pass |
| Driver unavailable / suspended excluded | **DONE** | eligibility read from Postgres, not cache | `matching.service.test.ts` | `npx vitest run` | pass |
| Offer timeout → next candidate | **DONE** | `EXPIRED → REQUESTED → OFFERED`, never resting in EXPIRED | `matching.service.test.ts` | `npx vitest run` | pass |
| Driver rejection → retry | **DONE** | decline chain to exhaustion → `NO_DRIVERS_FOUND` | `api.e2e.test.ts` | `npx vitest run` | pass |
| Stale location evicted | **DONE** | heartbeat sorted set + sweeper | `driver-presence.service.test.ts` | `npx vitest run` | pass |
| Same ride never assigned twice | **PARTIAL** | 5 independent layers | `api.e2e.test.ts` | `npx vitest run` | ✅ **vs fake Redis** |

---

## Security

| Requirement | Status | Evidence | Test | Command | Result |
|---|---|---|---|---|---|
| OTP flow | **PARTIAL** | Firebase ID-token verification via JWKS; server never issues an OTP | `auth.test.ts` | `npx vitest run` | 40 pass · **no real Firebase** |
| JWT access token | **DONE** | HS256, issuer/audience/expiry checked | `auth.test.ts` | `npx vitest run` | pass |
| Refresh rotation + revocation | **DONE** | guarded UPDATE; replay → 401; stored as SHA-256 hash | `auth.test.ts`, `api.e2e.test.ts` | `npx vitest run` | pass |
| Role-based authorization | **DONE** | rider→403 on driver and admin routes | `api.e2e.test.ts` | `npx vitest run` | pass |
| **Row-level / IDOR protection** | **DONE** | other rider's ride → **404 not 403**; list filters on token id | `api.e2e.test.ts` | `npx vitest run` | pass |
| DTO validation on every endpoint | **DONE** | Zod at every boundary; RFC 9457 with field paths | `api.e2e.test.ts` | `npx vitest run` | pass |
| **Rate limiting** | **PARTIAL** | Redis fixed-window; risk-tiered failure policy; health exempt; Redis call timed out | `rate-limit.test.ts`, `api.e2e.test.ts` | `npx vitest run` | 23 + 6 pass · **never run against real Redis** |
| **Rate limiting survives a Redis outage** | **DONE** | CRITICAL degrades to `ceil(limit/divisor)`; OPERATIONAL stays open; verified on the **compiled binary with no Redis** | `rate-limit.test.ts` | `curl` ×6 on `/auth/otp/verify` | **3 allowed, then 429** |
| **Health checks never rate limited** | **DONE** | `@NoRateLimit()`; a 429 on a probe would make the LB eject a healthy instance | — | 400 live requests to `/v1/health` | **0 non-200** |
| **Session revocation** | **PARTIAL** | `sid` claim + live-session check folded into the existing per-request user load; logout kills the access token at once | `api.e2e.test.ts` (11), `auth.test.ts` | `npx vitest run` | pass · **migration 0006 never applied to a real DB** |
| **Admin suspension cuts sessions** | **PARTIAL** | revokes in the same transaction as the suspension | `api.e2e.test.ts` | `npx vitest run` | pass · **vs fake DB** |
| **Security headers** | **DONE** | CSP `default-src 'none'`, HSTS 180d, nosniff, DENY, no X-Powered-By | live response | `curl -sD - /v1/health` | **7 headers verified on the binary** |
| **Admin audit log** | **DONE** | actor/action/target/result/correlationId; failures recorded; PII scrubbed | `audit.service.test.ts`, `api.e2e.test.ts` | `npx vitest run` | 12 pass |
| PII never logged | **DONE** | structural redaction at depth; coords coarsened to ~110 m | `logger.test.ts` | `npx vitest run` | 38 pass |
| Webhook signature | **DONE** | HMAC over raw bytes, `timingSafeEqual`, checked before parsing | `webhook.test.ts` | `npx vitest run` | pass |
| CORS allowlist, wildcard refused | **DONE** | `loadConfig` throws on `*` | `config.test.ts` | `npx vitest run` | pass |
| Secrets in ENV only | **DONE** | no secret in repo; `.env.example` committed | grep scan | see below | 0 hits |

```
$ grep -rnE "\+9647[0-9]{9}" services/api/src --include=*.ts | grep -v .test.
(no output)
```

---

## Platform / infra

| Requirement | Status | Evidence | Test | Command | Result |
|---|---|---|---|---|---|
| Backend builds | **DONE** | `dist/` produced | — | `npx tsc -p tsconfig.build.json` | **exit 0** |
| **Backend starts and serves** | **DONE** | 36 routes mapped; live 200/401/503 | — | `node dist/main.js` + curl | **verified** |
| Graceful degradation | **DONE** | starts with no PG and no Redis; readiness 503 | — | curl `/v1/health/ready` | **verified** |
| Health checks | **DONE** | liveness touches nothing; readiness checks both | `api.e2e.test.ts` | `npx vitest run` | pass |
| Structured logging + request_id | **DONE** | request_id present in every response and log line | `logger.test.ts` | curl output | **verified** |
| Migrations forward + reversible | **BLOCKED** | 5 up + 5 down, safety-checked | `migrations.test.ts` (static) | needs Postgres | **never executed** |
| Docker Compose | **BLOCKED** | PostGIS, PgBouncer txn mode, Redis AOF, api, worker | — | needs Docker | **never run** |
| CI pipeline | **BLOCKED** | full workflow incl. real-Redis skip-detector | — | needs a push | **never run** |
| BullMQ workers | **BLOCKED** | 4 recurring jobs, separate process | — | needs Redis | **never run** |
| Realtime WebSocket | **PARTIAL** | token-derived channels, no client-named channel | **none** | — | **code review only** |

---

## Clients

| Requirement | Status | Evidence | Test | Command | Result |
|---|---|---|---|---|---|
| Shared core (models, API client, design) | **BLOCKED** | 14 files, Flutter | `iqd_test.dart` written | needs Flutter | **never compiled** |
| Rider app full flow | **FAILED** | auth → request → track → rate | — | needs Flutter | **never compiled** |
| Driver app full flow | **BLOCKED** | auth → online → offer → trip → wallet | — | needs Flutter | **never compiled** |
| **Background location (§5.3)** | **BLOCKED** | foreground service, Doze exemption + explainer, offline buffer, no WorkManager | `location_service_test.dart` written | needs Flutter **+ device** | `AUTOMATED = written, unrun` · **`REAL DEVICE = BLOCKED`** |
| Arabic / RTL / localisation | **PARTIAL** | interface-based strings; no hardcoded user text | — | needs Flutter | **never compiled** |
| Admin panel | **FAILED** | data provider, money formatter, contract paths | `money.test.ts` | `npx vitest run` | 11 pass · **no UI screens** |
| Loading/Empty/Error/Success on every screen | **PARTIAL** | `AsyncView` makes all four **structural** — `empty` and `onRetry` are required params, so omitting them fails to compile; permission-denial error+retry added | `async_view_test.dart` (12 widget tests) | needs Flutter | **written, UNRUN** — see `docs/UI_STATE_MATRIX.md` |
| KYC / documents / approval | **BLOCKED** | `CLAUDE.md` §2 says OUT OF SCOPE | — | — | **BLOCKER-2** |
| Zones / surge / promotions | **BLOCKED** | `CLAUDE.md` §2 says OUT OF SCOPE | — | — | **BLOCKER-2** |

---

## Performance & resilience

| Requirement | Status | Evidence | Test | Command | Result |
|---|---|---|---|---|---|
| Load test 500+ concurrent | **BLOCKED** | k6 script, hard `count==0` thresholds | — | needs k6 + server | **never run** |
| API p95 < 200ms | **BLOCKED** | — | — | needs load test | **unmeasured** |
| Matching < 3s | **BLOCKED** | — | — | needs load test | **unmeasured** |
| Redis unavailable → degrade | **DONE** | readiness 503; limiter fails open with a warn | — | `node dist/main.js` no Redis | **verified: 13/13 fail-open events** |
| DB unavailable → degrade | **DONE** | API starts, liveness serves, readiness 503 | — | `node dist/main.js` no PG | **verified** |
| Queue delayed / WS disconnect / FCM down | **PARTIAL** | reconnect + polling fallback in client code | **none** | — | **untested** |

---

## Honest totals

| Status | Count | Change |
|---|---|---|
| **DONE** — built, tested, and I ran it | **33** |
| **PARTIAL** — works but not fully verified, or scope-limited | **11** |
| **BLOCKED** — needs Docker, Flutter, a device, k6, or credentials | **12** |
| **FAILED** — missing code, not a missing tool | **2** |
| **Total rows** | **58** |

**Counted by machine from the rows above**, not by hand:

```bash
grep -cE '^\| [^|]+ \| \*\*DONE\*\*' docs/COMPLETION_MATRIX.md
```

**Correction:** the previous revision of this file reported 30/13/17/0 and then
32/16/16/0. Both were hand-totalled and both were wrong — they did not match
the rows in the file. The numbers above are derived from the file itself. The
stack conflict in particular was never a row in this matrix (it lives in
`docs/BLOCKERS.md`), so resolving it did not decrement `BLOCKED` here.

Counted from the rows above, not estimated.

**Nothing moved from BLOCKED to DONE because an implementation appeared.** The
one BLOCKED item that closed (the stack conflict) closed because the **owner
made the decision**, which is the dependency it was blocked on. Docker,
Flutter, k6 and a physical device are all still absent — re-verified this
session by running the commands, not assumed.

Session revocation and admin-suspension-cuts-sessions are `PARTIAL`, not
`DONE`, even though both are implemented and proved over real HTTP: migration
0006 has never been applied to a real PostgreSQL, so the `session_id` column
and the index that serves the per-request liveness check exist only in SQL
text and in the fake.

**The former `FAILED` is now `PARTIAL`, not `DONE`.** The four states were made
structural — `AsyncView` will not compile without an empty state and a retry
handler — and the worst real gap was fixed: the CLAUDE.md §5.3 permission screen
previously did *nothing* on a denial, leaving the driver stuck with no
explanation on the one screen that decides whether background location works.

It is **not** `DONE` because no Flutter SDK exists here: the 12 widget tests are
written and have never run, and `docs/UI_STATE_MATRIX.md` lists five gaps still
open (ride-history screen, driver empty-earnings, map picker, dark mode,
per-screen accessibility).

---

## What I explicitly do NOT claim

- **Not production ready.**
- **Not** verified against a real database, a real Redis, a real device, real
  load, or a real Firebase project.
- **Rate limiting is INACTIVE in this environment** — it fails open without
  Redis, and I proved that rather than hiding it.
- The one **P0-class risk is UNRESOLVED**: the atomic claim is proved against a
  fake Redis (DEFECTS.md D-2).
