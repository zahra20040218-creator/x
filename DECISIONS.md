# DECISIONS.md

Decisions taken without asking, as `AGENT_LOOP_PROMPT.md` requires. Each records
the choice, the reasoning, and what would change it.

---

### D-001 — `jose` for JWT and Firebase verification, not `firebase-admin`

**Chose:** verify Firebase ID tokens by checking RS256 signatures against
Google's published JWKS, using `jose`; issue our own tokens with the same
library.

**Why:** `firebase-admin` is a very large dependency that pulls in gRPC and a
Google Cloud client stack, for one function — validating a signed JWT. On a
4-core VPS (CLAUDE.md §3) that is memory and cold-start cost for nothing.

**Risk:** we implement issuer/audience/expiry checks ourselves and must get them
right. Mitigated by keeping the verifier behind a port with a deterministic fake,
so the checks are unit-testable.

**Reverse it if:** Firebase adds a verification step that is not plain JWKS.

---

### D-002 — money is a branded `number`, not `bigint`

**Chose:** `IqdAmount = number & brand`, validated as a safe integer, with
`MAX_IQD = 100,000,000,000`.

**Why:** CLAUDE.md §6.1 mandates `BIGINT` in the database, which is about storage
and is honoured. In TypeScript, `bigint` does not survive `JSON.stringify`, does
not mix with `number` in arithmetic without explicit casts, and would put a
conversion at every boundary — each one a chance to reintroduce a float. A
branded integer keeps arithmetic ordinary while making an unvalidated `number`
un-assignable.

**Guard:** the largest realistic value (a wallet balance) is ~7 orders of
magnitude below `Number.MAX_SAFE_INTEGER`. `assertBpsPrecisionInvariant()` fails
at import if `MAX_IQD` is ever raised past the point where commission arithmetic
stops being exact.

**Reverse it if:** the platform ever handles a currency with subunits, or
balances approach 2^53.

---

### D-003 — the ledger's cash-ride model

**Chose:** a completed cash ride writes

```
DRIVER_CASH_HELD   DEBIT   fare         driver is holding this cash
PLATFORM_REVENUE   CREDIT  commission   omitted entirely when commission is 0
DRIVER_WALLET      CREDIT  earnings     fare - commission
```

**Why:** it nets to zero by construction, and it stays balanced with only two
rows at the shipped default of 0 bps (CLAUDE.md §6.5) — which matters, because
the schema forbids a zero-amount row, so a three-row shape would break at the
default configuration.

**Consequence to be aware of:** `DRIVER_WALLET` therefore reads as *cumulative
driver earnings plus manual adjustments*, not as "money the platform is holding
for the driver". With cash payment the driver already has the money. An operator
reading the admin panel must understand the wallet as an earnings ledger.

**Reverse it if:** the platform starts actually holding driver funds (a real
gateway), at which point the wallet becomes a liability account and this model
needs revisiting before launch, not after.

---

### D-004 — the fare estimate is a floor at settlement

**Chose:** `settle()` recomputes from the odometer distance and takes the
**higher** of that and the original estimate.

**Why:** the rider agreed to a quoted price. Charging less than the quote when
the trip ran short would make every quote a maximum rather than a price, and
drivers would be paid less than they were promised for accepting.

**The alternative** — always charge exactly the quote — is equally defensible
and simpler to explain to riders. This is a business decision recorded as a
technical one, and it is isolated to a single method so it can be changed with
one edit and one test update.

**Flag for the owner:** this is worth an explicit decision before real drivers
use it.

---

### D-005 — `ROAD_DISTANCE_FACTOR = 1.35`

**Chose:** estimate road distance as straight-line × 1.35.

**Why:** CLAUDE.md §3.2 forbids a synchronous routing call in a request handler,
so a quote cannot use a real route. 1.35 is a common approximation for a dense
city.

**This is the least defensible number in the codebase.** Baghdad's river
crossings make it optimistic for some trips and pessimistic for others. It is a
named constant in one file with its own test so that the day real trip data
exists, it can be replaced by a fitted value.

---

### D-006 — an in-memory Redis for unit tests, held to a conformance suite

**Chose:** a `RedisPort` with two implementations, and one shared conformance
suite run against both.

**Why:** CLAUDE.md §10 requires the concurrent case to be tested at 95%.
Driving a true 50-way race against a real Redis from a unit test is slow and
non-deterministic; against an in-process implementation it is exact and
repeatable.

**The obvious objection** — that this proves the fake correct rather than the
system — is why the conformance suite exists and why it is a single shared file.

**Unresolved on this host:** the real-Redis half skipped, because there is no
Redis. See `BLOCKED.md`. This is the most important open item in the repo.

---

### D-007 — 404, not 403, for a ride belonging to someone else

**Chose:** `GET /rides/{id}` returns 404 both when the ride does not exist and
when it exists but belongs to another user.

**Why:** distinguishing them turns the endpoint into an oracle for which ride
ids are real. `ACCEPTANCE_CHECKLIST.md` check 5 is about not leaking other
people's data, and the id itself is data.

---

### D-008 — the counterparty type has no phone field at all

**Chose:** `PublicUser` in the API contract has no `phone` property, rather than
a phone that is filtered out.

**Why:** `ACCEPTANCE_CHECKLIST.md` check 5 asks whether the rider's number is
visible to the driver after the trip. A filter is a line of code someone can
remove; an absent field is a compile error. The only schema carrying a phone is
`Me` (your own) and `AdminDriver` (admin-only).

---

### D-009 — `EXPIRED` re-drives inside one transaction, with a sweeper behind it

**Chose:** `OFFERED → EXPIRED` is immediately followed by `EXPIRED → REQUESTED`
or `EXPIRED → NO_DRIVERS_FOUND` in the same DB transaction, plus a sweeper for
rides left in `EXPIRED` for more than 60s.

**Why:** CLAUDE.md §4 lists `EXPIRED` as a state and requires every transition to
be recorded, so it cannot be skipped. But a ride resting in `EXPIRED` is
invisible to matching, and the rider waits forever. The sweeper covers the only
way that can happen — a worker dying mid-transaction.

---

### D-010 — `run.sh` differs from the listing in `RUN_AUTONOMOUS.md`

**Changed:** `EXIT=$?` became `EXIT=${PIPESTATUS[0]}`.

**Why:** the original assigns the exit status of `tee`, which is the last command
in the pipeline and essentially always 0. The "3 consecutive failures → abort"
guard — one of the three mandatory controls in `RUN_AUTONOMOUS.md` §2 — would
therefore never have fired, and a failing loop would have run all 120 iterations.

This is a change to a file the owner wrote, so it is flagged rather than made
silently. The behaviour now matches what the document says it does.

---

### D-011 — `require-await` disabled in `in-memory-redis.ts`

**Chose:** a file-level eslint disable with an explanatory comment.

**Why:** every method is `async` with no `await` deliberately. Running to
completion with no suspension point is what reproduces Redis's single-threaded
atomicity; adding an `await` to satisfy the rule would insert a microtask
boundary into every read-modify-write and destroy the property the
double-accept tests depend on.

---

### D-012 — integration tests skip rather than fail without their services

**Chose:** `test/integration/*` skips when `TEST_REDIS_URL` / `TEST_DATABASE_URL`
are unset.

**Why:** `make test` must stay runnable on a laptop with no Docker; a suite that
is red for environmental reasons trains people to ignore red.

**The cost, stated plainly:** if CI does not set those variables, these tests
never run anywhere and their absence is silent. The CI workflow must set them.
Until CI exists (T041), **they have run nowhere.**
