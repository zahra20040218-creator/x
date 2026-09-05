# Handoff: ALY — Rider App Recreation & Web Drift

## Overview
This bundle documents the CURRENT UI of the ALY ride-hailing app (Flutter rider/driver flows) and the separate web rider PWA, recreated as HTML design references, plus a diff between the two design systems.

## About the design files
The files here are **HTML design references**, not production code. Do not copy the HTML/CSS into the app. The task is to recreate these exact screens using the existing Flutter widgets and tokens already in the repo:
- `packages/core/lib/src/design/tokens/` (colors.dart, typography.dart, metrics.dart)
- `packages/core/lib/src/design/components/` (buttons.dart, containers.dart, ride.dart, driver.dart)

## Fidelity
High-fidelity. Colors, type sizes, spacing and copy were lifted directly from the Dart source and `strings.dart` — treat exact hex values, font sizes and Arabic copy as authoritative.

## Files in this bundle
- `ALY App.dc.html` — 13 rider + driver screens on the current Flutter design system (AlyColors/AlyTypography/AlySpacing), plus a legacy sign-in on the older theme.dart tokens.
- `ALY Web.dc.html` — 9 screens of the separate web rider PWA (style.css/script.js/app.js), with a DRIFT table comparing every token against the Flutter design system.
- `Map Picker.html` — the 6 states of `MapPickerView` (ready, permission denied, location disabled, loading, offline, unavailable).

## What to do
1. Open each HTML file to see the screens, exact copy, and the inline "DRIFT" / implementation notes under each frame — these note which Dart file/component each screen maps to.
2. For the Flutter app (`ALY App.dc.html`), verify each screen against the referenced screen/component file and fix any divergence between what's shipped and what the design system components (`AlyOnlineToggle`, `AlyEarningsCard`, `AlySubscriptionCard`, `AlyBlockerList`, etc.) intend — several screens (e.g. driver home) currently use older ad-hoc widgets instead of the newer Aly* components.
3. For the web app drift table in `ALY Web.dc.html`, decide with the team whether to converge the web app onto the Flutter tokens (recommended) or keep them separate, and update `style.css` accordingly.
4. Do not build anything from the OUT-OF-SCOPE list in `CLAUDE.md` §2.

## Design tokens (Flutter, authoritative)
See `packages/core/lib/src/design/tokens/colors.dart`, `typography.dart`, `metrics.dart` directly — do not hardcode values, reference the token classes (`AlyColors`, `AlyTypography`, `AlySpacing`, `AlyRadius`).
