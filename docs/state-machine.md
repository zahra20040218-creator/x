# Ride State Machine

Canonical definition. `services/api/src/rides/ride-state-machine.ts` is the only
code permitted to change `rides.status` (CLAUDE.md §4, §12.4). Controllers,
repositories and workers call it; nothing writes the column directly.

## States

| State | Meaning | Terminal |
|---|---|---|
| `REQUESTED` | Rider asked for a ride. No driver assigned. Matching is searching. | no |
| `OFFERED` | An offer is outstanding with one driver, with a deadline. | no |
| `ACCEPTED` | A driver won the atomic claim and is en route to pickup. | no |
| `DRIVER_ARRIVED` | Driver is at the pickup point, waiting for the rider. | no |
| `IN_PROGRESS` | Rider is in the car. | no |
| `COMPLETED` | Trip finished, fare settled, ledger written. | **yes** |
| `CANCELLED_BY_RIDER` | Rider cancelled before the trip started. | **yes** |
| `CANCELLED_BY_DRIVER` | Driver cancelled before the trip started. | **yes** |
| `CANCELLED_IN_TRIP` | Admin aborted a running trip. Admin only. | **yes** |
| `EXPIRED` | The outstanding offer timed out. Transient — see note. | no |
| `NO_DRIVERS_FOUND` | Search exhausted with no candidate. | **yes** |

## Permitted transitions

```
REQUESTED ──> OFFERED ──> ACCEPTED ──> DRIVER_ARRIVED ──> IN_PROGRESS ──> COMPLETED
    │            │            │              │                 │
    │            │            │              │                 └──> CANCELLED_IN_TRIP (admin only)
    │            │            └──────────────┴──> CANCELLED_BY_DRIVER
    │            │                                CANCELLED_BY_RIDER
    │            └──> EXPIRED  (offer timeout, returns to REQUESTED for next driver)
    └──> NO_DRIVERS_FOUND
```

Machine-readable table. **Any pair not in this table is invalid** and raises
`InvalidRideTransitionError` → HTTP 409 (CLAUDE.md §4). It never silently no-ops.

| From | To | Allowed actors | Guard |
|---|---|---|---|
| `REQUESTED` | `OFFERED` | SYSTEM | a candidate driver was selected |
| `REQUESTED` | `NO_DRIVERS_FOUND` | SYSTEM | search radius exhausted, no candidates |
| `REQUESTED` | `CANCELLED_BY_RIDER` | RIDER (own ride), ADMIN | — |
| `OFFERED` | `ACCEPTED` | DRIVER (the offered driver only) | holder of the Redis claim (§5.1) |
| `OFFERED` | `EXPIRED` | SYSTEM | offer deadline passed, or driver declined |
| `OFFERED` | `CANCELLED_BY_RIDER` | RIDER (own ride), ADMIN | — |
| `EXPIRED` | `REQUESTED` | SYSTEM | re-enter the matching pool for the next driver |
| `EXPIRED` | `NO_DRIVERS_FOUND` | SYSTEM | no further candidates remain |
| `ACCEPTED` | `DRIVER_ARRIVED` | DRIVER (assigned only), ADMIN | — |
| `ACCEPTED` | `CANCELLED_BY_DRIVER` | DRIVER (assigned only), ADMIN | — |
| `ACCEPTED` | `CANCELLED_BY_RIDER` | RIDER (own ride), ADMIN | — |
| `DRIVER_ARRIVED` | `IN_PROGRESS` | DRIVER (assigned only), ADMIN | — |
| `DRIVER_ARRIVED` | `CANCELLED_BY_DRIVER` | DRIVER (assigned only), ADMIN | — |
| `DRIVER_ARRIVED` | `CANCELLED_BY_RIDER` | RIDER (own ride), ADMIN | — |
| `IN_PROGRESS` | `COMPLETED` | DRIVER (assigned only), ADMIN | fare settled + ledger written in the same DB transaction |
| `IN_PROGRESS` | `CANCELLED_IN_TRIP` | **ADMIN only** | — |

### Note on `EXPIRED`

`EXPIRED` is drawn as a state because CLAUDE.md §4 lists it as one, and because
the transition must be recorded in `ride_events` so an operator can see that a
driver was offered the ride and did not take it. It is transient: the matching
worker immediately follows `OFFERED → EXPIRED` with `EXPIRED → REQUESTED`
(next candidate) or `EXPIRED → NO_DRIVERS_FOUND` (pool exhausted), inside the
same DB transaction. A ride is never left sitting in `EXPIRED`; a sweeper
(`rides.status = 'EXPIRED'` older than 60s) re-drives any that are, which can
only happen if a worker died mid-transaction.

### Cancellation and the driver's live ride

Every transition into a `CANCELLED_*` state, and into `COMPLETED`, releases:

1. the Redis claim key `ride:{rideId}:claim`,
2. the driver's `ON_TRIP` availability (back to `ONLINE` if they were online),

in the same unit of work as the status change. If the process dies between the
DB commit and the Redis release, the claim key expires on its own after
`MATCH_CLAIM_TTL_MS` and the presence sweeper restores availability — the
system converges without operator action.

## Invariants the machine enforces

1. **Actor authorisation is part of the transition, not a separate check.**
   `transition()` takes `{ actorType, actorId }` and rejects a driver acting on
   a ride that is not theirs with `RideActorNotPermittedError` → HTTP 403. This
   is what stops driver A from touching driver B's ride
   (`ACCEPTANCE_CHECKLIST.md` check 5).
2. **Every accepted transition appends exactly one `ride_events` row**, in the
   same DB transaction as the `rides` UPDATE. If the event insert fails, the
   status change rolls back. There is no path that changes status without an
   event.
3. **`COMPLETED` is atomic with settlement.** The status change, the
   `final_fare_iqd` write, the `payments` row and the balanced `ledger_entries`
   rows all commit together or not at all.
4. **The status UPDATE is guarded by the expected current state**
   (`UPDATE rides SET status=$to WHERE id=$id AND status=$from`). If zero rows
   are affected, another actor moved the ride first and the caller gets 409.
   This makes concurrent conflicting transitions safe without a table lock.
