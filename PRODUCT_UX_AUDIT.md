# PRODUCT_UX_AUDIT.md

> **Dated snapshot.** Written on the date below and kept for the record, not
> maintained. For current state read `docs/COMPLETION_MATRIX.md`, `DECISIONS.md`
> and `BLOCKED.md` — a large amount of what is called blocked or missing here
> was closed on 2026-09-05.


ALY — product experience audit, 2026-08-26.

Status vocabulary, used exactly as defined and never softened:
**PROVEN** (evidence in this repository) · **PARTIALLY PROVEN** ·
**NOT TESTED** · **BLOCKED** (external dependency) · **UNKNOWN**.

---

## The finding that matters most

**Zero of the twelve existing product screens use the design system.**

```
apps/rider/lib/screens/   6 screens   0 references to Aly* components
apps/driver/lib/screens/  6 screens   0 references to Aly* components
```

Measured, not estimated: `grep -c "Aly[A-Z]"` returns 0 for every one of them.

Phase 1 built tokens, a component library and 306 passing tests in
`packages/core`. None of it is on screen. A design system nothing renders is
documentation, and the twelve screens the user actually touches are still the
pre-system ones.

That is the gap this phase exists to close, and it is not closed yet. One
screen — the rider's home — has been rebuilt on the system as the reference
implementation. Eleven have not.

---

## Rider · Home

**Current state.** `apps/rider/lib/screens/request_ride_screen.dart`, 311
lines. Two latitude/longitude fields, a fare estimate, a request button. The
map exists in the file but is not the screen; it is a widget among widgets.

**Problems.**

| | |
|---|---|
| A rider is asked for coordinates | Nobody knows their own latitude. This is a developer's form wearing a product's clothes. |
| The map is not the interface | It answers "where am I" only if the rider thinks to look at it. |
| No failure states | Location refused, offline, closed zone, request failed — none is reachable in the code, so none is designed. |
| No empty state | A first-time rider sees the same screen as a regular, with nothing to act on. |
| Fetches its own data | Which is *why* the failure states are missing: there was no way to put the screen into one, in a test or by hand. |

**Changes.** New: `packages/core/lib/src/design/screens/rider_home.dart`.

- Map-first. The map is a full-bleed background layer; a sheet sits over it and
  never exceeds 55% of the height, so the rider can always see the car.
- Five stages — `idle`, `estimating`, `readyToRequest`, `searching`, `onTrip` —
  each with its own layout rather than one form that changes labels.
- The destination entry is a control that *looks* like a field and opens the
  search screen. A live field there would raise a keyboard over the map to do a
  job a full screen does better.
- Recents capped at three. A shortcut, not a history screen.
- The screen owns no data. Everything is `RiderHomeState` plus callbacks.

**UX rationale.** A rider opens ALY because they want to be somewhere else.
Every pixel that does not serve that is in the way. The map answers "where am
I" without being asked; the sheet asks "where to?" and nothing else. History,
profile and wallet are real needs and none of them belongs on the screen
someone opens twice a day to do one task.

Making the screen stateless is what made the failure states *designable*: the
old screen could not be put into "GPS refused" without a device that refuses
GPS.

**Evidence.** `packages/core/test/rider_home_test.dart` — **21 tests, PROVEN**,
covering every stage in light and dark, RTL and LTR, 1.8× text on a 360pt
phone, and landscape.

**Two real defects the tests found and fixed:**

1. The fare row overflowed by **98px** at default size — a `Spacer` between two
   natural-width children, neither able to shrink. Making the label `Expanded`
   was not enough: at 1.8× the fare alone is wider than the sheet, so a further
   **73px** overflow remained. Fixed with `Wrap`, so label and fare share a line
   while they fit and stack when they do not.
2. `AlyDriverCard` overflowed by **66px** at 1.8×. Both easy fixes were wrong:
   ellipsizing truncates the plate a rider identifies the car by, and capping
   the text scale ignores the accessibility setting on the string a
   partially-sighted rider most needs. The layout gives way instead — the plate
   moves to its own line.

**Remaining.** Not wired into `apps/rider` — the app still runs the old screen.
The real map layer is injected but no live map has been rendered against it,
because the Maps API key is **BLOCKED** on an external account.

---

## Rider · Destination search

**Current state.** Does not exist. The old screen has two coordinate fields.

**Changes.** `AlySearchField` exists (`components/inputs.dart`, tested) with a
clear action and a "use my location" affordance. The screen that would host
recents, saved places, autocomplete and map selection is **NOT BUILT**.

**Remaining.** The whole screen. Autocomplete additionally needs the Places
API, which is **BLOCKED** on the same account as Maps.

---

## Rider · Fare negotiation

**Current state.** Server **PROVEN**, client components **PROVEN**, the two are
**NOT CONNECTED**.

- Server: `services/api/src/negotiation/negotiation.service.ts`, migration
  0012, 28 integration tests against real PostgreSQL and Redis.
- Client: `AlyFareProposal`, `AlyDriverOfferCard`, `AlyOfferList`,
  `AlyCounterOfferSheet` — 23 tests.
- Contract: four endpoints added to `docs/api-contract.yaml`.

**UX rationale.** The delta against the rider's own proposal is computed on the
server and shown on the card, because that is the number the rider is actually
comparing against and two clients computing it separately is two chances to get
the sign wrong.

The bid band exists for one specific abuse: without a floor a driver bids 1
IQD, sorts to the top of the list, and renegotiates in the car with a passenger
who has nowhere else to go.

**Remaining.** No screen composes these components. `negotiation_enabled`
defaults to `false`, so the feature is off until an owner turns it on.

---

## Rider · Trip

**Current state.** `track_ride_screen.dart` polls. `AlyTripStatusTimeline`
exists and renders the lifecycle in Arabic with cancelled states as a
terminated timeline rather than a missing step.

**Remaining.** The old screen is still what ships. Realtime is wired
server-side and **PROVEN** in integration tests; the rider screen does not
consume it.

---

## Driver · Everything

**Current state.** Six pre-system screens. Components exist and are tested —
`AlyOnlineToggle`, `AlyEarningsCard`, `AlySubscriptionCard`, `AlyBlockerList`.

`AlyBlockerList` degrades to a generic row on an unknown blocker code, because
the server may add one before the app is updated.

**Remaining.** No driver screen is rebuilt. **NOT TESTED** on a device: the
driver's real context is sunlight, one hand, and a moving car, and none of that
is reachable from a widget test.

---

## Zones

**Current state.** The rider home refuses to price a trip in a closed zone and
says which zones are open — **PROVEN** by test, including the deliberately
contradictory case where a fare and destination are both set and the zone still
wins.

**Remaining.** No zone model on the server. The client honours a flag nothing
computes yet.

---

## Admin

**NOT STARTED** for this phase. 11 tests pass. No command centre, no live map,
no KPI engine.

---

## What a real device would still find

Everything above that is marked PROVEN is proven *in a widget test*. The
following cannot be, and are **BLOCKED** until a device is attached:

- Whether the map renders at all (needs the Maps key)
- Sign-in end to end — never completed on hardware
- Whether the sheet is reachable one-handed on a real phone
- Behaviour on GPS denied, GPS disabled, poor network, backgrounding, resume
- Whether Arabic renders correctly in the system font on a real Android build
