# PRODUCTION_READINESS.md

> **Dated snapshot.** Written on the date below and kept for the record, not
> maintained. For current state read `docs/COMPLETION_MATRIX.md`, `DECISIONS.md`
> and `BLOCKED.md` — a large amount of what is called blocked or missing here
> was closed on 2026-09-05.


ALY — 2026-08-26.

**ALY is not production ready.** The blockers are listed at the end and none of
them is a matter of opinion.

Status vocabulary, used exactly as defined:
**PROVEN** · **PARTIALLY PROVEN** · **NOT TESTED** · **BLOCKED** · **UNKNOWN**.

A supersedes note: `docs/PRODUCTION_READINESS.md` is the older document from a
previous phase. Where the two disagree, this one is current.

---

## Backend

| Item | Status | Evidence |
|---|---|---|
| Test suite | **PROVEN** | 922/922 against real PostgreSQL 17.11 and Redis 8.0.5 |
| Type checking | **PROVEN** | `tsc --noEmit` clean, `strict: true` |
| Lint | **PROVEN** | `eslint --max-warnings=0` clean |
| Ride state machine | **PROVEN** | single authority; every transition writes an append-only `ride_events` row |
| Atomic claim (§5.1) | **PROVEN** | 20 concurrent drivers, 20 rounds, one winner, real Redis |
| Idempotency (§5.2) | **PROVEN** | 5 retries of one key produce 1 ride, under load |
| Double-entry ledger (§6) | **PROVEN** | append-only enforced by trigger; UPDATE and DELETE both refused |
| Keyset pagination | **PROVEN** | id cursor; the tuple version lost 4 of 6 statement rows |
| Fare negotiation | **PROVEN** | 28 integration tests; disabled by default |
| Server-side capability check (§1.1) | **PROVEN** | 19 tests; full blocker list, not first-failure |
| Realtime dispatch | **PROVEN** | offer reaches the chosen driver's socket, id-bound |
| Reconnect / duplicate / stale offer | **PROVEN** | 18 tests across two files, real infra |
| Subscriber survives a Redis restart | **PARTIALLY PROVEN** | see the honest note under Redis |

---

## Database

| Item | Status | Evidence |
|---|---|---|
| Migrations up | **PROVEN** | 12 applied cleanly on a fresh database |
| Migrations down | **PROVEN** | reverted and re-applied this session |
| Money columns | **PROVEN** | 9 `BIGINT` columns, asserted by test; no float type anywhere |
| Concurrency indexes | **PROVEN** | `rides_one_active_per_driver_uq`, `ride_bids_one_active_per_driver_uq` both exercised under real races |
| Ledger append-only | **PROVEN** | trigger refuses UPDATE and DELETE |
| PgBouncer under load | **BLOCKED** | Docker is not installed on this machine |
| Transaction-pooling compatibility | **PROVEN** | no `LISTEN`/`NOTIFY`, no advisory locks, no session `SET`, no named prepared statements — verified by scan |

---

## Redis

| Item | Status | Evidence |
|---|---|---|
| Real-server conformance | **PROVEN** | fake and real agree on every primitive used |
| Claim serialisation | **PROVEN** | real `SET NX PX`, repeated races |
| Subscriptions multiplexed | **PROVEN** | 225 connections at rest, 225 with 1000 sockets held — the gateway does not open one per socket |
| Subscriber reconnect | **PARTIALLY PROVEN** | 4 tests pass with `CLIENT KILL`, **but they also pass with the fix reverted**, so they do not guard the original defect. The 16-minute soak that produced 215 `subscribe_failed` errors now produces **0** — that is the evidence the fix works, and it is empirical, not unit-tested. |

---

## Mobile

| Item | Status | Evidence |
|---|---|---|
| Static analysis | **PROVEN** | 0 errors across core, rider, driver |
| Test suite | **PROVEN** | core 306, rider 18, driver 6 |
| Design tokens | **PROVEN** | colours, type, spacing, radius, elevation, motion; light and dark |
| Component library | **PROVEN** | 23 components, all states, RTL/LTR, 1.8× text |
| Rider home screen | **PROVEN** *in widget tests* | 21 tests, five stages, both themes, both directions, 1.8×, landscape |
| **Screens using the design system** | **1 of 13** | the other 12 predate it and still ship |
| Release APK / AAB | **PARTIALLY PROVEN** | four valid signed artifacts, `targetSdk 36`, correct Firebase — but built with no `--dart-define`, so they open to the misconfiguration screen. Build-pipeline proof, not shippable output. |
| Real device | **BLOCKED** | no device attached; sign-in has never completed on hardware |
| Maps rendering | **BLOCKED** | no Maps API key |
| iOS build | **BLOCKED** | needs macOS and an Apple Developer account |

---

## Admin

| Item | Status |
|---|---|
| Test suite | **PROVEN** — 11 passing |
| Command centre, live map, KPI engine | **NOT STARTED** |

---

## Security

| Item | Status | Evidence |
|---|---|---|
| No secrets in Git | **PROVEN** | scanned for API keys, private keys, service accounts, tokens — none tracked |
| Sensitive files ignored | **PROVEN** | `google-services.json`, `key.properties` both apps — verified by real path, not filename |
| Server-side authorisation | **PROVEN** | capability check on every driver-scoped call; hiding a button authorises nothing |
| IDOR | **PROVEN** | a rider gets 404, not 403, for another rider's ride — a 404 does not confirm it exists |
| Offer theft | **PROVEN** | a driver not offered a ride cannot accept it |
| No PII in logs | **PROVEN** | no phone numbers, no coordinates, no names; bid amounts also excluded |
| Release endpoint guard | **PROVEN** | a release build with a plaintext or development endpoint refuses to start — 14 tests |
| Firebase App Check | **NOT STARTED** |
| Play Integrity | **BLOCKED** — needs Play Console |

---

## Infrastructure

| Item | Status |
|---|---|
| `docker-compose.yml` | reviewed — PgBouncer transaction mode, pool 25, max clients 1000 |
| Docker | **BLOCKED** — not installed |
| Domain `api.aly.iq` | **NOT STARTED** |
| HTTPS / WSS in production | **NOT TESTED** — localhost and ADB reverse prove nothing about production networking |
| Backup / restore | scripts exist, **NOT TESTED** |

---

## Observability

| Item | Status |
|---|---|
| Structured logging | **PROVEN** — pino, `request_id` on every line |
| Metrics endpoint | exists |
| Error tracking (Crashlytics) | **NOT STARTED** |
| Alerting | **NOT STARTED** |

---

## Testing

| Layer | Count | Status |
|---|---|---|
| Backend | 922 | **PROVEN** against real infrastructure |
| Flutter core | 306 | **PROVEN** |
| Rider / Driver / Admin | 18 / 6 / 11 | **PROVEN** |
| Load — HTTP | run | **PROVEN**, see below |
| Load — WebSocket | run | **PROVEN**, see below |
| Soak, 16 minutes | run twice | **PROVEN** |
| End-to-end on a device | — | **BLOCKED** |

### WebSocket capacity — PROVEN

One connection per VU, authenticated, held for the whole window.

| Connections | Opened | Reached ready | Refused | Dropped |
|---|---|---|---|---|
| 100 | 100 | 100 | 0 | 0 |
| 250 | 250 | 250 | 0 | 0 |
| 500 | 500 | 500 | 0 | 0 |
| 1000 | 1000 | 1000 | 0 | 0 |

At 1000 held sockets: **108 MB** resident, `/v1/health` still 200, every socket
closed cleanly. Redis connections did not move.

A zero-stagger burst is refused by the OS at ~250–450. A **bare `ws` server
with none of this application in it** does *worse* on the same machine (233 at
500, 313 at 1000), so that ceiling is the laptop's loopback accept path, not
ALY. Behaviour in a real reconnect storm on the VPS is **UNKNOWN**.

### Accept latency — investigated, PROVEN

Two soaks reported 161 ms and then 748 ms, which reads as a 4.6× regression.

**The metric was measuring three different requests as one.** A claim race
produces ~1000 accepts of which exactly one wins; `accept_latency_ms` averaged
all of them, so its p95 was always the tail of a *losing* path. The load script
now reports them separately.

Measured directly, no load generator competing (120 rounds):

| Path | p50 | p95 | What it does |
|---|---|---|---|
| claim probe | 1.3 ms | 1.5 ms | one Redis round trip |
| lose_fast | 2.7 ms | 3.2 ms | `SET NX` fails; Postgres never touched |
| win | 6.8 ms | 8.3 ms | full transaction, commits |
| lose_slow | 5.7 ms | 7.0 ms | claim acquired, offer gone, rollback + release |

Over HTTP on an idle machine: lose_fast 71 ms, lose_slow 123 ms — so the
request envelope (auth, guards, rate limiter, network) costs roughly **65 ms**
on top of a path that is single-digit milliseconds.

**Two hypotheses tested and disproved:**

1. *More location throughput starved it.* No — `reportLocation` sleeps 5 s, so
   the rate is fixed. Total requests differed by 4%.
2. *500 live sockets made publishing expensive.* No — an A/B of the identical
   profile with and without 500 held sockets gave 111 ms and 102 ms. The
   sockets made no measurable difference.

**748 ms did not reproduce.** The full 16-minute profile with 500 live sockets,
re-run on the same machine:

| | soak (before fixes) | soak (after fixes) | re-run |
|---|---|---|---|
| accept all p95 | 161 ms | 748 ms | **106 ms** |
| accept lose_fast p95 | — | — | 102 ms |
| accept lose_slow p95 | — | — | 185 ms |
| location ingest p95 | 1996 ms | 311 ms | **137 ms** |
| server errors | 17 | 0 | **0** |
| requests | 35,952 | 37,385 | 37,797 |

**Conclusion.** The accept path is 3–8 ms of work and ~100 ms over HTTP under
the full load profile. 748 ms was a one-off on a machine that was also
recovering from a database and WSL disturbance; it is not a property of the
code, and it is now measured at 106 ms under the same profile. `accept win p95
= 242 ms` is a single sample and is not a percentile.

**Location ingest now meets its target for the first time** — 137 ms against
`p95 < 200`, down from 1996 ms. That came from collapsing 13 sequential Redis
round trips per report to 4.

All latencies remain a **pessimistic floor**: the load generator shares four
cores with the server, PostgreSQL and Redis. None is a measurement of the VPS.

---

## Store readiness

| Item | Status |
|---|---|
| Play Console account | **BLOCKED** |
| Play App Signing | **BLOCKED** |
| Privacy policy, terms, account deletion URLs | **NOT STARTED** |
| Data safety, content rating, store listing | **NOT STARTED** |
| Screenshots, icon | **NOT STARTED** |

---

## Business readiness

| Item | Status |
|---|---|
| Commission model | implemented, configurable, defaults to 0 |
| Driver subscriptions | schema and policy **PROVEN**; no billing, no purchase flow |
| Fare negotiation | **PROVEN** server-side, off by default, no screen |
| Zones | client honours a flag; **no server model** |
| Iraqi regulatory position | documented, **not reviewed by a lawyer** |

---

## Real blockers

Only these. Everything else is work.

1. **No physical device.** Sign-in has never completed on hardware. Nothing
   about the mobile product can be called proven until it has.
2. **No Maps API key.** The rider home is map-first and no map has rendered.
3. **No Play Console.** Blocks App Signing, Play Integrity, App Check, release.
4. **No production domain or TLS.** Blocks HTTPS, WSS, and the endpoint guard
   that refuses to run without them.
5. **No Docker.** Blocks the PgBouncer pool test, which is what the 500-user
   target actually depends on.
6. **Twelve of thirteen screens do not use the design system.** The product a
   user touches is still the pre-system one.
7. **iOS cannot be built here.** Needs macOS and an Apple Developer account.
