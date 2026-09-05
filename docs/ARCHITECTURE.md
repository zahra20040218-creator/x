# Architecture

What the system is, and why the load-bearing decisions are what they are.

---

## Shape

```
Rider app ─┐                        ┌─ PostgreSQL 17  (source of truth)
           ├─ HTTPS ──► API ────────┤
Driver app ─┘   WSS       │         └─ Redis 8  (positions, claims, pub/sub)
                          │
Admin (Refine) ── HTTPS ──┘
                          │
                       BullMQ ──► worker  (dispatch, sweeps, push)
```

One API process and one worker process, both stateless. Two processes rather
than one because a slow FCM call inside the API would hold a database
connection while it waits — `CLAUDE.md` §3.2 exists for that reason.

Deliberately **not** Kubernetes and **not** microservices. At 500 concurrent
users both are solutions to problems this system does not have.

---

## Where state lives

| Data | Home | Why |
|---|---|---|
| Users, rides, ledger, documents | PostgreSQL | must survive everything |
| Driver positions | Redis (`GEOADD`) | written every 5s per driver; on the request path, so never Postgres (§3.1). Flushed to Postgres in batches by the worker. |
| Ride claims | Redis (`SET NX PX`) | §5.1 needs an atomic test-and-set that a DB read-then-write cannot give |
| Presence | Redis, TTL | rebuildable; a driver who stops reporting simply expires |
| Realtime fan-out | Redis pub/sub | a client is connected to exactly one API process, and a state change happens on whichever process handled the request |

**Redis is never the only home for anything that cannot be lost.** Losing Redis
loses live positions and in-flight claims; every driver re-reports within
seconds and every claim expires within 30. Ride state, money and documents are
untouched.

---

## The ride lifecycle

```
REQUESTED ─► OFFERED ─► ACCEPTED ─► DRIVER_ARRIVED ─► IN_PROGRESS ─► COMPLETED
```

Enforced in one place. `RideStateMachine` validates, `RideRepository` applies,
and no controller writes `ride.status`. Every transition appends to `ride_events`,
which is append-only. An invalid transition is a 409, never a silent no-op.

`REQUESTED → ACCEPTED` does not exist. A driver can only accept a ride that was
offered **to them**, which is what stops cherry-picking.

### Dispatch

```
POST /rides ─► 201 to the rider
            └► enqueue ride-dispatch
                    └► worker: nearest eligible driver
                            └► OFFERED + ride.offer over the socket
```

Queued rather than inline: dispatch reads config, queries the Redis geo set,
filters against Postgres, writes a transition and an offer row, and publishes.
Holding a pool slot for all of that while the rider waits on a response they do
not need it for is how a 25-slot pool empties at 500 users.

This path did not exist until 2026-08-24. `POST /rides` returned 201 and nothing
ever offered the ride to anybody.

---

## Concurrency

Three defects kill ride-hailing MVPs. Each has a specific mechanism here:

**Two drivers accepting one ride.** `SET ride:{id}:claim {driverId} NX PX 30000`.
Only the driver whose `SET NX` returned OK proceeds. Verified at 961 concurrent
attempts against real Redis: exactly one winner. If the transaction after the
claim fails, the claim is released rather than left to expire — 38 such
rollbacks were observed in one load run, none leaked.

**Duplicate rides from a retry.** The client sends an `Idempotency-Key`; the
server stores key → ride for 24h and returns the original. Verified across 600
deliberately retried pairs: zero duplicates. Baghdad networks drop requests
mid-flight, and without this one rider becomes three dispatched drivers.

**Background location dying.** Foreground service, battery-optimisation
exemption with an explaining screen, local buffering with flush on reconnect,
and no `WorkManager` for sub-minute intervals. Verified on a device — **not
yet**. See [DEVICE_TEST_PLAN.md](DEVICE_TEST_PLAN.md).

---

## Realtime

WebSocket at `/v1/realtime`. The token arrives in the first frame, because a
WebSocket handshake cannot carry an `Authorization` header; the server closes
with 4401 if it does not arrive within 5 seconds.

A connection is subscribed to exactly one Redis channel, derived from the
**token**, never from anything the client sends. There is no client-supplied
channel name anywhere in the gateway, which is what makes "can driver A see
driver B's data?" answerable.

FCM is the wake-up and fallback path, never a location transport. Both apps also
poll, at a longer interval than before — a socket is not a guarantee on these
networks, and an offer that depends solely on a live connection is an offer that
sometimes never arrives.

---

## Money

`BIGINT`, whole Iraqi Dinars, no decimals anywhere. Every financial event writes
≥2 rows to `ledger_entries` summing to zero; the table is append-only, enforced
by a trigger, and corrections are new offsetting rows. Balances are derived —
`SUM(credits) − SUM(debits)` — never a stored counter that can drift.

Commission is configuration, default 0, changeable without a deploy, and
snapshotted onto each ride at creation.

Pagination over the ledger uses a keyset cursor on `(created_at, id)` where the
cursor is an **id** the server resolves. A timestamp cursor lost rows three
different ways, and each one cost a driver money. See `http/cursor.ts`.

---

## Seams

Abstractions exist where a provider is genuinely likely to change or where the
alternative is untestable:

| Port | Why |
|---|---|
| `PaymentProvider` | `CashProvider` is real; `GatewayProvider` throws. Adding ZainCash is three methods and a webhook. |
| `PushSender` / `PushTokenSource` | FCM needs a platform channel; the *sequence* is ordinary logic that must be testable. |
| `RideEventPublisher` | keeps `RideService` testable without a WebSocket server, and is where a second transport would attach. |
| `RedisPort` | `FLUSHDB` is deliberately not on it, so no production code can call it. |
| `FirebaseVerifier` | lets tests run without Firebase; production always constructs the real one. |

**No `MapsProvider` yet.** Maps use is currently confined to two widgets in
`packages/core/lib/src/maps/`, and the ride domain has no knowledge of Google at
all — no geocoding, no routing, no Places. An abstraction over two widgets would
be indirection without a decision behind it. The seam to add, if Mapbox or
MapLibre is ever considered, is those two files.

---

## Configuration

Compile-time for the apps (`--dart-define`), environment for the server,
`platform_config` for anything an operator must change without a deploy —
commission, fare, offer timeout, search radius, required documents.

A release build refuses to start unless its endpoints are `https`/`wss` and not
a development host, and says which flag is missing rather than crashing.
