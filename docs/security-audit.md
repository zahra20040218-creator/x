# Security audit — CLAUDE.md §12, line by line

Adversarial pass over the finished system. Stance: *I did not write this, I am
paid to find reasons it must not go live, and being agreeable is failure.*

**The caveat that matters most:** this audit was performed by the same agent
that wrote the code. `RUN_AUTONOMOUS.md` states an agent's report on its own
work is wrong about 23% of the time. This is a starting point for a real
review, not a clean bill of health.

---

## The six attack cases `AGENT_LOOP_PROMPT.md` names

### 1. Double-accept interleaving

**Attack:** three drivers tap "accept" on the same ride within the same
millisecond. Two are dispatched to one rider.

**Defence, in depth:**

| Layer | Mechanism | Tested |
|---|---|---|
| Redis | `SET ride:{id}:claim {driverId} NX PX 30000` | 50-way race → exactly one winner |
| Service | `withClaim` releases on failure so a DB error frees the ride | yes |
| State machine | `OFFERED → ACCEPTED` requires the assigned driver | exhaustive |
| Database | `rides_one_active_per_driver_uq` partial unique index | statically |
| Guarded UPDATE | `WHERE id = $1 AND status = 'OFFERED'` → 0 rows = 409 | yes |
| HTTP | two concurrent POSTs → `[200, 409]` | yes, e2e |

**Verdict: DEFENDED, with one unresolved risk.** The Redis layer is proved
against a fake Redis (DEFECTS.md D-2). Until the conformance suite runs against
a real Redis, the top layer of this stack is designed-not-verified. The four
layers beneath it are independent of that.

---

### 2. Unbalanced ledger entries

**Attack:** write a settlement whose rows do not sum to zero, so money appears
or vanishes.

**Defence:**
- `LedgerService.write` refuses to emit SQL for an unbalanced command set.
- A **deferred constraint trigger** re-checks at COMMIT, catching anything that
  bypasses the service entirely.
- `findUnbalancedTransactions` exists for nightly reconciliation, because
  "impossible" and "verified" are different assurances.
- Commission and driver earnings are computed by SUBTRACTION, never as two
  independent percentages — so they cannot fail to sum to the fare on a
  rounding boundary.

**Verdict: DEFENDED at the service layer, UNVERIFIED at the database layer.**
The trigger has never executed — no Postgres on this host.

---

### 3. Driver A reading driver B's data

**Attack:** driver A calls `/rides/{B's ride}/complete`, or reads B's wallet.

**Defence:**
- Authorisation is **inside the state transition**, not beside it. The guard
  answers "who are you"; `RideStateMachine` answers "may you". Splitting those
  is precisely how this bug is normally introduced.
- `/driver/wallet` derives the driver id from the token. There is no parameter.
- Realtime channels derive from the token's subject; **a client never names a
  channel**, so there is no frame that subscribes A to B's stream.

**Tested:** exhaustively at the service layer, and over HTTP
(`refuses another driver completing a trip in progress` → 403).

**Verdict: DEFENDED.**

---

### 4. Rider A reading rider B's rides

**Attack:** enumerate ride UUIDs, or widen the list filter.

**Defence:**
- `GET /rides/{id}` returns **404, not 403**, for another user's ride — a 403
  would confirm the id is real and turn the endpoint into an enumeration
  oracle.
- A malformed UUID also returns 404, for the same reason.
- `GET /rides/me` filters on the token's own id. There is **no parameter that
  widens it**.
- Page size is clamped server-side after reading, so `limit=100000` returns 50.

**Tested over HTTP:** both the 404 and the empty-list case.

**Verdict: DEFENDED.**

---

### 5. Float in any money path

**Attack:** get a fractional value into a money column, where it accumulates
silently across thousands of rides.

**Defence:**

| Boundary | Mechanism |
|---|---|
| Database | 6 money columns, all `BIGINT`, asserted against the DDL text |
| TypeScript | branded `IqdAmount`; a plain number cannot be assigned |
| Arithmetic | commission is `floor((amount × bps + 5000) / 10000)`, never `× 0.15` |
| DB reads | `parseIqdFromDb` rejects a decimal string |
| HTTP in | Zod `.int()` on every money field |
| Gateway webhook | a fractional amount from the provider is **rejected, not rounded** |
| Flutter | `IqdAmount.fromJson` throws on a fraction |
| Admin panel | renders a fraction as `⚠ … NOT A WHOLE DINAR` rather than rounding |

That last one matters for `ACCEPTANCE_CHECKLIST.md` check 6: a panel that
quietly rounded would make the check pass regardless of the truth.

**Verdict: DEFENDED, in depth.**

---

### 6. PII in logs

**Attack:** a phone number or exact coordinate reaches a log aggregator.

**Defence:** structural redaction at any depth on 20 key names; coordinates
coarsened to 3 decimal places (~110 m); pino path redaction as a second layer;
error responses never carry an unplanned exception's message.

**Known hole, asserted in the test suite:** a phone under an **unrecognised key
name** is NOT redacted. The test `does NOT catch a phone hidden under an
unrecognised key` documents this deliberately, so nobody assumes otherwise.

**Verdict: DEFENDED for known shapes; incomplete by construction.**

---

## The ten §12 prohibitions

| # | Rule | Status | Evidence |
|---|---|---|---|
| 1 | Never invent an endpoint | ✅ | Every route maps to `api-contract.yaml`; the admin data provider throws for an unmapped resource |
| 2 | Never store money as float | ✅ | Scan of all migrations finds no `NUMERIC`/`REAL`/`FLOAT` in any money column |
| 3 | Never mutate a ledger row | ✅ | No update/delete method exists; DB triggers; migration runner refuses such SQL |
| 4 | Never bypass `RideStateMachine` | ✅ | Only `ride.repository.ts` writes `rides.status`; scan finds no other writer |
| 5 | Never match without the atomic claim | ✅ | `SET NX PX` is the only path; ⚠️ unverified vs real Redis |
| 6 | Never commit secrets or real phone numbers | ⚠️ | **See finding S-1 below** |
| 7 | Never scaffold out-of-scope features | ✅ | No iOS, no surge, no chat, no promo codes, no KYC upload |
| 8 | Never claim completion with failing tests | ✅ | 594 passing, 0 failing; Flutter marked `[BLOCKED]`, not `[x]` |
| 9 | Never drop a column without a two-phase plan | ✅ | Migration runner refuses an unacknowledged `DROP COLUMN` |
| 10 | Never `git push --force` | ✅ | Nothing was ever pushed anywhere |

---

## Findings

### S-1 · Test fixtures use plausibly-real Iraqi phone numbers · **P3**

CLAUDE.md §12.6 says "Never commit … real phone numbers — **including in tests
or fixtures**."

Test fixtures use `+9647701234567` and similar. These are structurally valid
Iraqi mobile numbers, and Iraq has no reserved test range the way the UK does
(`07700 900xxx`). **One of these may belong to a real person.**

Nothing is sent to them — no test performs a real SMS — so the exposure is a
number in a git history, not a call. But the rule says fixtures too, and this
is a fixture.

**Recommended fix:** move fixtures to an all-zeros subscriber block
(`+9647700000001`…), which is far less likely to be allocated, and note in the
test file why. Not applied here because it touches many files and the risk is
low; flagged so it is a decision rather than an oversight.

### S-2 · The gateway webhook endpoint is unauthenticated by necessity · **accepted**

`POST /payments/webhook/gateway` has `security: []` — a payment provider cannot
hold a user's bearer token. The HMAC signature is therefore the *only* control.

Mitigations in place: signature verified over the **raw bytes** before parsing;
`timingSafeEqual` rather than `===`; the 501 is returned **after** verification,
so the endpoint cannot be used as an oracle for which rides exist.

**Correction, 2026-09-05.** An earlier revision of this entry listed "replay
protection via a unique `(provider, external_id)`" as a mitigation **in place**.
That was false. The `payment_webhook_events` table and its unique index exist
(`0004_operations.up.sql:23-30`) and nothing in `services/api/src` has ever read
or written them — the pure function documents dedup as "the caller's job", and
the caller never opens a database connection. Claiming a control that does not
exist is worse than not having it, because it stops anyone looking again.

**Why it is not yet built:** the handler ends in 501 before any ledger write, so
there is nothing to replay *into*. Dedup must land in the same change that makes
a gateway write reachable, never after it — see `DECISIONS.md` D-019.

**Residual risk:** if `GATEWAY_WEBHOOK_SECRET` leaks, an attacker can submit
arbitrary ledger commands. Since the gateway is stubbed in v1 and the handler
always ends in 501, the reachable damage today is nil.

### S-3 · Admin tokens are minted, not signed in · **P2, by design**

`ADMIN` cannot be obtained through `/auth/otp/verify`. In v1 an admin token is
issued out of band. That is safer than an admin OTP path, but it means **there
is no admin sign-in flow and no admin session management** — an admin token
cannot be revoked short of rotating `JWT_SECRET`, which signs everyone out.

**Before real use:** add admin refresh tokens so `revokeAllForUser` works for
admins too.

### S-4 · No rate limiting anywhere · **P2**

Nothing limits requests per IP or per user. `/auth/otp/verify` in particular
can be called in a loop; each call costs a Firebase verification.

Out of CLAUDE.md's stated v1 scope, and a reverse proxy is the usual place for
it — but with 10 drivers and an open internet endpoint, worth a line of nginx
config before launch.

### S-5 · CORS is not configured · **P2**

The admin panel is a browser app on a different origin and no CORS policy is
set. It will not work until one is, and the fix must be an **allowlist**, not
`*` — `*` with credentials would let any site issue admin requests from a
logged-in operator's browser.

---

## What a real reviewer should attack first

1. **The fake Redis** (DEFECTS.md D-2). Everything about concurrency rests on
   it and it has never been checked against the real thing.
2. **The migrations.** Never executed. Every schema-level guarantee in this
   document — the triggers, the partial unique indexes, the balance check — is
   currently a claim about a file, not about a database.
3. **The ledger money model** (DECISIONS.md D-003). `DRIVER_WALLET` means
   *cumulative earnings*, not *funds held*. If that reading is wrong for the
   business, every wallet figure the admin panel shows is mislabelled — which
   becomes a P0 the first time a driver disputes a balance.
4. **CORS and rate limiting** before any endpoint faces the open internet.


---

# SECOND PASS — 2026-08-23

Run from scratch after the rate-limit and audit-log work. Fresh scans, not a
re-read of the first pass.

## Verified by scanning, not by assertion

### SQL injection — **PASS**

Three call sites interpolate into SQL. Each was read line by line:

| Site | Interpolated | Verdict |
|---|---|---|
| `admin.controller.ts:225` | `sets.join(', ')` | column names are **string literals in source** (`'vehicle_plate'`, `'is_suspended'`…); every value goes through `$n` |
| `rides.controller.ts:199` | `${table}` | a ternary over two literals: `'drivers'` / `'riders'` |
| `ride.repository.ts:226` | `sets.join(', ')` | same whitelist pattern; `status` and all effects parameterised |

**No user input reaches a SQL identifier position.** 97 parameter placeholders
across the codebase; zero interpolated values.

### Secrets in source — **PASS**

The grep for assigned api-key / secret / password / token literals of 12+
characters returns no output outside test files.

### PII in fixtures — **PASS** (was S-1, fixed)

All test phone numbers moved to an all-zeros subscriber block.

---

## New findings

### S-6 · No security headers · **P2 · FIXED**

The API set **no** security headers at all — no CSP, no HSTS, no
`X-Frame-Options`, no `X-Content-Type-Options`, and it advertised
`X-Powered-By`.

Fixed with `helmet`, tuned for a JSON API rather than copied from a web-app
config:

- **`default-src 'none'`** — this server returns JSON and never HTML, so there
  is no legitimate resource for a page to load from it.
- **`X-Content-Type-Options: nosniff`** — the realistic XSS vector against a
  JSON API is a browser sniffing an error body as HTML and executing it.
- **HSTS 180 days, `includeSubDomains`, `preload: false`** — preloading is
  effectively irreversible and is the owner's decision once a domain exists,
  not a default to inherit.
- **`X-Powered-By` removed** — it advertised the framework on every response.

**Verified on a live response from the compiled binary**, not in a test:

```
$ curl -sD - http://localhost:4567/v1/health
Content-Security-Policy: default-src 'none';frame-ancestors 'none';...
Strict-Transport-Security: max-age=15552000; includeSubDomains
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Resource-Policy: same-site

$ curl -sD - ... | grep -ci x-powered-by
0
```

### S-7 · Rate limiting is inactive without Redis · **P2 · ACCEPTED, documented**

Fail-open is a deliberate policy, not an oversight — reasoning and the security
trade-off are recorded in `docs/BLOCKERS.md` under *TECHNICAL — decided*.

**The cost is real and is not hidden:** while Redis is down there is no rate
limiting at all, so OTP abuse is possible in that window. Status stays
`PARTIAL`. Verified in the compiled binary: 13 requests produced 13
`ratelimit.unavailable` warnings.

### S-8 · CSRF — **not applicable, recorded so the question is closed**

The API is token-authenticated via an `Authorization` header and sets no
session cookie. A cross-site form cannot attach a bearer token, so classic CSRF
does not apply. CORS is an allowlist with a wildcard **refused at boot**.

If cookie auth is ever introduced this changes immediately — recorded so that
decision is made deliberately rather than by omission.

### S-9 · WebSocket authorization — **PASS by construction, UNTESTED**

Channels derive from the token's subject; the subscribe API takes **no channel
argument**, so there is no frame a client can send to reach another user's
stream.

**But there is no automated test for the realtime layer at all.** The guarantee
rests on construction and code review, not execution. Recorded as a gap, not a
pass.

### S-10 · Admin session cannot be revoked · **P2 · OPEN**

Unchanged from the first pass (S-3). An admin token is issued out of band and
cannot be revoked short of rotating `JWT_SECRET`, which signs everyone out.

---

## Second-pass verdict

| Area | Status |
|---|---|
| SQL injection | **PASS** — verified line by line |
| Secrets in repo | **PASS** |
| PII in logs / audit / fixtures | **PASS** |
| IDOR / row-level auth | **PASS** — 404-not-403, token-derived filters |
| Security headers | **PASS** — verified on a live response |
| CORS | **PASS** — allowlist, wildcard refused at boot |
| Input validation | **PASS** — Zod at every boundary |
| Rate limiting | **PARTIAL** — inactive without Redis |
| WebSocket authorization | **PARTIAL** — correct by construction, untested |
| Admin session revocation | **OPEN** |
| Audit log integrity | **PARTIAL** — append-only trigger written, **never executed** |
| Replay / idempotency | **PARTIAL** — proved against a fake DB only |
| Race conditions | **PARTIAL** — proved against a fake Redis only |

**Nothing here is claimed against real infrastructure.** Every `PARTIAL` above
is partial for that reason, and the ones that would become `PASS` with Docker
running are named in `docs/BLOCKERS.md`.

---

# THIRD PASS — 2026-08-23 (Phases 5 & 6)

Two open findings from the second pass are now closed. One was closed by
implementation; the other turned out to have been **written too broadly** and
is corrected here rather than quietly dropped.

## S-7 · Rate limiting inactive without Redis · **P2 · FIXED**

Previously accepted as a deliberate fail-open trade. That was the wrong call
for one class of endpoint, and the second pass recorded the cost without fixing
it.

The failure behaviour is now a property of the **endpoint**, not of the
limiter. Every `@RateLimit` must declare a `RiskTier`, and the tier decides:

| Tier | Redis down |
|---|---|
| `CRITICAL` — auth, money, admin mutation | **degrade** to `ceil(limit / RATE_LIMIT_LOCAL_DIVISOR)` in-process |
| `STANDARD` — ride lifecycle, ratings | **degrade** |
| `OPERATIONAL` — location, polling | **allow** (blocking breaks a live ride) |
| `@NoRateLimit()` — health probes | never limited |

**Verified on the compiled binary with no Redis running** — not in a test:

```
$ for i in 1..6; curl -X POST /v1/auth/otp/verify
req 1 -> 401     req 4 -> 429
req 2 -> 401     req 5 -> 429
req 3 -> 401     req 6 -> 429

$ grep '"decision"' /tmp/p56.log
degraded 3 · rejected 3 · allowed 0 · local_saturated 0
```

Three allowed then refused, exactly `ceil(10/4)`. Under the old policy all six
would have been allowed, and so would the six-hundredth.

**Not fixed by making everything fail closed**, which was considered and
rejected: it turns Redis into a single point of failure for the whole platform.
The residual weakness is stated plainly in `docs/RATE_LIMIT_POLICY.md` — the
in-process counter is per-instance, so N instances permit N× the local limit
unless `RATE_LIMIT_LOCAL_DIVISOR` is set to the instance count.

### New sub-finding · health probes were rate limited · **P2 · FIXED**

Found while classifying endpoints. `/v1/health` was subject to the 300/60
default. A 429 on a liveness probe makes a load balancer eject a healthy
instance — the limiter causing the outage it exists to prevent. Worse, with the
new degrade policy an unclassified health route would have been cut to 75/min
per instance.

**Verified live: 400 consecutive requests to `/v1/health`, 0 non-200.**

### New sub-finding · a hung Redis would stall every request · **P2 · FIXED**

ioredis **queues** commands while disconnected rather than rejecting them. With
no timeout, a Redis that is hung rather than refused would add its full latency
to every request on the hot path. Bounded now by
`RATE_LIMIT_REDIS_TIMEOUT_MS` (default 50ms), and there is a test asserting the
tier policy applies to a hung Redis, not only a refused one.

## S-3 · Admin session revocation · **P2 · CORRECTED, then FIXED**

**The finding as written was too broad and I should not have carried it
forward twice.** It said an admin token "cannot be revoked short of rotating
JWT_SECRET". Reading `auth.guard.ts` shows that is not true: the guard calls
`loadUser` on **every** request, which reads `users.is_active` from the
database. Deactivating an account has always taken effect on that account's
very next request. Role changes likewise, because the role is read from the DB
and not trusted from the token.

What was genuinely missing was narrower:

- `POST /auth/logout` revoked refresh tokens, but the caller's **access token
  kept working for the rest of its hour**. "Log me out" logged nobody out.
- No way to cut off a stolen session without deactivating the whole account or
  rotating `JWT_SECRET` and signing out every user on the platform.
- No session invalidation after a security-sensitive change.

Migration 0006 adds `session_id` to `refresh_tokens`, carried in the access
token as `sid`. A session is live while it has an unrevoked, unexpired refresh
token; the check is folded into the user load that already ran, so there is no
extra round trip.

Refresh rotation deliberately **carries the session forward** — otherwise
refreshing would sign the caller out, which is worse than the bug being fixed.

Admin suspension of a driver now revokes their sessions in the same
transaction. It deliberately does **not** set `is_active = false`: suspension
bars a driver from taking rides, not from signing in to see that they are
suspended.

**Tokens with no `sid` are refused** — fail closed. The cost is one forced
re-login; the alternative is preserving an unrevocable token class.

**Proved non-tautological** by disabling the session check and confirming the
suite reproduces the original bug: `expected 401 "Unauthorized", got 200 "OK"`.

## Third-pass verdict

| Area | Status | Change |
|---|---|---|
| Rate limiting | **PASS (policy)** | S-7 closed; still never run against real Redis |
| Health probe availability | **PASS** | verified live, 400 requests |
| Session revocation | **PASS (logic)** | S-3 closed; migration 0006 never applied to a real DB |
| Admin session revocation | **FIXED** | was S-3/S-10 |
| SQL injection | PASS | unchanged |
| Secrets in repo | PASS | unchanged |
| PII in logs / audit / fixtures | PASS | unchanged |
| IDOR / row-level auth | PASS | unchanged |
| Security headers | PASS | unchanged |
| CORS | PASS | unchanged |
| Input validation | PASS | unchanged |
| WebSocket authorization | **PARTIAL** | still zero automated tests for the realtime layer |
| Audit log integrity | **PARTIAL** | append-only trigger still never executed |
| Race conditions | **PARTIAL** | still proved against a fake Redis only — D-2, the one P0 |

**Nothing in this pass was verified against real infrastructure either.** The
two `PASS (…)` rows are qualified for that reason: the decision logic is
proved, the storage layer underneath it is not.

### New defect found while auditing

**D-13 · P2 · open.** A driver who goes OFFLINE while holding an outstanding
offer can still accept it and is silently flipped to `ON_TRIP` — after
`goOffline` has already deleted their Redis presence. The rider then has an
assigned driver with no location to track, and the offer sat with an absent
driver for the full timeout instead of moving to the next candidate.

Recorded rather than fixed: the fix belongs in matching, and changing matching
behaviour while the atomic claim is still unverified against a real Redis (D-2)
trades a known small problem for an unknown larger one. There is a
characterisation test pinning the current behaviour so the fix cannot land
silently.
