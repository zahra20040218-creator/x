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
| Flutter app | `flutter test` | **40 / 40** |
| Backend types | `pnpm typecheck` | clean |
| Backend lint | `pnpm lint` | clean |
| Flutter analyze | `flutter analyze` | clean, both packages |

Backend integration and e2e need Docker, which is **not installed on this
host**. They are unverified here — not failing, unrun. See BLOCKED below.

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
| Integration + e2e suites | Docker not installed on this host | Install Docker, or run them in CI |
| Real routing and ETAs | No provider chosen | **Yours**: which provider |
| Reverse geocoding | Same | **Yours**: same choice |
| Maps rendering in-app | No `MAPS_API_KEY` in the build | **Yours**: obtain and inject |
| iOS build | Needs macOS + an Apple Developer account | **Yours**: hardware and account |
| `negotiation_enabled` | Seeded `false`; every negotiation route 404s until an operator turns it on | **Yours**: when to enable |

## Known defects

`DEFECTS.md` is authoritative. The open ones at this date are D-4, D-7, D-6b,
S-3, S-4, D-10, D-12.

## The one unresolved P0-class risk

`DEFECTS.md` D-2: the in-memory Redis fake has never been checked against a
real Redis, so the double-accept guarantee is designed and unit-tested rather
than verified under contention. This is the single thing most worth proving
before real money moves through the system.
