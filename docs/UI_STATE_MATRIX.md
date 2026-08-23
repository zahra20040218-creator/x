# UI_STATE_MATRIX.md

Brief §13/§18: every screen handles **Loading · Empty · Error · Success**,
with Retry where an error is retryable.

**Status: PARTIAL — implemented, NOT verified.** There is no Flutter SDK on
this host, so nothing below has been compiled or rendered. The widget tests are
written and unrun. See BLOCKER-4.

---

## The structural fix

Asking each screen to remember four cases produced the predictable result: the
audit found Loading and Error broadly present and **Empty missing on 7 of 8
screens**.

So it is no longer asked by hand. `packages/core/lib/src/design/async_view.dart`
defines a **sealed** `ViewState<T>` and an `AsyncView` whose `empty` and
`onRetry` parameters are **required**:

```dart
AsyncView<List<Ride>>(
  state: state,
  success: (context, rides) => ...,
  empty:   (context) => ...,   // REQUIRED - omitting it will not compile
  onRetry: _refresh,           // REQUIRED
)
```

A screen that forgets the empty state does not render an accidentally-blank
page. It fails to build. That converts a convention into a guarantee — the same
move used for `IqdAmount` (money) and `PublicUser` (no phone field).

`ViewState.fromList` also collapses "loaded but nothing there" into `Empty`
rather than a `Success` carrying nothing, which is precisely how a blank screen
with no explanation gets shipped.

---

## Per-screen state

| Screen | Loading | Empty | Error | Retry | Success | Notes |
|---|---|---|---|---|---|---|
| **rider** / sign_in | ✅ busy | n/a | ✅ banner | ⚠️ resend | ✅ | Empty is meaningless on a form |
| **rider** / request_ride | ✅ busy | n/a | ✅ banner | ✅ | ✅ | Empty n/a — form until both points set |
| **rider** / track_ride | ✅ spinner | ✅ `noDriversFound` | ✅ banner | ✅ poll+reconnect | ✅ | |
| **rider** / map_picker | ⚠️ | n/a | ⚠️ | ⚠️ | ✅ | **A surface, not a map — needs the Maps SDK** |
| **driver** / sign_in | ✅ busy | n/a | ✅ banner | ⚠️ resend | ✅ | |
| **driver** / battery_exemption | ✅ busy | n/a | ✅ **added** | ✅ **added** | ✅ | **Was the worst gap** — see below |
| **driver** / home | ✅ busy | ⚠️ | ✅ banner | ✅ pull-to-refresh | ✅ | Wallet card hides when null; should say "no earnings yet" |
| **driver** / offer_sheet | ✅ busy | n/a | ✅ banner | n/a | ✅ | Empty n/a — a sheet always has an offer |
| **driver** / trip | ✅ busy | n/a | ✅ banner | ⚠️ | ✅ | |

Legend: ✅ implemented · ⚠️ partial or not applicable-but-unmarked · ❌ missing

---

## What was actually fixed

### battery_exemption_screen — the worst gap

A permission **denial** is the most likely outcome of this screen, not an edge
case. Before the fix, a denial did **nothing**: the driver tapped, Android
refused, and the same screen stared back with no explanation and no way
forward. They would conclude the app is broken — and they would be right.

Worse, this is the CLAUDE.md §5.3 screen. A driver stuck here never grants the
Doze exemption, so their location silently stops minutes after their screen goes
off — the exact failure the constitution calls the most common cause of
ride-hailing MVP death.

Now: a denial shows a warning banner explaining the consequence, and the primary
button becomes **Retry**.

### AsyncView + EmptyView in packages/core

Shared, so `CLAUDE.md` §1 (no duplicated widget code) holds, with four new
localised strings for the empty cases.

---

## Still open

| Gap | Why it is not fixed here |
|---|---|
| Rider **ride history** screen does not exist | Brief §14 requires History. Building a screen that cannot be compiled or rendered would be writing blind — the honest move is to record it. |
| Driver home has no "no earnings yet" empty | Small; wallet card currently hides entirely when null, which reads as "loading forever". |
| map_picker is a placeholder surface | Needs the Google Maps SDK and an API key — BLOCKER-6. |
| Dark mode | Brief §13 asks for it; only a light theme exists. |
| Accessibility beyond touch targets | `content descriptions` are on the shared widgets only, not audited per screen. |

---

## Verification status — honest

| Check | Status |
|---|---|
| `AsyncView` renders all four states distinctly | **written, UNRUN** — `async_view_test.dart`, 12 widget tests |
| Retry invokes its callback | **written, UNRUN** |
| Unretryable errors show no retry button | **written, UNRUN** |
| Loading announced to a screen reader | **written, UNRUN** |
| Retry button ≥ 48dp | **written, UNRUN** |
| RTL under an Arabic locale | **written, UNRUN** |

```bash
# The command that would verify all of the above:
cd packages/core && flutter pub get && flutter analyze && flutter test
```

**Until that runs, this document describes intent backed by unrun tests.**
Status stays `PARTIAL`, and the brief's per-screen requirement is **not** met
until every ⚠️ above is closed and the tests pass.
