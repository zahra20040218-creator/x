# Load testing

k6. `services/api/test/load/matching.load.js`.

---

## Running it

The script needs tokens and a race ride. `pnpm seed` does not mint them, so:

```bash
pnpm --filter @rideapp/api build

# 400 drivers, 60 riders, tokens, and one OFFERED ride with a PENDING offer
# to every driver.
node services/api/scripts/load-fixtures.mjs > fixtures.json

node services/api/dist/main.js      # API
node services/api/dist/worker.js    # worker — dispatch happens here

DRIVERS=400 RIDES_PER_MINUTE=120 RACERS=20 DURATION=5m \
K6_DRIVER_TOKENS=... K6_RIDER_TOKENS=... K6_RACE_RIDE_ID=... \
k6 run services/api/test/load/matching.load.js
```

**Regenerate fixtures before every run.** The race ride is consumed once won —
a second run against the same fixture legitimately reports zero winners, which
looks like a failure and is not.

---

## What the thresholds mean

| Threshold | Why |
|---|---|
| `claim_wins: count==1` | Exactly one driver may win the raced ride. Two is CLAUDE.md §5.1 broken and two drivers sent to one rider. |
| `duplicate_rides_created: count==0` | §5.2 idempotency under retry. |
| `server_errors: count==0` | Any 5xx. |
| `location_ingest_ms: p95<200, p99<500` | §3.1 — if this is slow, a Postgres write has crept onto the request path. |

**`http_req_failed` is deliberately absent.** This script generates 4xx by
design: every losing racer gets a 409, and so does a rider who already holds an
active ride. A blanket `rate<0.01` fails a completely healthy run, and a
threshold that is always red is a threshold nobody reads.

Two earlier versions of this file were unfalsifiable. `double_accepts` was fed
by `doubleAccepts.add(0)` — a counter that could only ever be zero. And the
fixture built a `REQUESTED` ride, which the state machine cannot transition to
`ACCEPTED`, so every accept failed with 409 and the run reported 100 tidy losses
and no winner. Both looked like passes.

---

## Results, 2026-08-24

k6 v0.54.0. API, PostgreSQL 17.11, Redis 8.0.5 and the load generator **all on
one Windows laptop**.

400 driver VUs at 5s intervals, 120 rides/min each retried with the same
idempotency key, 20 drivers racing one ride, 5 minutes.

### Correctness — the part that transfers

| | |
|---|---|
| Claim race | **1 win, 961 losses.** Never two. |
| Idempotency | **0 duplicate rides** across 600 retried pairs. |
| Claim rollback | 38 accepts whose transaction failed released their claim rather than leaking it. A leaked claim blocks that ride for its full 30s TTL. |

### Pool size — measured twice, and the second time disagrees

Re-measured after ride dispatch moved into the worker. Same profile, 400
drivers, 5 minutes:

| | pool = 10 | pool = 50 |
|---|---:|---:|
| server errors (5xx) | **0** | **0** |
| p50 | 44 ms | 45 ms |
| p95 | 299 ms | 262 ms |
| max | 1201 ms | 638 ms |
| location ingest p95 | 324 ms | 270 ms |
| claim race | 1 win / 947 losses | 1 win / 944 losses |
| duplicate rides | 0 | 0 |

**The earlier 8 × HTTP 500 at pool=10 no longer reproduces, and that is not a
contradiction.** It was measured while dispatch ran inside the request path.
Dispatch now runs in the worker against the worker's own pool, so the API's ten
connections are no longer competing with it. The pool still shows in the tail —
`max` is nearly double at pool 10 — but it no longer exhausts.

`location ingest p95` misses its 200 ms target at both pool sizes on this
machine. The load generator shares the cores, so re-measure on the target host
before treating that as a real miss.

### The original measurement, kept for the record

Without PgBouncer, at `DATABASE_MAX_CONNECTIONS=10`, **with dispatch still
inline in the request path**:

```
8 × "timeout exceeded when trying to connect"  →  8 × HTTP 500
http_req_duration p95   908 ms
location ingest   p95   935 ms
```

At pool 50, same build: 0 × 5xx, p95 161 ms.

This is why §3.3 exists. The application pool is deliberately small because
PgBouncer is supposed to multiplex in front of it, and the first measurement
shows what happens when neither is true.

### Matching latency

Not measured by this script. Measured separately by
`services/api/scripts/dispatch-e2e-check.mjs`, which times `POST /rides`
returning to `ride.offer` arriving on a real driver WebSocket:

Five consecutive runs after a warm-up, each asserting that the offer event
names **this** ride and that the persisted `ride_offers` row names **this**
driver:

```
242 ms   295 ms   105 ms   123 ms   277 ms      target < 3000 ms
```

An earlier set of three read 66/45/36 ms; those were taken before publishing
moved to its own Redis connection, which now has to establish on first use.

**Cold start is different.** The first dispatch after the API and worker start
can exceed the 15-second offer window entirely — observed once in five. Warming
up before measuring is not cosmetic, and a production deployment should expect
the first ride after a restart to be slower than every ride after it.

Single user, not under load. The number under 500 concurrent users is unknown.

---

## What these numbers are not

They are **not** a measurement of the 4-core VPS the 500-user target is written
against. The load generator competed with the server for the same cores
throughout. Treat every latency here as a pessimistic floor and re-run on the
target host before quoting any of it.

---

## Not yet covered

- ~~**WebSocket under load.**~~ Covered by `test/load/realtime.load.js`; see
  "WebSocket capacity" below.
- **Matching latency at concurrency.** Measured single-user only.
- **Soak, spike, recovery.** One 5-minute constant-rate profile has been run.
  A 30–60 minute soak, a 50→500 spike and a 500→0 recovery have not.
- **Anything above 400 drivers.** 750 and 1000 were not attempted; on this
  machine the load generator becomes the bottleneck first.

---

## WebSocket capacity

Run 2026-08-25, k6 v0.54.0, `test/load/realtime.load.js`, against the API,
PostgreSQL 17.11 and Redis 8.0.5 on one Windows laptop. One connection per VU,
authenticated, held open for the whole window - which is what "N concurrent"
has to mean. `STAGGER_MS` is the gap between clients dialling.

| Connections | Stagger | Opened | Reached `ready` | Refused | Dropped after ready |
|---|---|---|---|---|---|
| 100 | 10 ms | 100 | 100 | 0 | 0 |
| 250 | 10 ms | 250 | 250 | 0 | 0 |
| 500 | 10 ms | 500 | 500 | 0 | 0 |
| 1000 | 5 ms | 1000 | 1000 | 0 | 0 |

At 1000 held sockets the API process was at **108 MB** resident, `/v1/health`
still answered 200, and every socket closed cleanly. Time to `ready` was 5 ms
p50 / 18 ms p95.

**Redis connections did not move.** 225 before, 225 during 250 sockets, 225
during 1000. The gateway multiplexes every subscription over one shared
subscriber connection rather than opening one per socket, so Redis is not the
ceiling - which was the specific thing worth checking, because the opposite
design is common and fails at exactly this scale.

### The burst case, and why it is the rig and not the server

With **zero** stagger - every client dialling in the same instant - some dials
are refused by the OS with `connectex: No connection could be made`:

| Connections | Stagger | Opened | Handshake refused |
|---|---|---|---|
| 300 | 0 | 244 | 56 |
| 500 | 0 | 289, then 450 on a repeat | 211, then 50 |
| 1000 | 0 | 342 | 658 |

The same run repeated at 500 gave 289 and then 450, and a result that swings by
that much between identical runs is not a property of the server.

The control settles it. A **bare `ws` server with none of this application in
it** - no auth, no Redis, no Nest - was given the same burst on the same
machine:

| Connections | Bare server opened | Our server opened |
|---|---|---|
| 500 | 233 | 289-450 |
| 1000 | 313 | 342 |

The bare server does slightly **worse**. The burst limit is the loopback accept
path on this laptop, not our code. Every connection that was accepted reached
`ready` and stayed up: `readied` equals `opened` in every row above, and
`dropped_after_ready` is 0 throughout.

What this does **not** establish is how the real server behaves in a reconnect
storm, when every driver's client redials at once after a restart. That needs
the VPS and a load generator that is not sharing its cores.
