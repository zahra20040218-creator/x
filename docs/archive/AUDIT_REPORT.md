# AUDIT_REPORT.md — ALY

> **Dated snapshot.** Written on the date below and kept for the record, not
> maintained. For current state read `docs/COMPLETION_MATRIX.md`, `DECISIONS.md`
> and `BLOCKED.md` — a large amount of what is called blocked or missing here
> was closed on 2026-09-05.


**Audit date:** 2026-08-25
**Auditor:** CTO-level review, this session
**Codebase:** `C:\Users\moaay\Downloads\x` — branch `master`, 47 modified / 20 new files, **no commits made**

---

## How to read this report

Every claim carries one of four labels, and they are not interchangeable:

| Label | Means |
|---|---|
| **PROVEN** | Measured or executed this session. The command and its output exist. |
| **NOT TESTED** | Implemented, never exercised. No opinion on whether it works. |
| **BLOCKED** | Cannot be tested here. The reason is external and named. |
| **FAIL** | Executed and failed. The error is quoted. |

Nothing is promoted to PROVEN by inference. "The code looks right" is NOT TESTED.

---

## 1. Architecture

### As built

| Component | Stack | Location | Lines |
|---|---|---|---|
| Backend API | NestJS 11 · Express 5 · TypeScript strict | `services/api/src` | 18,174 |
| Rider app | Flutter · Dart | `apps/rider/lib` | 1,628 |
| Driver app | Flutter · Dart | `apps/driver/lib` | 2,079 |
| Shared Flutter | models · API client · design system · realtime | `packages/core/lib` | 4,435 |
| Admin | Refine · React · Vite | `apps/admin/src` | 1,779 |
| Infra | Docker Compose — PostGIS, PgBouncer, Redis | `infra/` | — |

**Data stores:** PostgreSQL 17.11 (21 tables, 10 forward + 10 down migrations),
Redis 8.0.5 (driver geo index, atomic claims, rate limiting, pub/sub, BullMQ).

**Request path invariants** (CLAUDE.md §3), all **PROVEN** this session:
- Driver locations are written to Redis only; a background job flushes history.
- No synchronous third-party call in a handler; push and dispatch go through BullMQ.
- 41 HTTP endpoints, each validated with Zod at the boundary.

### Assessment

The backend architecture is sound and unusually well-defended for a codebase this
age: an append-only double-entry ledger with database triggers enforcing it, a
single `RideStateMachine` that every transition passes through, an atomic Redis
claim for dispatch, and idempotency keys on ride creation. These are the four
things that most commonly sink a ride-hailing MVP, and all four are implemented
and tested against real infrastructure.

The mobile side is thin by comparison — 3,707 lines across two apps against
18,174 on the server — and that ratio is the single biggest structural fact in
this report. **Most of what ALY still needs is client-side.**

---

## 2. Existing features — what actually works

**PROVEN** against PostgreSQL 17.11 and Redis 8.0.5 this session (875 backend
tests, 34 files, 0 failures):

| Feature | Evidence |
|---|---|
| Phone OTP auth via Firebase | Token verified against Google JWKS; session issued |
| Ride lifecycle REQUESTED→COMPLETED | State machine, every transition audited to `ride_events` |
| Dispatch to nearest driver | Redis GEO search, offer written, id-bound to the chosen driver |
| Atomic claim — one winner | 20 concurrent drivers, 20 rounds, exactly one win each time |
| Idempotent ride creation | Duplicate key returns the original ride, never a second |
| Double-entry ledger | UPDATE and DELETE refused by trigger; entries balance or the transaction aborts |
| Driver wallet | Derived from entries, never a stored counter |
| Realtime channel | 1000 concurrent WebSockets, correct-driver delivery, no cross-delivery |
| Reconnect and duplicate safety | 18 tests: resync returns one offer, stale accepts refused |
| Rate limiting | Redis-backed, with an in-process fallback when Redis is slow |
| Admin: drivers, rides, top-ups, disputes, fare config | 41 endpoints, RBAC enforced server-side |
| Arabic RTL UI | Verified on a real Samsung SC-53C |

---

## 3. Missing features — ALY scope

Against the ALY brief. **Owner approved all four expansions on 2026-08-25.**

### P0 — blocks commercial launch

| # | Missing | Notes |
|---|---|---|
| M1 | **One app, rider + driver modes** | Two separate apps today. Merged app inherits `iq.rideapp.rideapp_rider`; driver package retired. |
| M2 | **Fare negotiation / driver offers** | Replaces nearest-driver dispatch. Largest server change: new state machine states, offer table, bid lifecycle. |
| M3 | **Server-side mode authorization** | Mode switching must be RBAC-gated on approval, documents, vehicle, subscription, suspension. Never a client flag. |
| M4 | **Driver onboarding + approval workflow** | `driver_documents` exists; upload path and approval queue do not. |
| M5 | **Rider map, pickup, destination** | `request_ride_screen.dart` exists; place search and saved addresses do not. |
| M6 | **Legal URLs** | Privacy, Terms, Account Deletion, Support. Play will not accept a listing without them. |

### P1 — serious

| # | Missing |
|---|---|
| M7 | Driver subscriptions — plans, billing cycle, expiry blocking online status |
| M8 | Identity verification (national ID / licence capture) |
| M9 | Vehicle registration and document expiry tracking |
| M10 | Rider complaints and support channel (disputes exist; no client surface) |
| M11 | Favourite / saved addresses |
| M12 | Driver statistics beyond the earnings screen |
| M13 | iOS target — see §11 |

### P2 — important

| # | Missing |
|---|---|
| M14 | Emergency features (out of original scope; not selected for this phase) |
| M15 | In-app navigation handoff beyond the Google Maps deep link |
| M16 | Analytics events |
| M17 | Crashlytics |

---

## 4. Broken features — found and fixed this session

### D1 · Realtime channel collapsed under load — **P0, FIXED, PROVEN**

A 16-minute soak (500 held WebSockets + 200 drivers reporting location + 120
rides/minute) logged `realtime.subscribe_failed` **215 times against 500
clients**. Every one was a driver refused a realtime channel.

```
Connection in subscriber mode, only subscriber commands may be used
  at EventEmitter._readyCheck (ioredis/built/Redis.js:655)
```

**Root cause:** `ensureSubscriber()` builds the pub/sub connection with
`duplicate()`, which copies the parent's options — including
`enableReadyCheck: true`. The ready check works by issuing `INFO`. A connection
holding a subscription is in subscriber mode, where Redis refuses `INFO`.
ioredis surfaces it as a connection error, every in-flight `subscribe()`
rejects, and the gateway closes those sockets with 4500. **One Redis hiccup
disconnected every driver trying to come online.**

**Fix:** `enableReadyCheck: false` on the subscriber connection
(`services/api/src/redis/ioredis-adapter.ts`).

**Proof — same soak, same profile, after the fix:**

| | before | after |
|---|---:|---:|
| sockets reaching `ready` | 285 / 500 | **500 / 500** |
| `realtime.subscribe_failed` | 215 | **0** |
| dropped after authenticating | 0 | 0 |

**Honest limit:** a targeted regression test (`real-redis-subscriber-reconnect.test.ts`,
4 tests, real Redis, `CLIENT KILL TYPE pubsub`) passes **with and without** the
fix — it could not reproduce the failure in isolation, so it does not guard this
bug. The proof above is empirical at soak scale, not a unit test. Treated as
**fixed but not regression-guarded**; see O3.

### D2 · Location ingest saturating Redis — **P0, FIXED, PROVEN**

`recordBatch` awaited each Redis command in sequence: N × `rPush` in a loop,
then `geoAdd`, `zAdd`, and `writeLastKnown` — which itself issued **six
sequential `hSet` calls on one key**. A five-sample batch cost **13 sequential
round trips**, for every online driver, every few seconds.

**Fix:** collapse the `rPush` loop into one varargs call; add `hSetMany` to
`RedisPort` and both implementations; `writeLastKnown` now writes one `HSET`.
13 round trips → 4.

**Proof, same soak profile:**

| | before | after |
|---|---:|---:|
| location ingest p95 | 1996 ms | **311 ms** |
| http_req_duration p95 | 1886 ms | **336 ms** |
| server errors (5xx) | 17 | **0** |
| `ratelimit.unavailable` | 686 | 219 |

Still misses the <200 ms target under combined load — see O1.

### D3 · Earlier fixes, carried forward from this session

| Defect | State |
|---|---|
| Sign-in screen overflowed on landscape / keyboard / large font | FIXED — 10 regression tests |
| Ride dispatch never reached any driver | FIXED — id-bound delivery proven 5/5 |
| Wallet pagination silently dropped 4 of 6 ledger rows | FIXED — real-Postgres tests |
| Any WebSocket client could crash the API | FIXED |
| FCM client registration was dead | FIXED |

---

## 5. Security

### Verified clean — **PROVEN**

| Check | Result |
|---|---|
| API keys, private keys, tokens in tracked files | none |
| Secret files tracked by git | none |
| `google-services.json` ×2, `key.properties` ×2 | present, correctly ignored via nested `.gitignore` |
| Service-account JSON | outside the repository |
| Phone numbers | test block only; no real numbers |
| Authorization | server-side; a driver cannot accept another driver's offer (404, not 403 — no existence disclosure) |
| Channel authorisation | keyed on the token; a client cannot name its own channel |
| Ledger | append-only, enforced by trigger, not by convention |
| Release endpoint guard | a release build with no `--dart-define` refuses to start rather than shipping aimed at a dev server |

### Findings

| # | Severity | Finding |
|---|---|---|
| S1 | **P0** | **Mode switching must be server-authorised.** The merged app makes this the central security boundary: approval, documents, vehicle, subscription and suspension all have to be checked server-side on every driver-scoped call. A client-side mode flag would let any rider dispatch themselves rides. |
| S2 | P1 | No Firebase App Check / Play Integrity. Any HTTP client can call the API with a valid token. |
| S3 | P1 | Rate limiter falls back to in-process counters when Redis is slow — 219 times in a 16-minute soak. Per-instance limits are weaker than global ones. |
| S4 | P2 | No document-storage encryption strategy yet for KYC uploads (M4/M8). |

---

## 6. Scalability — **measured, not estimated**

Run on **one Windows laptop** with the load generator, API, PostgreSQL and Redis
sharing four cores. Every latency is a pessimistic floor.

### WebSocket capacity — **PROVEN**

| Connections | Opened | Reached `ready` | Refused | Server RSS |
|---:|---:|---:|---:|---:|
| 100 | 100 | 100 | 0 | 96 MB |
| 250 | 250 | 250 | 0 | 98 MB |
| 500 | 500 | 500 | 0 | 105 MB |
| **1000** | **1000** | **1000** | **0** | **108 MB** |

Redis connections did not move — 225 at rest, 225 with 1000 sockets. The gateway
multiplexes every subscription over one shared subscriber connection. **Redis is
not the ceiling.**

Time to `ready`: 5 ms p50, 18 ms p95 at 1000 connections.

### Burst — **rig-limited, not server-limited**

With zero stagger, some dials are refused by the OS. A **bare `ws` server with
none of this application in it** was given the same burst and did *worse*
(500 VUs: 233 opened vs our 289–450). The limit is the loopback accept path on
this machine. Behaviour in a real reconnect storm needs the VPS — **NOT TESTED**.

### Soak, 16 minutes — **PROVEN after fixes**

500 held sockets + 200 drivers reporting location + 120 rides/min:
0 crashes · 0 dropped authenticated sockets · 0 × 5xx · health 200 throughout ·
memory rose to 227 MB, collected, settled at 164 MB — **no leak** ·
exactly 1 claim winner · 0 duplicate rides.

---

## 7. Performance — open items

| # | Item | Measured | Target |
|---|---|---:|---:|
| O1 | Location ingest p95 under soak | 311 ms | < 200 ms |
| O2 | `accept` p95 **regressed** under soak | 161 → **748 ms** | — |

**O2 is a real regression and is not explained.** It appeared in the same run
that fixed everything else. The likely reading is that 500 sockets now stay
connected where 285 did before, so more work genuinely completes — but that is a
hypothesis, not a measurement. It must be isolated before launch.

---

## 8. Database

**Sound.** 21 tables, 10 reversible migration pairs, forward-only discipline.

| Property | State |
|---|---|
| Money columns | `BIGINT`, whole dinars, verified by a test that inspects `information_schema` |
| Ledger append-only | UPDATE and DELETE refused by trigger — **PROVEN** |
| Balanced entries | DEFERRABLE constraint trigger rejects unbalanced transactions at COMMIT |
| Keyset pagination | id-resolved cursor; the microsecond-truncation bug is fixed and tested |
| Unique constraints | `ride_offers (ride_id, driver_id)`, one active ride per rider and per driver |
| Indexes | composite `(status, created_at)`, GiST on geometry, partial index on pending offers |

**Gap:** PgBouncer is configured (transaction pooling, pool 25, max clients
1000) and the code is **statically verified compatible** — no `LISTEN/NOTIFY`,
no advisory locks, no session `SET`, no named prepared statements. Runtime
behaviour under load is **BLOCKED**: Docker is not installed on this machine.

---

## 9. UX and UI

| # | Severity | Finding |
|---|---|---|
| U1 | P0 | Rider has no place search. Pickup and destination are the core interaction. |
| U2 | P0 | No onboarding for drivers — the approval state is invisible in the app. |
| U3 | P1 | Driver app has 6 screens; a commercial driver app needs earnings breakdown, document status, subscription state. |
| U4 | P1 | 68 uses of `dynamic` in Dart — `very_good_analysis` forbids it in public APIs. |
| U5 | P2 | Only 3 Flutter test files across both apps against 34 on the server. |

---

## 10. Testing

| Layer | Files | Tests | State |
|---|---:|---:|---|
| Backend | 34 | **875** | PROVEN against real PostgreSQL + Redis |
| Shared Flutter | 11 | 132 | PROVEN |
| Rider | 2 | 18 | PROVEN |
| Driver | 1 | 6 | PROVEN |
| Admin | 1 | 11 | PROVEN |

`flutter analyze`: 0 errors, 0 warnings across all three packages.
`tsc --noEmit` and `eslint --max-warnings=0`: clean.

### Gaps

| # | Gap |
|---|---|
| T1 | **Real-device E2E never completed.** Sign-in was entered and the device went offline before submission. Login, D3 and D5 on hardware are **BLOCKED**, not failed. |
| T2 | Driver background location for 30 minutes with the screen off, while moving — the §5.3 test, and the most common cause of production failure in this category. **BLOCKED** on a physical phone. |
| T3 | Flutter widget coverage is 24 tests against 3,707 lines. |
| T4 | No test guards D1 (see O3). |

---

## 11. Deployment

| Item | State |
|---|---|
| Android release pipeline | **PROVEN** — signed APK and AAB for both apps, `targetSdk 36` |
| Artifacts point at production | **NO.** Built without `--dart-define`, so the guard stops them at the misconfiguration screen. They prove the pipeline, they are **not shippable**. |
| Domain `api.aly.iq` / TLS / WSS | **BLOCKED** — does not exist |
| iOS | **BLOCKED** — requires macOS and an Apple Developer account ($99/yr); neither is available here. The Flutter source can be made iOS-ready; the build cannot happen on this machine. |
| Play Console | **NOT STARTED** |
| Docker / PgBouncer | **BLOCKED** — Docker not installed |

---

## 12. Technical debt

| # | Item | Count |
|---|---|---:|
| TD1 | `dynamic` in Dart | 68 |
| TD2 | TODO / FIXME / HACK | 10 |
| TD3 | `any` / `@ts-ignore` in TypeScript | 1 |
| TD4 | Duplicated sign-in screen between the two apps | resolved by M1 |
| TD5 | `docs/BLOCKERS.md` is stale — claims migrations never ran and Flutter is not installed; both are false | — |

---

## 13. Recommended architecture for ALY

**Keep** the backend as-is. Its invariants are the asset. Extend, do not rewrite.

**Change:**

1. **One Flutter app**, `apps/aly`, with a `Mode` enum and a server-issued
   capability set. The client renders what the server says it may do; it never
   decides.
2. **Fare negotiation** as a new aggregate — `ride_bids` — alongside the ride
   state machine rather than inside it. Nearest-driver dispatch stays as the
   fallback path when nobody bids.
3. **Subscriptions** as ledger accounts, not a new money system. A subscription
   charge is two entries like everything else.
4. **Capability endpoint** — `GET /v1/me/capabilities` returns the authoritative
   list. Mode switching, driver endpoints and the UI all read from it.

---

## 14. Priority classification

### P0 — blocks launch

| | Item | State |
|---|---|---|
| P0-1 | One app with server-authorised modes | to build |
| P0-2 | Fare negotiation and driver offers | to build |
| P0-3 | Driver onboarding and approval | to build |
| P0-4 | Rider place search / destination | to build |
| P0-5 | Real-device login → D3 → D5 | **BLOCKED** — device |
| P0-6 | 30-minute screen-off location test | **BLOCKED** — phone |
| P0-7 | Domain, HTTPS, WSS | **BLOCKED** — no domain |
| P0-8 | Legal URLs and Play listing | **BLOCKED** — owner |
| P0-9 | Production-pointed release build | blocked by P0-7 |

### P1 — serious

O1 location p95 · O2 accept regression · O3 no guard for D1 · S1 mode
authorisation tests · S2 App Check · M7 subscriptions · M8/M9 identity and
vehicle · PgBouncer under load

### P2 — important

M10 complaints · M11 saved addresses · M12 driver statistics · U3 driver screens
· TD1 `dynamic` · TD5 stale blockers doc

### P3 — improvement

Analytics · Crashlytics · in-app navigation · Flutter widget coverage

### P4 — future

Emergency features · multi-city · multiple vehicle classes · surge

---

## 15. The honest summary

The server is in good shape and is now, after two fixes made this session,
measurably able to hold 1000 concurrent realtime connections and survive a
16-minute soak with zero errors. That was not true this morning: 215 of 500
drivers were being refused a realtime channel, and location ingest was ten times
its target.

What is not in good shape is everything a passenger or driver actually touches.
3,707 lines of Flutter across two apps is a demo surface on top of a commercial
backend, and the ALY brief asks for roughly three times that.

**The two things that could still invalidate a launch date, and neither is code:**

1. **No real-device test has ever completed.** Login has never succeeded on
   hardware. Until it does, every mobile claim in this report is inference.
2. **The 30-minute screen-off location test has never run.** It is the single
   most common cause of ride-hailing failure in production, and no emulator or
   widget test substitutes for it.

**Nothing in this report should be read as "production ready".** Nothing is.
