# STATUS

**Verified 2026-09-07.** Every number here came from a command run on this
host on that date. Nothing is carried forward from an earlier report.

This file replaces thirteen documents that disagreed with each other and with
the code. They are in `docs/archive/` — kept, because several contain reasoning
worth reading, and none is authoritative any more.

---

## Tests

| Suite | Command | Result |
|---|---|---|
| Backend unit | `pnpm test:unit` | **759 / 759** in 7.3s |
| Flutter core | `flutter test` | **339 / 339** |
| Flutter app (aly) | `flutter test` | **40 / 40** |
| Flutter rider | `flutter test` | **18 / 18** |
| Flutter driver | `flutter test` | **6 / 6** |
| Backend types | `pnpm typecheck` | clean |
| Backend lint | `pnpm lint` | clean |
| Flutter analyze | `flutter analyze` | clean, both packages |
| Backend integration | `pnpm test:integration` | **163 / 163** on REAL Postgres + Redis |
| Backend e2e | `pnpm test:e2e` | **106 / 106** |

**1,431 tests pass in total.**

Integration and e2e were reported for weeks as blocked on Docker. Docker is
indeed not installed — and it was never needed. PostgreSQL 17 and Redis 8.0.5
are running under WSL on this host and answer on 5432 and 6379. The suites
were gated behind `REAL_INFRA=1`, which nobody had set:

```
REAL_INFRA=1 TEST_REDIS_URL=redis://127.0.0.1:6379 TEST_DATABASE_URL=postgresql://rideapp:rideapp@127.0.0.1:5432/rideapp_test pnpm test:integration && pnpm test:e2e
```

The harness prints what it actually touched, and it printed
`[REAL_INFRA=on] postgres=REAL redis=REAL`.

CI already sets `REAL_INFRA: '1'` with Postgres and Redis service containers,
and fails the build if any integration test skips — a skipped concurrency
proof reads as verification, which is worse than a red build. Two gaps in that
job were closed on 2026-09-07: the e2e suite was never run by CI at all, and
the Flutter job detected its packages with `ls a b c d`, which is false when
ANY of the four is missing. Since CLAUDE.md §1.1 has `apps/rider` and
`apps/driver` being merged away, that job would have gone silent the day they
were deleted, announcing "no Flutter packages yet" over 24,000 lines of Dart.
It now finds packages instead of naming them, and fails when it finds none.

## Code

| | |
|---|---|
| Backend | 38,747 lines · 24 test files |
| Flutter (core + aly) | 23,699 lines |
| Admin (Refine) | 2,419 lines |
| Migrations | 16, across 23 tables |
| `any` / `@ts-ignore` / TODO | **0 / 0 / 0** |
| Coverage gates | 70% general, 95% on state machine, matching, ledger |

## What is built and reachable

Phone OTP (Firebase), ride request → dispatch → trip → completion, the atomic
Redis claim, double-entry ledger, driver wallet and subscriptions, capability
gating, disputes, push, realtime, admin panel, **fare negotiation end to end**
(server since migration 0012; the app was wired to it on 2026-09-07).

## What is built and NOT reachable

Nothing known. The negotiation gap — server complete, no Dart client — was the
last one, and it is closed.

## BLOCKED

| What | Why | Decision needed |
|---|---|---|
| Real routing and ETAs | No provider chosen | **Yours**: which provider |
| Reverse geocoding | Same | **Yours**: same choice |
| Maps rendering in-app | No `MAPS_API_KEY` in the build | **Yours**: obtain and inject |
| iOS build | Needs macOS + an Apple Developer account | **Yours**: hardware and account |
| `negotiation_enabled` | Seeded `false`; every negotiation route 404s until an operator turns it on | **Yours**: when to enable |

## Known defects

`DEFECTS.md` is authoritative. The open ones at this date are D-4, D-7, D-6b,
S-3, S-4, D-10, D-12.

## D-2 is closed

The double-accept guarantee (CLAUDE.md §5.1) is no longer designed-and-fake-
tested. `test/integration/real-redis-claim.test.ts` ran against Redis 8.0.5:

- twenty simultaneous drivers, one winner
- never two drivers inside the critical section at once
- a claim released when the work throws, so the next driver can take it
- a driver cannot release a claim they do not hold
- the claim survives for its TTL rather than expiring immediately

`real-negotiation.test.ts` repeats the accept under a stampede on the same
server — its own words: "because once is luck".

What remains unproven is scale, not correctness: this is contention on one
host, not 500 concurrent users on a 4-core VPS.
