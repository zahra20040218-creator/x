# RATE_LIMIT_POLICY.md

What every endpoint is limited to, and — the part that matters — what happens
to it when Redis is unreachable.

**Status: PARTIAL.** The policy below is implemented and covered by 23 unit
tests plus 6 over HTTP. It has **never run against a real Redis** (BLOCKER-3),
so what is proved is the decision logic, not the counter.

---

## The problem this replaced

The first implementation failed **open** for every endpoint: if Redis was
unreachable, every request was allowed. That was one policy applied to two
situations that want opposite answers.

Failing open on `POST /driver/location` is correct — blocking it would stop an
in-progress ride from tracking.

Failing open on `POST /auth/otp/verify` is not. That endpoint is
unauthenticated by necessity, every call costs a real Firebase verification,
and it doubles as a phone-number enumeration oracle. Under the old policy, a
Redis blip removed **all** protection from it, and an attacker who could cause
or simply wait for that blip got an unmetered oracle. Recorded as **S-7**.

Failing **closed** everywhere is not the answer either: it makes Redis a hard
single point of failure, so a limiter that cannot count becomes "nobody in
Baghdad can request a ride" — a far larger incident than unthrottled OTP.

---

## The three tiers

Every `@RateLimit` **must** declare a tier. There is no default, because
choosing a limit without stating what the endpoint protects is exactly how OTP
verification ended up sharing a failure policy with a location ping.

| Tier | What it means | Redis down |
|---|---|---|
| `CRITICAL` | Auth, token issuance, money movement, admin mutation | **degrade** |
| `STANDARD` | Ride lifecycle, ratings, profile writes | **degrade** |
| `OPERATIONAL` | High-frequency polling and location | **allow** |
| *(exempt)* | `@NoRateLimit()` — health probes only | never limited |

**Degrade** means: fall back to an in-process fixed-window counter at
`ceil(limit / RATE_LIMIT_LOCAL_DIVISOR)`.

### Why degrade rather than deny

The in-process counter is per-instance, so N instances permit N× the local
limit. That is worse than Redis and is not pretended otherwise — it is why
`RATE_LIMIT_LOCAL_DIVISOR` exists and why its documentation says *set it to
your instance count*. With the default of 4 and four instances, OTP
verification during a Redis outage allows ~12/min against an intended 10/min.

A control that is 4× too generous for the duration of an outage is a very
different thing from **no control at all**, which is what shipped before.

### Why health checks are exempt

A load balancer that receives 429 from a liveness probe removes the instance
from the pool. A rate limiter firing on `/health` would therefore take a
perfectly healthy process out of service — the limiter causing the outage it
exists to prevent. Probes also come from a handful of infrastructure IPs at a
fixed rate, so they are the case most likely to fill an IP-keyed bucket and
least likely to indicate abuse.

---

## Per-endpoint table

| Method | Path | Limit | Key | Tier |
|---|---|---|---|---|
| POST | `/auth/otp/verify` | 10 / 60s | ip | **CRITICAL** |
| POST | `/auth/refresh` | 30 / 60s | ip | **CRITICAL** |
| POST | `/payments/webhook/:provider` | 120 / 60s | ip | **CRITICAL** |
| POST | `/rides/:rideId/complete` | 60 / 60s | user | **CRITICAL** |
| POST | `/admin/drivers` | 30 / 60s | user | **CRITICAL** |
| PATCH | `/admin/drivers/:driverId` | 60 / 60s | user | **CRITICAL** |
| POST | `/admin/drivers/:driverId/wallet/topup` | 30 / 60s | user | **CRITICAL** |
| PUT | `/admin/config` | 30 / 60s | user | **CRITICAL** |
| POST | `/admin/disputes/:disputeId/resolve` | 60 / 60s | user | **CRITICAL** |
| POST | `/fare/estimate` | 60 / 60s | user | STANDARD |
| POST | `/rides` | 20 / 60s | user | STANDARD |
| POST | `/rides/:rideId/accept` | 60 / 60s | user | STANDARD |
| GET | `/rides/:rideId` | 120 / 60s | user | OPERATIONAL |
| GET | `/driver/offers/current` | 60 / 60s | user | OPERATIONAL |
| POST | `/driver/location` | 120 / 60s | user | OPERATIONAL |
| GET | `/health`, `/health/ready` | — | — | **exempt** |
| *(everything else)* | | 300 / 60s | user-or-ip | STANDARD |

### Notes on the non-obvious ones

**`/rides/:rideId/complete` is CRITICAL, not STANDARD.** Completion settles the
fare and writes ledger entries. Every other ride transition is STANDARD; this
one moves money.

**`/payments/webhook/:provider` is CRITICAL despite being public.** The
signature check is the real control. The limit bounds how often an attacker can
make the server perform one.

**The default tier is STANDARD, not OPERATIONAL.** An undeclared route is one
nobody has classified, and defaulting it to the fail-open tier would mean
"forgot to think about it" silently produces the weakest behaviour.

---

## Bounded fallback

The in-process table is bounded in both dimensions:

- **Across time** — the whole table is dropped when the window rolls over.
  With fixed windows every previous-window entry is already dead, so a clear is
  both the cheapest and the most complete eviction, and removes the need for a
  sweeper that could itself leak.
- **Within a window** — capped at `localMaxKeys` (20,000). Reaching it means a
  very large number of distinct identities inside 60 seconds *while Redis is
  down*, which is an attack shape rather than traffic. At that point the
  limiter cannot account for new identities, and a tier that asked to degrade
  does not get waved through: it **refuses**, and logs
  `event: ratelimit.local_saturated` at `error`.

**The cost of that choice, stated plainly:** a distributed key-explosion attack
occurring *simultaneously* with a Redis outage will deny CRITICAL and STANDARD
endpoints to legitimate users. That is accepted — the alternative is an
unmetered auth endpoint under exactly the conditions an attacker would choose.

## Redis timeout

`RATE_LIMIT_REDIS_TIMEOUT_MS` (default 50ms) bounds how long the limiter waits.
This matters more than it looks: ioredis **queues** commands while disconnected
rather than rejecting them, so without a timeout a Redis that is *hung* rather
than *refused* would add its full latency to every single request — the limiter
turning a Redis problem into an API-wide latency problem. A timeout is treated
exactly like a refusal, and there is a test that asserts the tier policy is
applied to a hung Redis, not only a refused one.

## Observability

| Event | Level | Meaning |
|---|---|---|
| `ratelimit.exceeded` | info | Normal rejection, Redis working |
| `ratelimit.unavailable` | warn | Redis unreachable; carries `policy` and `decision` (`allowed` / `degraded` / `rejected`) |
| `ratelimit.local_saturated` | error | Fallback table full; requests being refused |

The caller identity is **never** logged. For an unauthenticated endpoint it is
an IP address, and CLAUDE.md §9 treats caller-identifying data as PII.

## Verification

```bash
cd services/api && npx vitest run src/http/rate-limit.test.ts   # 23 pass
cd services/api && npx vitest run test/e2e/api.e2e.test.ts      # includes 6 HTTP-level cases
```

The tier table was proved non-tautological by reverting `CRITICAL` to `allow`
and confirming the suite fails with `expected 30 to be 3` — i.e. the endpoint
becoming unlimited is detected, not assumed.

**What is still unproven:** every one of these tests runs against the in-memory
Redis fake. The counter itself — `INCR` plus `PEXPIRE` under real concurrency —
has never executed against a real Redis. See BLOCKER-3.
