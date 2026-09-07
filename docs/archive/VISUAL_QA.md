# VISUAL_QA.md

> **Dated snapshot.** Written on the date below and kept for the record, not
> maintained. For current state read `docs/COMPLETION_MATRIX.md`, `DECISIONS.md`
> and `BLOCKED.md` — a large amount of what is called blocked or missing here
> was closed on 2026-09-05.


ALY — visual QA, 2026-08-26.

## What "PASS" means on this page, and what it does not

Every row below was produced by a **widget test**, not by a person looking at a
phone. A widget test renders the real widget tree at a real surface size and
fails on a layout overflow, a missing element or a thrown exception. That makes
it excellent at catching the class of defect that hides until someone turns
their font up — and it says **nothing** about whether the result looks good.

So the rows are honest about which question they answer:

- **PASS** — renders correctly at that size, direction, theme and text scale,
  with no overflow and no exception. Verified by an assertion.
- **NOT TESTED** — no coverage.
- **BLOCKED** — needs hardware or an external key.

**No row on this page has been seen by a human eye on a real device.** The
column that would say so is at the bottom, and it is empty.

Reproduce any row with:

```bash
cd packages/core && flutter test
```

---

## Rider home — `AlyRiderHome`

Surface set with `tester.view.physicalSize`, not MediaQuery alone. That
distinction matters: setting only MediaQuery leaves the render surface at
Flutter's default 800×600 while the widget believes it is on a 390×844 phone,
so every size assertion compares two different screens. It is how a sheet capped
at 55% first measured as 77% here.

| Screen | Resolution | Dir | Font | Result | Issues |
|---|---|---|---|---|---|
| home · idle | 390×844 | RTL | 1.0× | PASS | — |
| home · estimating | 390×844 | RTL | 1.0× | PASS | skeletons, not a spinner |
| home · readyToRequest | 390×844 | RTL | 1.0× | **FIXED** | overflowed 98px; `Spacer` between two unshrinkable children |
| home · searching | 390×844 | RTL | 1.0× | PASS | cancel is tertiary, verified |
| home · onTrip | 390×844 | RTL | 1.0× | PASS | no raw enum reaches the screen |
| home · all five stages | 390×844 | LTR | 1.0× | PASS | dark mode |
| home · all five stages | 360×640 | RTL | **1.8×** | **FIXED** | a further 73px on readyToRequest |
| home · readyToRequest | 844×390 | RTL | 1.0× | PASS | landscape |
| home · location denied | 390×844 | RTL | 1.0× | PASS | renders as a notice, not an error |
| home · offline | 390×844 | RTL | 1.0× | PASS | banner does not cover the map |
| home · closed zone | 390×844 | RTL | 1.0× | PASS | request action absent |
| home · sheet height | 390×844 | RTL | 1.0× | PASS | map visible with 10 recents |

---

## Components

| Component | Sizes | Dir | Font | Result | Issues |
|---|---|---|---|---|---|
| `AlyButton` (4 variants × 2 sizes) | 390×844 | RTL+LTR | 1.0× | PASS | loading does not change width |
| `AlyTextField` | 390×844, 360×640 | RTL | 1.0×, 1.8× | PASS | height constant with and without error |
| `AlyPhoneField` | 390×844 | RTL+LTR | 1.0× | PASS | digits LTR inside RTL page — asserted |
| `AlySearchField` | 390×844 | RTL | 1.0× | PASS | clear appears only with text |
| `AlyOtpInput` | 390×844, 360×640 | RTL | 1.0×, 1.8× | PASS | one semantic field, not six |
| `AlyCard` | 390×844 | RTL | 1.0× | PASS | shadow in light, none in dark — asserted |
| `AlySheet` | 390×844, 360×600 | RTL+LTR | 1.0×, 1.8× | PASS | pinned action stays reachable |
| `AlyConfirmationDialog` | 390×844 | RTL | 1.0× | PASS | dismissal returns false |
| `AlyAvatar` | 390×844 | RTL | 1.0× | PASS | presence announced, not only coloured |
| `AlyBadge` (5 tones) | 390×844, 360×640 | RTL | 1.0×, 1.8× | PASS | — |
| `AlyRideCard` | 390×844 | RTL | 1.0× | PASS | unsettled ride shows no zero |
| `AlyRouteSummary` | 390×844, 360×640 | RTL+LTR | 1.0×, 1.8× | PASS | connector mirrors |
| `AlyTripStatusTimeline` (11 statuses) | 360×640 | RTL | 1.8× | PASS | cancelled terminates the timeline |
| `AlyDriverCard` | 390×844, 360×640 | RTL+LTR | 1.0×, **1.8×** | **FIXED** | overflowed 66px; plate now moves to its own line |
| `AlyRatingStars` | 390×844 | RTL+LTR | 1.0×, 1.8× | PASS | per-star labels in input mode |
| `AlyFareProposal` | 390×844, 360×640 | RTL+LTR | 1.0×, 1.8× | PASS | steps by 250 IQD, clamped to band |
| `AlyDriverOfferCard` | 390×844, 360×720 | RTL+LTR | 1.0×, 1.8× | PASS | no phone number rendered — asserted |
| `AlyOfferList` | 390×1200 | RTL | 1.0× | PASS | empty and skeleton states |
| `AlyCounterOfferSheet` | 390×1000, 360×1100 | RTL+LTR | 1.0×, 1.8× | PASS | three actions, ≥2 weights |
| `AlyOnlineToggle` | 390×844 | RTL+LTR | 1.0×, 1.8× | PASS | safe against a double tap |
| `AlyEarningsCard` | 390×844 | RTL | 1.0×, 1.8× | PASS | — |
| `AlySubscriptionCard` | 390×844 | RTL | 1.0×, 1.8× | PASS | three expiry states |
| `AlyBlockerList` (7 codes) | 360×640 | RTL+LTR | 1.8× | PASS | unknown code degrades, does not crash |

---

## Screens NOT covered

`sign_in` (rider has an overflow regression suite from an earlier session, but
predates the design system), `profile`, `ride_history`, `ride_receipt`,
`track_ride`, and all six driver screens: **NOT TESTED** against the design
system, because none of them uses it.

---

## Real device

| Device | OS | Result |
|---|---|---|
| Samsung SC-53C | Android 16 | **BLOCKED** — no device attached this session |

Last hardware evidence, from an earlier session: install, launch,
`Firebase.initializeApp`, Arabic and RTL all PASS; **sign-in never completed**.
That was before the design system existed, so none of the screens above has
ever been on a phone.

**Never claimed as passing here:** anything about contrast in sunlight,
one-handed reach, real font rendering, scroll feel, or animation smoothness.
Those need eyes and hardware.
