# TASKS.md

Ordered checklist. Each task is completable in under 45 minutes and is
independently testable. Nothing here is outside CLAUDE.md §2 scope.

Format is fixed — the loop parses it:
`- [ ] T001 | <area> | <one-line description> | depends: T000`

Markers: `[ ]` todo · `[x]` done, tests green · `[BLOCKED]` see BLOCKED.md

---

## Foundation

- [x] T001 | infra | pnpm workspace, TS strict base config, eslint, vitest harness | depends: -
- [BLOCKED] T002 | infra | forward-only SQL migration runner with up/down and a fresh-DB test | depends: T001
- [BLOCKED] T003 | db | migration 0001: enums, users, drivers, riders, platform_config seed | depends: T002
- [BLOCKED] T004 | db | migration 0002: rides, ride_events, ride_offers, all §3.4 indexes | depends: T003
- [BLOCKED] T005 | db | migration 0003: ledger_entries, append-only triggers, balance trigger, wallet view | depends: T003
- [BLOCKED] T006 | db | migration 0004: payments, idempotency_keys, location history, ratings, topups, disputes, refresh_tokens | depends: T004,T005

## API core

- [x] T007 | api-core | Zod-validated env config loader; pino logger with request_id and PII redaction | depends: T001
- [x] T008 | api-core | RFC 9457 problem+json exception filter and Zod validation pipe | depends: T007
- [BLOCKED] T009 | api-core | PgBouncer-safe pg pool wrapper with hard cap and transaction helper | depends: T002,T007
- [x] T010 | api-core | Redis port, ioredis adapter, in-memory adapter, shared conformance suite | depends: T007
- [x] T011 | money | IQD whole-integer value type and guards; no float on any money path | depends: T001

## Money

- [x] T012 | ledger | LedgerService: balanced transaction writer, append-only, derived wallet balance | depends: T005,T009,T011
- [x] T013 | config | PlatformConfigService with cache; commission_bps default 0, changeable without deploy | depends: T009
- [x] T014 | fare | FareCalculator as a pure function over whole IQD with round-up-to-multiple | depends: T011,T013

## Auth

- [x] T015 | auth | Firebase ID token verifier port plus a deterministic fake for tests | depends: T007
- [x] T016 | auth | phone normalisation 07XXXXXXXXX to +9647XXXXXXXXX with E.164 validation | depends: T001
- [x] T017 | auth | POST /auth/otp/verify, JWT issue, refresh rotation, logout | depends: T015,T016,T009
- [x] T018 | auth | JWT guard, role guard, and ride-ownership guard | depends: T017

## Ride lifecycle

- [x] T019 | rides | RideStateMachine: transition table, actor guards, ride_events append, 409 on invalid | depends: T004,T009
- [x] T020 | rides | idempotency layer: key to stored response, 24h TTL, body-mismatch 409 | depends: T006,T009
- [x] T021 | rides | POST /rides, GET /rides/me, GET /rides/{id} with per-caller visibility | depends: T019,T020,T014,T018
- [x] T025 | rides | arrived, start, and cancel endpoints through the state machine | depends: T019,T018
- [x] T026 | rides | complete: fare settlement, payment row, and ledger entries in one DB transaction | depends: T012,T014,T019
- [x] T033 | rides | rating endpoint, one per rater per ride | depends: T026

## Matching

- [x] T022 | matching | Redis driver presence: GEOADD/GEOSEARCH, TTL heartbeat, online/offline | depends: T010,T018
- [x] T023 | matching | atomic claim SET NX PX 30000 and the accept endpoint; exactly one winner | depends: T019,T022
- [x] T024 | matching | offer worker: nearest candidate, timeout, EXPIRED to REQUESTED, NO_DRIVERS_FOUND | depends: T023

## Payments

- [x] T027 | payments | PaymentProvider interface, CashProvider implemented, GatewayProvider stub | depends: T012
- [x] T028 | payments | webhook pure function (payload, signature) to LedgerCommand[], unit-tested, thin HTTP wrapper | depends: T027

## Async and realtime

- [x] T029 | queue | BullMQ setup, FCM push worker, maps worker; no synchronous external call in a handler | depends: T010,T007
- [x] T030 | location | POST /driver/location accepts a batch and writes to Redis only | depends: T022
- [BLOCKED] T031 | location | 30s batch flush job from Redis to Postgres history | depends: T030,T009
- [x] T032 | realtime | WebSocket gateway with token-derived channels only, no client-named channel | depends: T018,T019

## Admin

- [x] T034 | admin | admin authentication and driver CRUD | depends: T018
- [x] T035 | admin | ride list and detail, disputes, fare config, wallet top-up with idempotency | depends: T034,T012,T013

## Flutter

- [BLOCKED] T036 | flutter-core | packages/core: models, API client, design system, IQD and RTL formatting | depends: T021
- [BLOCKED] T037 | flutter-rider | rider app: auth, map, estimate, request, live track, complete, rate | depends: T036
- [BLOCKED] T038 | flutter-driver | driver app: online toggle, offer sheet, accept, navigation deep-link, complete | depends: T036
- [BLOCKED] T039 | flutter-driver | background location: foreground service, Doze exemption flow, offline buffer, flush | depends: T038

## Admin web

- [x] T040 | admin-web | Refine admin panel screens over the admin API | depends: T035

## Verification

- [x] T041 | ops | CI pipeline with coverage gates per CLAUDE.md §10 | depends: T001
- [x] T042 | e2e | one happy path plus three failure paths: network drop, driver declines, no drivers | depends: T024,T026
- [BLOCKED] T043 | perf | load test at 500 concurrent users against the matching and ride paths | depends: T024,T026
- [x] T044 | security | adversarial security audit against CLAUDE.md §12 with concrete attack cases | depends: T035,T032
