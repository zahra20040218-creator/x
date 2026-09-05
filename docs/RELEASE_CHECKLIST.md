# Release checklist

Ordered so that the things that can stop a release appear before the things that
merely need doing. Build procedure is in [RELEASE.md](RELEASE.md); external
accounts are in [EXTERNAL_SETUP.md](EXTERNAL_SETUP.md).

---

## Gates — a release cannot proceed past a failure here

- [ ] **Physical device testing complete.** [DEVICE_TEST_PLAN.md](DEVICE_TEST_PLAN.md),
      on a real Xiaomi and a real Samsung. Not an emulator, not Firebase Test
      Lab alone. Currently **not done**, and it is the only item on this page
      that could still reveal unfinished work rather than unfinished paperwork.
- [ ] `google-services.json` in place for both apps; phone sign-in works on a
      real handset.
- [ ] Maps key restricted to both package names and all SHA-1 fingerprints; the
      map renders on a real handset.
- [ ] Production API domain live over TLS, and both bundles rebuilt against it.
      The bundles in `~/rideapp-artifacts/` are built against a **placeholder**.
- [ ] PgBouncer in front of PostgreSQL, or `DATABASE_MAX_CONNECTIONS` raised
      deliberately. At the default 10 without PgBouncer, 400 concurrent drivers
      produced 500s — see [LOAD_TESTING.md](LOAD_TESTING.md).
- [ ] A restore from backup has been **performed**, not just configured. An
      untested backup is an assumption.

---

## Code

- [ ] `pnpm test` green with `REAL_INFRA=1` — 848 tests
- [ ] `flutter test` green in `packages/core` (132), `apps/rider` (8),
      `apps/driver` (6)
- [ ] `flutter analyze` — 0 errors, 0 warnings, all three packages
- [ ] `tsc --noEmit` and `eslint --max-warnings=0` clean, API and admin
- [ ] No `TODO`, `FIXME` or `UnimplementedError` in tracked source
- [ ] Migrations run up **and down** on a fresh database
- [ ] `src/db/migrations.test.ts` lists every migration (it pins the set, so a
      new one fails the suite until added — intentional)

## Signing

- [ ] Bundle built with `scripts/build-release.sh`, never by hand
- [ ] `unzip -p app-release.aab META-INF/UPLOAD.RSA | keytool -printcert` shows
      `CN=Darb` or `CN=Darb Driver`, **never** `CN=Android Debug`
- [ ] Both `.jks` files and both `key.properties` backed up somewhere that is
      not this machine. A signing key cannot be changed after first upload.

## Manifest and permissions

- [ ] `versionCode` incremented
- [ ] `application-label-ar` correct (`درب` / `سائق درب`) — verify with
      `aapt2 dump badging`, not by reading the file
- [ ] `usesCleartextTraffic="false"` in the merged **release** manifest
- [ ] `network_security_config` **absent** from the release bundle (it lives
      under `src/debug/`)
- [ ] Driver retains `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`,
      `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS`
- [ ] Rider does **not** request background location — it has no use for it, and
      asking for it invites a policy review it cannot pass

## Server

- [ ] Every variable in `.env.example` set; `TRUST_PROXY` correct for the
      topology (both mistakes are silent and both break rate limiting)
- [ ] `FCM_SERVICE_ACCOUNT_JSON` on the server only, never in a build
- [ ] `METRICS_TOKEN` set, or metrics deliberately left 404
- [ ] `CORS_ALLOWED_ORIGINS` explicit; `*` is refused at boot
- [ ] Worker process running. **Dispatch happens in the worker** — without it,
      rides are created and never offered.
- [ ] Health and readiness endpoints answering

## Play Console

- [ ] Play App Signing enrolled
- [ ] **The Play App Signing SHA-1 and SHA-256 added to Firebase and to the Maps
      key restriction.** Google re-signs the bundle with its own key, producing a
      fingerprint that only exists after the first upload. Miss this and sign-in
      works on your device and fails for every store install.
- [ ] Data safety form: precise location, collected continuously while a driver
      is online, used for ride matching
- [ ] Internal testing track before production
- [ ] Android Developer Verification status checked for your distribution
      channel and territory — enforcement began 2026-09-30 in four countries and
      expands in 2027. Confirm what applies rather than relying on any summary,
      including this one.

## Legal

- [ ] Decision recorded on whether driver documents are legally required
      (`DECISIONS.md` D-018). The mechanism is built and disabled by default;
      turning it on takes one config row and no deploy.
- [ ] Terms, privacy policy, and a data retention position for location history

---

## Deliberately not done

**R8 / resource shrinking is off.** Flutter compiles Dart ahead of time, so
shrinking touches only the Java/Kotlin shim — a few hundred KB. Against that,
`firebase_messaging` and `google_maps_flutter` both resolve classes reflectively,
and a missing keep rule fails at runtime on a handset rather than at build time.
Turn it on after there is a device to verify it on, not before.
