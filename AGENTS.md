# AGENTS.md

**The rules for this repository live in [`CLAUDE.md`](CLAUDE.md). Read it
first, in full, whatever tool you are.**

The filename says Claude for historical reasons only. Nothing in it is
specific to one assistant — it is the project's constitution, and it binds
any agent, and any human, touching this code.

This file exists because different tools look for different filenames.
`AGENTS.md` is the cross-tool convention; `GEMINI.md` alongside it points
here too. Neither duplicates the rules, deliberately: two copies of a
constitution is two constitutions, and they drift.

---

## Before you write anything

Read, in this order:

| File | Why |
|---|---|
| **`CLAUDE.md`** | The binding contract. Scope, money rules, concurrency rules, prohibitions. |
| **`DECISIONS.md`** | 23 decisions with their reasoning and their reversal conditions. Several answer questions you are about to ask. |
| **`docs/COMPLETION_MATRIX.md`** | What is actually done, with the command that proves each row. |
| **`BLOCKED.md`** | What cannot be verified on this machine — and read the two CORRECTION notices, which explain how "blocked" was wrong twice. |

---

## The five that get violated most

Every one of these has already been broken once in this repository and had
to be fixed. They are not hypothetical.

1. **Money is `BIGINT`, whole Iraqi Dinars.** Never a float. The ledger is
   append-only and enforced by database triggers — corrections are new
   offsetting entries, never an UPDATE (§6).

2. **Never bypass `RideStateMachine`.** No controller or repository sets
   `ride.status` directly (§4).

3. **Matching claims atomically in Redis** — `SET NX PX`. Never a DB
   read-then-write, never an application mutex (§5.1). This is now proven
   against real Redis; do not regress it.

4. **Never invent an endpoint** that is not in `docs/api-contract.yaml`.
   Change the contract first (§12.1).

5. **Never report work complete when tests fail, and never delete a failing
   test to go green** (§10, §12.8). This repository's documents were wrong
   about their own status three times; the fix each time was to correct the
   document, not the claim.

## The one that is easiest to get wrong quietly

**A feature can be present, tested, and completely unreachable.** This has
happened here more than once: a service registered in no module, a contract
promising endpoints that answered 404, an index built for a sweep nobody
wrote, a table with a unique constraint that no code ever read.

Before calling something done, check that a real caller reaches it.

---

## Running things on this machine

Docker does not work here. PostgreSQL, PostGIS and Redis run under WSL —
see **`docs/LOCAL_INFRA_WSL.md`**, which also records the two settings that
are not guessable.

```bash
# Flutter and the Android SDK are installed but NOT on PATH.
export PATH="$HOME/flutter/bin:$PATH"

# The integration suite needs REAL_INFRA=1 or it silently skips everything.
export REAL_INFRA=1
export TEST_DATABASE_URL=postgres://rideapp:rideapp@localhost:5432/rideapp_test
export TEST_REDIS_URL=redis://localhost:6379
```

Full verification:

```bash
cd services/api && npx tsc --noEmit && npx eslint src test --max-warnings=0
npx vitest run                                   # 823 unit + e2e
npx vitest run --project integration             # 153, needs REAL_INFRA
cd ../../packages/core && flutter analyze && flutter test   # 327
```

Four Flutter packages: `packages/core`, `apps/aly`, `apps/rider`,
`apps/driver`. `flutter analyze` exits non-zero on an *info*-level lint, so
"no issues found" is the only passing state.

---

## Where the project actually stands

`apps/aly` is the app that ships — one binary, Rider mode and Driver mode,
the mode decided by the server (§1.1). `apps/rider` and `apps/driver` still
exist and still build; retiring them is irreversible after the first Play
upload, so it waits for a human (D-023).

What remains before launch is mostly not code: a lawyer, a Firebase project,
physical devices. `docs/PLAY_LISTING.md` has the rest.
