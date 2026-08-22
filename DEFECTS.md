# DEFECTS.md

Adversarial audit of what exists, per `AGENT_LOOP_PROMPT.md` PASS 1.

Stance taken: *I did not write this code, I am paid to find reasons it must not
go live, and being agreeable is failure.*

**Severity:** P0 loses money or data · P1 breaks a live ride · P2 degrades ·
P3 debt.

A caveat about this audit that matters more than any single finding: it was
performed by the same agent that wrote the code, in the same session. That is
the weakest possible form of review, and `RUN_AUTONOMOUS.md` says so directly —
an agent's report on its own work is wrong about 23% of the time. Treat the
list below as a starting point for a real review, not as a clean bill of health.

---

## D-1 — Idempotency purge deleted other riders' live keys · **P1 · FIXED**

**File:** `services/api/src/idempotency/idempotency.service.ts`

**What broke:** `purgeExpired` deleted rows matching `key` alone. The primary
key is `(user_id, endpoint, key)`. Keys are client-generated, so two riders can
hold the same key text simultaneously.

**Trigger:** rider A's key `abc` expires. The cleanup job runs. Rider B's *live*
key `abc` is deleted as collateral. Rider B's network drops, their app retries,
the key is gone, and a **second ride is created and a second driver dispatched**.

This is the exact failure CLAUDE.md §5.2 exists to prevent, arriving through the
cleanup job rather than the request path — which is why it survived the original
tests: every idempotency test used one user.

**Fix:** match on the full primary key. Verified by reverting the SQL and
confirming the new regression test fails (`expected 2 to be 1`), then passes
after the fix. The test fake was also changed to model the real `WHERE` clause,
so a fake that "does the right thing regardless of the SQL" can no longer hide
this class of bug.

---

## D-2 — The in-memory Redis is unverified against real Redis · **P0-class RISK · UNRESOLVED**

**Files:** `src/redis/in-memory-redis.ts`, `test/integration/ioredis-conformance.test.ts`

**What this is:** every guarantee about CLAUDE.md §5.1 — including the headline
"exactly one of fifty concurrent drivers wins" — is currently proved **against a
fake Redis written in the same session as the code it verifies**.

The conformance suite exists precisely to detect divergence between the fake and
the real thing, and it is a single shared file so the two cannot drift silently.
But on this host it skipped, because there is no Redis:

```
↓ integration test/integration/ioredis-conformance.test.ts (1 test | 1 skipped)
```

**Why it is filed as P0-class:** if the fake diverges from Redis on `SET NX PX`
semantics, then double-accept protection does not work, and the *tests would
still be green*. That is the worst shape a defect can have. `ACCEPTANCE_CHECKLIST.md`
check 4 calls the consequence "two drivers arriving for the same rider".

**It is a RISK, not a confirmed defect.** The fake was written to match
documented Redis behaviour and the adapter uses the exact mandated command. But
nobody has demonstrated that.

**To resolve:**
```bash
docker compose -f infra/docker-compose.yml up -d redis
TEST_REDIS_URL=redis://localhost:6379 pnpm --filter @rideapp/api test:integration
```
CI (`.github/workflows/ci.yml`) sets `TEST_REDIS_URL` and **fails the build if
the suite skips**, so this closes automatically the first time CI runs.

---

## D-3 — None of the protections are reachable by a client · **P1 · UNFIXED (not built)**

**What exists:** the state machine, the atomic claim, the ledger, the fare
calculator, idempotency — as libraries, with 335 passing tests.

**What does not exist:** the HTTP layer. There are no controllers, no auth
guards, no `RideService`, no matching worker, no WebSocket gateway. `main.ts`
does not exist. **The API does not start.**

**Consequence, stated plainly:** the double-accept protection is real code with
real tests, and there is currently no way for a driver to reach it, because
there is no `POST /rides/{id}/accept`. The correctness core is sound and
unreachable.

This is not a bug in what was written. It is the honest scope statement:
roughly the backend's correctness core is done; the application around it is not.

---

## D-4 — Idempotent response is stored outside the work's transaction · **P2 · UNFIXED**

**File:** `src/idempotency/idempotency.service.ts`

**Trigger:** the process dies between the work committing and the `UPDATE` that
stores the response. The key stays claimed with `response_status IS NULL`.

**Effect:** for up to 24 hours, retries of that key get
`IdempotencyInProgressError` (409) instead of the ride. The ride *does* exist, so
the rider is not charged twice and no second driver is dispatched — the damage is
a confusing error, not a duplicate. That is why this is P2 and not P1.

**Fix:** claim the key in its own committed statement (as now), then run the work
**and** the response store inside one transaction. Signature becomes
`run(db, params, work: (tx) => ...)`. Deferred because no caller exists yet
(see D-3) and changing the shape without a consumer is speculative.

**Mitigation until then:** the rider app should treat a 409 `idempotency-in-progress`
as "fetch `GET /rides/me` and show the live ride".

---

## D-5 — Nothing releases a claim when a ride is cancelled · **P2 · UNFIXED (not built)**

`docs/state-machine.md` specifies that every transition into a `CANCELLED_*`
state releases the Redis claim and the driver's `ON_TRIP` availability.
`RideClaimService.release` exists; **no code calls it on cancellation**, because
the ride service does not exist.

**Self-correcting:** the claim carries a 30s TTL, so the ride frees itself. The
window is bounded and small. Filed so it is not forgotten when T025 is built.

---

## D-6 — Zero-fare settlement fails with a confusing error · **P2 · UNFIXED**

`LedgerService.recordRideSettlement` with `fareIqd = 0` produces one entry of
amount 0, which fails `isBalanced` and raises `UnbalancedLedgerError` — correct
behaviour, misleading message. Reachable only via a tariff configured entirely
to zeros. Should raise a specific "fare must be positive" error instead.

---

## D-7 — The production PgBouncer guard is a weak string match · **P2 · UNFIXED**

`loadConfig` refuses a production `DATABASE_URL` containing `:5432/`. A URL
written `postgres://host:5432` (no trailing slash) or pointed at a
non-default direct port slips through, and CLAUDE.md §3.3 is violated silently
under load. Should parse the URL rather than pattern-match it.

---

## Attack cases constructed, and what each currently shows

`AGENT_LOOP_PROMPT.md` names six. Honest status for each:

| Attack | Status | Evidence |
|---|---|---|
| Double-accept interleaving | Defended, **unit-tested only** | 50 concurrent claims yield exactly one winner; DB also carries `rides_one_active_per_driver_uq` as a second line. Real-Redis check pending (D-2). |
| Unbalanced ledger entries | Defended in depth | Service refuses to emit unbalanced SQL; DB has a deferred constraint trigger; a reconciliation query exists. Trigger itself **never executed** (no Postgres). |
| Driver A reading driver B's data | Defended in the state machine | Actor authorisation is inside the transition, exhaustively tested. **No HTTP layer exists to attack**, so this is unproven end-to-end. |
| Rider A reading rider B's rides | Designed, **not built** | Contract specifies 404-not-403 and a token-derived filter with no widening parameter. No endpoint exists. |
| Float in any money path | Defended | Branded integer type; 6 money columns asserted `BIGINT` against the DDL; commission is integer-only; parts always sum to the whole. |
| PII in logs | Defended | Structural redaction at any depth, coordinates coarsened to ~110 m, 38 tests. **Known hole, asserted in the test suite:** a phone under an unrecognised key name is not redacted. |

---

## What a real reviewer should attack first

1. **The fake Redis.** Run the conformance suite against real Redis. Everything
   about concurrency rests on it.
2. **The migrations.** They have never been executed. Run them up, down, and up
   again on a fresh Postgres before trusting any of the schema-level guarantees
   (append-only triggers, the balance trigger, the partial unique indexes).
3. **The ledger money model.** `DECISIONS.md` D-003 makes `DRIVER_WALLET` mean
   *cumulative earnings*, not *funds held*. If that reading is wrong for the
   business, every wallet figure in the admin panel is mislabelled — which is a
   P0 the moment a driver disputes a balance.
