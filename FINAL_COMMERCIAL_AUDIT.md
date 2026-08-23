# FINAL_COMMERCIAL_AUDIT.md

**Date:** 2026-08-23 · **Verdict: NO-GO**

Independent re-audit. The previous baseline was not trusted: every claim below
was re-derived by running commands or reading source this session.

---

## 1. Executive summary

The backend is a genuinely strong piece of work — 36 routes, an enforced ride
state machine, a double-entry ledger, atomic matching, idempotency, audit
logging, risk-tiered rate limiting and revocable sessions, all under strict
TypeScript with 687 passing tests.

**The product around it is not there.**

- Neither mobile app can be built. The rider app has no Android project at all;
  the driver app has a manifest and nothing else.
- There is no map anywhere in either app.
- Sign-in was broken in both apps — `Firebase.initializeApp()` was never called.
- The admin panel is not an application: four files, no entry point, `vite build`
  fails.
- Push delivery is a logged no-op, so a backgrounded driver never receives an offer.

And the strong backend has never met a real database or a real Redis.

**Two real defects were found and fixed during this audit**, one of them a
serious authorization hole: any driver could accept a ride dispatched to
someone else.

---

## 2. Repository state

`124 .ts · 27 .dart · 13 .sql`. Working tree clean, on commit `499a5b5` at start.

Environment, re-checked by running each command: `docker`, `psql`, `redis-cli`,
`redis-server`, `k6`, `flutter`, `dart`, `gradle` → **all NOT FOUND**. Nothing
listening on 5432/6432/6379. `adb` present, **zero devices**.

## 3. Architecture — unchanged, as instructed

Flutter (rider, driver) · NestJS 11 + Express 5 · Refine/React admin · raw `pg`
via PgBouncer · Redis · BullMQ · `ws` for realtime. No framework was migrated,
no module replaced, no working code deleted.

## 4. Feature completeness

| Area | State | Note |
|---|---|---|
| Backend domain (rides, money, matching, auth, audit) | **IMPLEMENTED** | verified by tests + live HTTP |
| Backend push/notifications | **MISSING** | queue job logs and drops |
| Rider app | **PARTIAL** | 4 screens: sign-in, request, track. No history, rating UI, receipt, profile, wallet, support. **No map.** No Android project |
| Driver app | **PARTIAL** | 6 screens incl. the §5.3 battery-exemption flow. No earnings/withdrawal screen. **No map.** Android project is one manifest |
| Admin | **MISSING** | data provider only; no application |
| KYC / surge / zones / promotions | **SCOPE DECISION PENDING** | required by the brief, forbidden by CLAUDE.md §2. Neither built nor deleted |

## 5. Backend

**Strongest part of the system.** Clean typecheck, clean lint, clean build from
a deleted `dist/`, 687 tests, 0 skipped. Boots and serves: `/v1/health` 200,
`/v1/health/ready` 503 with both datastores down, `/v1/me` 401 RFC 9457, an
`alg:none` forged admin token rejected 401.

Realtime correctly fans out over **Redis pub/sub**, so events are not trapped
in one process's memory — checked because it is a common failure and it is done
right here.

## 6. Database — **BLOCKED BY ENVIRONMENT**

Six up + six down migrations, statically safety-checked, **never executed**.
Append-only ledger triggers, the deferred balance constraint, partial unique
indexes and the new `session_id` column have never been parsed by a database.

## 7. Redis — **BLOCKED BY ENVIRONMENT (P0)**

The atomic claim `SET ride:{id}:claim NX PX 30000` is proved only against an
in-memory fake, which has already diverged from real Redis once in this project.
The conformance suite that would catch the next divergence skips, loudly.

**Widened this session:** the *database* fake also cannot model concurrency —
see D-15. Neither half of the concurrent-accept path is verified.

## 8. Realtime — **PARTIAL**

Correct by construction (channels derive from the token subject; the subscribe
API takes no channel argument) and via Redis pub/sub. **Zero automated tests for
the realtime layer.**

## 9. Mobile — **NOT BUILDABLE (P0)**

See LAUNCH_BLOCKERS M-1/M-2/M-3. This is missing code, not a missing SDK.

## 10. Admin — **MISSING (P1)**

`vite build` → `Could not resolve entry module "index.html"`, 0 modules transformed.

## 11. Payments — **IMPLEMENTED (cash) / DELIBERATE STUB (gateway)**

`CashProvider` is complete and writes ledger entries. `GatewayProvider` throws
`NotImplementedError` **by design** — CLAUDE.md §7 requires the interface only.
Webhook signature verification is real: HMAC over raw bytes, `timingSafeEqual`,
checked **before** parsing. 12 signature tests.

**Gap:** no webhook replay/idempotency test, and the webhook returns 501, so
duplicate-delivery behaviour is untested. Not a launch blocker while the gateway
is deliberately out of scope; it becomes one the day a provider is wired.

**No fake payment success exists anywhere in production code.** Checked.

## 12. Wallet — **IMPLEMENTED, schema unverified**

Money is `BIGINT` whole dinars behind a branded `IqdAmount`; no float arithmetic
in any financial path. Balance is derived (`SUM(credits) - SUM(debits)`), never a
stored counter. Ledger is append-only in the service and by trigger — **the
trigger has never run**. Admin top-up is idempotent and audited.

## 13. Security — **PASS on code, unverified on infrastructure**

Verified fresh this session: SQL injection (three interpolation sites, all
string literals from source, 97 `$n` placeholders), no secrets in source,
IDOR returns 404-not-403, PII scrubbed before the audit write, security headers
live on the binary, CORS allowlist with wildcard refused at boot.

**Found and fixed:** D-14 ride stealing (P1), `ws` DoS advisory (P2).
**Open:** `path-to-regexp` ReDoS and `multer` (both transitive via NestJS;
multer is unused — no upload endpoints).

## 14. Testing — 687 backend + 11 admin, 0 skipped

Integrity checked, not just counted. No zero-assertion tests, none skipped.
Critical claims mutation-tested this session: D-14, D-13, rate-limit tiering,
session revocation — each was broken deliberately and the suite caught it.

**The honest limitation:** every test runs against in-memory fakes for both
Postgres and Redis, and D-15 shows the database fake actively diverges under
concurrency.

**A mistake I made and caught:** a slice-based edit silently deleted the two
D-14 tests. The count dropped 687→685 and that is how it was noticed. Restored.

## 15. Performance — **BLOCKED**. k6 absent. 500-user / p95<200ms target unmeasured.

## 16. Deployment — **NOT VERIFIED**

`infra/docker-compose.yml` exists (PostGIS, PgBouncer transaction mode, Redis
AOF, api, worker). Docker is absent, so no container has ever run. No backup or
restore procedure exists or has been tested.

## 17. Observability — **PARTIAL**

Structured `pino` logs with `request_id` on every line, PII-redacted; liveness
and readiness endpoints that genuinely check both datastores; audit log with
correlation ids. **No metrics, no error tracking (Sentry), no alerting.** At
3 a.m. you would have logs and nothing watching them.

## 18. External services

| Service | Status |
|---|---|
| Firebase Auth | CONFIGURATION REQUIRED (+ code fix applied, uncompiled) |
| Google Maps | **MISSING CODE** + CONFIGURATION REQUIRED |
| FCM push | **MISSING CODE** + CONFIGURATION REQUIRED |
| Payment gateway | Deliberate stub per CLAUDE.md §7 |
| Android signing | **MISSING** |
| Domain / TLS / storage / Sentry | Not configured |

## 19. Blockers

See `LAUNCH_BLOCKERS.md`. **7 open P0/P1.**

## 20–21. Configuration and remaining work

Credentials required: Firebase project + `google-services.json`, Maps API key
(Android-restricted), FCM service account, Android keystore, domain + TLS,
`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`.

Engineering remaining: Android host projects; the admin application; the maps
UI; push delivery + device-token registration; rider history/receipt/rating
screens; driver earnings screen; realtime tests; backup/restore; monitoring.

## 22. Decision

**NO-GO.** Putting real riders, real drivers and real money on this today would
not be responsible: no one could install the apps, no operator could run the
business, and the concurrency guarantee that stops two drivers taking one ride
has never executed against the infrastructure it depends on.

The backend is a solid foundation and the architecture is sound. What is missing
is mostly *client and operations* work, plus one afternoon of infrastructure
verification that should happen before anything else is trusted.
