# Implementation audit

2026-08-24. Findings from reading and *running* the repository, not from reading
it alone. Every claim here was reproduced against the real API process, real
PostgreSQL 17.11 and real Redis 8.0.5.

---

## The pattern that produced the worst defects

Four separate components were **built, unit-tested, and never connected**. Each
had passing tests. Each was reachable only from the tests that covered it.

| Component | Built | Wired | Found by |
|---|---|---|---|
| FCM client registration | yes | no | reading dependencies against usage |
| Dispute endpoint | yes | no | route-to-consumer audit |
| Realtime gateway | yes | no | grepping for callers of `toRider`/`toDriver` |
| **Ride dispatch** | yes | **no** | grepping for callers of `dispatch` |

A test that constructs the component and calls it directly cannot tell you
whether anything else does. Every one of these had that shape.

---

## P0 — the product did not work

### Nothing dispatched a ride

`POST /rides` created the ride, returned 201, and stopped. `MatchingService.dispatch`
was reachable only from matching's own re-dispatch path (after a decline or an
expiry) and from tests. A rider in production would have watched "searching"
until they gave up, and no driver would ever have been offered anything.

**Fixed.** `RideDispatcher` enqueues a `ride-dispatch` job on creation; the
worker consumes it. Queued rather than inline because dispatch touches Postgres
and Redis several times and CLAUDE.md §3.2 exists for exactly that.

Verified end to end, three consecutive runs: **66 ms, 45 ms, 36 ms** from
`POST /rides` returning to `ride.offer` arriving on a driver's WebSocket.
Target is 3000 ms.

### Any WebSocket client crashed the API

`RealtimeGateway.onMessage` → `redis.subscribe` threw
`Stream isn't writeable and enableOfflineQueue options is false`, unhandled, out
of a `socket.on('message')` handler. The process died.

Root cause: `redis.duplicate()` copies the parent's options. `enableOfflineQueue:
false` is deliberate on the command connection — a location write that queues
while Redis is down is worse than one that fails fast — and wrong on the
subscriber, where a freshly duplicated connection is not yet connected and the
first `subscribe()` is rejected instead of waiting.

The rider app connects to this socket on every tracking screen. **Fixed** at the
cause (subscriber gets `enableOfflineQueue: true`) and defensively in the gateway
(a subscribe failure closes that one connection, code 4500, instead of the
process).

---

## P1 — money and correctness

### Statement pagination dropped rows

A timestamp cursor over `ORDER BY created_at DESC`. Three faults, all needing a
real PostgreSQL to see: `created_at` is not unique; `now()` is the *transaction*
timestamp so a double-entry settlement's rows always share one; and
`timestamptz` is microsecond precision while a JavaScript `Date` is millisecond,
so a cursor that round-trips through JSON no longer matches the row it came
from.

Reproduced: **four of six** wallet entries never reached the driver. Fixed with
an id cursor the server resolves itself; five call sites; migrations 0008/0009.

### The admin ride list paged on one column and returned another

Filtered on `rides.created_at`, handed back `requestedAt`. Fixed with the same
cursor.

---

## Dead paths closed

| Path | Symptom before |
|---|---|
| FCM registration | dependency declared, no token ever registered — a backgrounded driver received no offers |
| `POST /admin/disputes` | implemented and guarded, no caller — the admin queue could only ever be empty |
| Driver sign-out | absent — the next driver on that handset inherited the previous one's offers |
| Realtime events | gateway attached, nothing published — both apps fell back to polling |

---

## Configuration and release

- Both release AABs pointed at `http://10.0.2.2:3000/v1`, the Android emulator's
  route to a developer's machine, over plaintext. The comment above the constant
  claimed a release build could not do this; nothing enforced it. Now enforced,
  with a readable failure screen rather than a launch crash.
- Release signing used the debug key (`flutter create` default). Now fails the
  build instead.
- Cleartext was blocked by Android's API-28 default with no network security
  config, so **the development default could not connect at all**.
- `TRUST_PROXY` was read by `main.ts` and documented nowhere. Both mistakes are
  silent and both break rate limiting.

---

## Still open, honestly

| Item | Why it is not closed |
|---|---|
| Physical device testing | §5.3 needs a Xiaomi and a Samsung. No emulator reproduces OEM process-killing. |
| Firebase / Maps credentials | Account-owned. Integration is complete and waiting. |
| App Check / Play Integrity | Not implemented. Needs a Firebase project to verify against. |
| Production endpoint | Both AABs are built against a placeholder host. |
| WebSocket under load | The k6 script is HTTP-only. Matching latency is measured single-user, not at 500. |
| Driver app realtime | The driver app still polls; the server now publishes, but the client is not connected to it. |

The last one matters: the server-side fix is real and verified, but until the
driver app opens a socket it will keep polling every 5 seconds against a
15-second offer expiry.
