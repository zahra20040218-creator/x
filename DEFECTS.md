# DEFECTS.md

Adversarial audit, per `AGENT_LOOP_PROMPT.md` PASS 1.

Stance taken: *I did not write this code, I am paid to find reasons it must not
go live, and being agreeable is failure.*

**Severity:** P0 loses money or data · P1 breaks a live ride · P2 degrades ·
P3 debt.

**Status:** 4 defects found and FIXED (3× P1, 1× P3). **One P0-class risk
remains UNRESOLVED** and is the reason this system must not be given to real
drivers yet. 600 API tests + 11 admin tests passing.

The caveat that matters more than any single finding: this audit was performed
by the same agent that wrote the code, in the same session. That is the weakest
possible form of review, and `RUN_AUTONOMOUS.md` says so directly — an agent's
report on its own work is wrong about 23% of the time. Treat this as a starting
point for a real review, not a clean bill of health.

The full §12 line-by-line pass, with all six named attack cases, is in
[docs/security-audit.md](docs/security-audit.md).

---

## Machine-readable summary

`ACCEPTANCE_CHECKLIST.md` Part Zero counts unfixed P0/P1 rows with
`grep -cE "^\| (P0|P1)" DEFECTS.md`. **That gate must be able to read this
file, or it silently reports "clean" while a P0 is open** — which is the exact
failure mode the checklist exists to prevent. So the open items are listed here
in the shape that command expects.

| Severity | ID | Status | One line |
|---|---|---|---|
| P0 | D-2 | **UNRESOLVED** | The in-memory Redis has never been checked against a real Redis; double-accept protection is designed-and-unit-tested, not verified |
| P2 | D-4 | open | Idempotent response stored outside the work's transaction |
| P2 | S-3 | **fixed** | Was worded too broadly. Account deactivation ALWAYS revoked immediately (AuthGuard reloads the user every request). The real gap - logout leaving the access token alive for up to an hour - is closed by migration 0006 |
| P2 | S-4 | **fixed** | Rate limiting implemented and verified over HTTP |
| P2 | S-7 | **fixed** | Blanket fail-open replaced by a per-tier policy. Verified on the compiled binary with no Redis: OTP verify allowed 3 then returned 429, instead of being unlimited |
| **P1** | **D-14** | **FIXED** | **Ride stealing.** `accept` authorised nobody: the state machine was handed the CALLER as the offered driver, and `driver_id` is null while OFFERED, so ANY driver holding a ride id could take a ride dispatched to someone else. Decline, wait for re-offer, accept. Now checked against a PENDING `ride_offers` row inside the same transaction |
| P2 | D-13 | **FIXED** | Going offline now releases the offer the driver was holding. Previously they kept it after `goOffline` deleted their Redis presence, so the rider got an assigned driver with no location and no other driver was tried until the timeout |
| **P1** | **D-15** | open | **`FakeDatabase.transaction` snapshots the whole database and restores it on any failure**, so concurrent rollbacks erase a committed write. Every concurrency test in this repo runs on it. Durability under contention is therefore unproven — this widens D-2 from "Redis" to "Redis and Postgres" |
| P3 | D-16 | open | `withClaim` takes the Redis claim BEFORE the ownership check, so a driver who was not offered the ride can transiently make the real offeree fail with 409 until they retry. Safety is unaffected — the ride is never assigned to the wrong driver — but it is a liveness wart |
| **P0** | **M-1** | open | **The rider app has no `android/` project at all**, and the driver app has only `AndroidManifest.xml` — no Gradle project, no signing config, no icons. Neither app can produce an APK even with the Flutter SDK installed. This is missing code, not a missing tool |
| **P0** | **M-2** | **partly fixed** | `Firebase.initializeApp()` was never called, so `FirebaseAuth.instance` would throw `[core/no-app]` and sign-in was broken in both apps. Call added (UNCOMPILED — no Flutter SDK here). Still needs `google-services.json` + the Gradle plugin: CONFIGURATION REQUIRED |
| **P1** | **M-3** | open | **No map anywhere.** `google_maps_flutter` is declared but `GoogleMap` is never instantiated; the pickup/destination picker is an explicit placeholder. A rider cannot choose a point on a map or watch the driver approach |
| **P1** | **A-1** | open | **The admin panel is not an application.** 4 files, no `index.html`, no `main.tsx`, no components, no routes. `vite build` fails with "Could not resolve entry module index.html". Operators cannot approve drivers, resolve disputes, top up wallets, or change fares |
| **P1** | **N-1** | open | **Push delivery is a logged no-op.** A driver whose app is backgrounded receives no ride offers; offers expire in 15s, so drivers must keep the app open and foregrounded to earn |
| P2 | S-11 | **FIXED** | `ws` 8.18.3 had a high-severity memory-exhaustion DoS affecting the internet-facing WebSocket server. Upgraded to 8.21.0 and re-audited |
| P2 | S-12 | open | Transitive high-severity advisories remain in `path-to-regexp` (via @nestjs/core, ReDoS) and `multer` (via @nestjs/platform-express, unused — no upload endpoints). Not directly upgradable without overriding NestJS internals |
| P2 | D-7 | open | Production PgBouncer guard is a string match, not a URL parse |
| P2 | D-6b | open | Zero-fare settlement raises a confusing error |

Expected count from the checklist command: **1**. A `1` here means STOP and read
this file, exactly as the checklist says.

---

## UNRESOLVED

### D-2 — The in-memory Redis is unverified against real Redis · **P0-class RISK · UNRESOLVED**

**Files:** `src/redis/in-memory-redis.ts`, `test/integration/ioredis-conformance.test.ts`

Every guarantee about CLAUDE.md §5.1 — including the headline "exactly one of
fifty concurrent drivers wins" — is currently proved **against a fake Redis
written in the same session as the code it verifies**.

The conformance suite exists precisely to detect divergence, and it is a single
shared file so the two cannot drift silently. On this host it skipped, because
there is no Redis:

```
↓ integration test/integration/ioredis-conformance.test.ts (1 test | 1 skipped)
```

**Why P0-class:** if the fake diverges from Redis on `SET NX PX` semantics,
double-accept protection does not work and *the tests are still green*. That is
the worst shape a defect can have. `ACCEPTANCE_CHECKLIST.md` check 4 names the
consequence: two drivers arriving for the same rider.

**This is a RISK, not a confirmed defect.** The fake was written to documented
Redis behaviour, the adapter issues the exact mandated command, and the fake has
already been caught diverging once (see D-6) — which is evidence the mechanism
works, and evidence that divergence is real.

**To resolve:**
```bash
docker compose -f infra/docker-compose.yml up -d redis
TEST_REDIS_URL=redis://localhost:6379 pnpm --filter @rideapp/api test:integration
```
CI sets `TEST_REDIS_URL` and **fails the build if the suite skips**, so this
closes the first time CI runs.

**Mitigation already in place:** four independent layers sit beneath Redis —
the guarded `UPDATE ... WHERE status = 'OFFERED'`, the
`rides_one_active_per_driver_uq` partial unique index, the state machine's
actor rule, and `withClaim`'s rollback. A Redis divergence would have to defeat
all four to produce a double dispatch.

---

## FIXED

### D-1 — Idempotency purge deleted other riders' live keys · **P1 · FIXED**

`purgeExpired` matched on `key` alone; the primary key is
`(user_id, endpoint, key)`. Keys are client-generated, so two riders can hold
the same key text at once.

**Trigger:** rider A's key `abc` expires → cleanup runs → rider B's *live* key
`abc` is deleted as collateral → B's network drops, their app retries, the key
is gone → **a second ride is created and a second driver dispatched.**

Exactly the failure CLAUDE.md §5.2 exists to prevent, arriving through the
cleanup job rather than the request path — which is why it survived the original
tests: every idempotency test used one user.

**Fix verified by reverting the SQL** and confirming the regression test fails
(`expected 2 to be 1`), then passes. The test fake was also changed to model the
real `WHERE` clause, so a fake that "does the right thing regardless of the SQL"
can no longer hide this class of bug.

### D-8 — `handleOfferOutcome` read a field that is always null · **P1 · FIXED**

The offeree's outstanding-offer key was cleared by reading `ride.driverId`. A
ride in `OFFERED` has **no driver assigned** — `driver_id` is set on accept — so
the branch never fired. Driver A, offered a ride and not responding, kept seeing
a stale offer for a ride that now belonged to driver B.

**Found by the per-file 95% branch coverage gate** flagging an unreachable
branch. The gate did not merely measure coverage; it surfaced a bug.

Fixed to read the driver from the `PENDING` `ride_offers` row.

### D-9 — A driver could not read the ride they were offered · **P1 · FIXED**

`getRideFor` allowed only the *assigned* driver. A driver holding a live offer
therefore got 404 on the ride they were being asked to accept — they could not
see the pickup or the fare. The API contract always said they could; the service
did not.

Fixed, scoped to a `PENDING` offer for that specific driver, so a declined or
superseded offer stops granting access.

### D-6 — `DEL` only removed string keys · **P1 · FIXED**

A fake-vs-real Redis divergence: real `DEL` removes a key of any type, but the
in-memory implementation only touched its string map. Taking a driver offline
left their last-known-location hash readable.

Fixed, and **added to the shared conformance suite** so the real-Redis run
checks it too. This is the mechanism in D-2 working as designed.

### S-1 — Test fixtures used plausibly-real phone numbers · **P3 · FIXED**

CLAUDE.md §12.6 covers fixtures explicitly. Fixtures used structurally valid
Iraqi mobile numbers; Iraq has no reserved test range, so one may have belonged
to a real person. Moved to an all-zeros subscriber block across all 8 files.

While fixing, found that the phone-masking assertion had become **vacuous** —
it checked `not.toContain('123')` against a number no longer containing `123`.
Rewritten to compute the middle segment from its input.

### D-5 — Claim release on cancellation · **FIXED**

`cancelRide` and `completeRide` now release the Redis claim and return the
driver to `ONLINE`, via `tx.onCommit` so they run only after the transaction
commits — never before, which would tell a rider about a cancellation that could
still roll back.

### S-5 — CORS unconfigured · **FIXED**

The admin panel was non-functional. Added an allowlist, and `loadConfig` now
**refuses a wildcard outright**: the API takes a bearer token, so `*` would let
any website issue admin requests from a logged-in operator's browser.

---

## OPEN, lower severity

### D-4 — Idempotent response stored outside the work's transaction · **P2**

If the process dies between the work committing and the `UPDATE` storing the
response, the key stays claimed with `response_status IS NULL`, and retries get
409 `idempotency-in-progress` for up to 24 hours.

**The ride does exist**, so no money is lost and no second driver is dispatched
— the damage is a confusing error, which is why this is P2.

**Fix:** claim the key in its own committed statement (as now), then run the
work **and** the response store in one transaction.
**Mitigation:** the rider app treats 409 `idempotency-in-progress` as retryable.

### S-3 — Admin tokens cannot be revoked · **P2**

`ADMIN` cannot be obtained through `/auth/otp/verify` — an admin token is issued
out of band. Safer than an admin OTP path, but it means there is no admin
session management: an admin token cannot be revoked short of rotating
`JWT_SECRET`, which signs *everyone* out.

**Before real use:** give admins refresh tokens so `revokeAllForUser` works for
them too.

### S-4 — No rate limiting · **P2**

Nothing limits requests per IP or per user. `/auth/otp/verify` can be called in
a loop, and each call costs a Firebase verification. Outside CLAUDE.md's stated
v1 scope and normally a reverse-proxy concern — but worth a few lines of nginx
config before the endpoint faces the open internet.

### D-7 — The production PgBouncer guard is a string match · **P2**

`loadConfig` refuses a production `DATABASE_URL` containing `:5432/`. A URL
written `postgres://host:5432` without a trailing slash slips through. Should
parse the URL rather than pattern-match it.

### D-6b — Zero-fare settlement raises a confusing error · **P2**

`recordRideSettlement` with `fareIqd = 0` produces one entry of amount 0, fails
`isBalanced`, and raises `UnbalancedLedgerError` — correct behaviour, misleading
message. Reachable only via a tariff configured entirely to zeros.

---

## What a real reviewer should attack first

1. **The fake Redis** (D-2). Everything about concurrency rests on it, and it
   has already been caught diverging once.
2. **The migrations.** Never executed. Every schema-level guarantee claimed
   anywhere in this repository — the append-only triggers, the balance trigger,
   the partial unique indexes — is currently a claim about a *file*, not about a
   database.
3. **The ledger money model** (DECISIONS.md D-003). `DRIVER_WALLET` means
   *cumulative earnings*, not *funds held*. If that reading is wrong for the
   business, every wallet figure in the admin panel is mislabelled — a P0 the
   first time a driver disputes a balance.
4. **Everything Flutter.** Not compiled, not analysed, not run. See BLOCKED.md.
