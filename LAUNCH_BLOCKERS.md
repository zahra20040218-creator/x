# LAUNCH_BLOCKERS.md

**Verdict: NO-GO.** Seven open P0/P1 blockers. Four of them are missing code,
not missing infrastructure — the distinction matters, because no amount of
Docker fixes them.

Generated 2026-08-23. Every row was verified by running something, not by
reading a previous report.

---

## P0 — launch impossible

### M-1 · Neither mobile app can be built

**Why it matters.** This is a ride-hailing product. Without an APK there is no
rider app and no driver app, so there is no business.

**Evidence.**
```
$ find apps/rider -type f
apps/rider/analysis_options.yaml
apps/rider/lib/main.dart
apps/rider/lib/screens/{request_ride,sign_in,track_ride}_screen.dart
apps/rider/pubspec.yaml          <- no android/ directory at all

$ find apps/driver/android -type f
apps/driver/android/app/src/main/AndroidManifest.xml    <- the only file
```

The rider app has **no Android project**. The driver app has a manifest and
nothing else: no `build.gradle`, no `settings.gradle`, no gradle wrapper, no
`MainActivity`, no `res/` (icons, splash), no signing configuration, no
application id.

**This is missing code, not a blocked verification.** Installing Flutter would
not produce an APK.

**Exact fix.** `flutter create --platforms=android .` in each app to generate
the Android host project, then re-apply the driver manifest (it is correct and
complete — foreground service, background location, Doze exemption, POST_NOTIFICATIONS).
Then add `key.properties` + a release `signingConfig`, app icons, and the
application id.

**Files:** `apps/rider/`, `apps/driver/android/`
**Verify:** `flutter build apk --release` in both.
**Owner decision:** no. **Complexity:** Medium.

---

### M-2 · Firebase was never initialised — sign-in was broken in both apps

**Why it matters.** Every user journey starts at OTP sign-in. It could not work.

**Evidence.** `main()` in both apps called `WidgetsFlutterBinding.ensureInitialized()`
and went straight to `runApp`. No `Firebase.initializeApp()` anywhere in the
repository, while `sign_in_screen.dart` calls
`FirebaseAuth.instance.verifyPhoneNumber(...)` — which throws
`[core/no-app] No Firebase App '[DEFAULT]' has been created`.

**Status: partly fixed.** The call was added to both entry points this session.
**It has not been compiled** — there is no Flutter SDK on this host, so treat
it as an unverified edit.

**Still required:** `android/app/google-services.json` from your Firebase
project plus the `com.google.gms.google-services` Gradle plugin. That file is
deliberately not in the repository. **CONFIGURATION REQUIRED.**

**Files:** `apps/rider/lib/main.dart`, `apps/driver/lib/main.dart`
**Verify:** `flutter run` and complete an OTP round trip on a device.
**Owner decision:** supply the Firebase project. **Complexity:** Low (code) / Low (config).

---

### D-2 · Concurrency has never run against real Redis or real PostgreSQL

**Why it matters.** CLAUDE.md §5.1 exists because two drivers accepting the
same ride is the defect that kills ride-hailing MVPs. The protection is
designed, unit-tested and reasoned about — and has never executed against the
software it depends on.

**Evidence.** `docker`, `psql`, `redis-cli` all NOT FOUND; nothing listening on
5432/6432/6379. The real-Redis conformance suite skips and says so.

**Made worse by D-15** (below): the database fake cannot model concurrent
transactions either, so neither half of the atomic path is verified.

**Exact fix.** Install Docker, then:
```bash
docker compose -f infra/docker-compose.yml up -d
pnpm --filter @rideapp/api migrate:up
TEST_REDIS_URL=redis://localhost:6379 TEST_DATABASE_URL=postgres://... \
  pnpm --filter @rideapp/api test:integration
```
**Expected:** a suite named `IoRedisAdapter (real Redis)` **runs** rather than
skipping, and the 20-way accept race produces exactly one 200.

**Owner decision:** no — provide the environment. **Complexity:** Low to run, unknown to fix whatever it finds.

---

## P1 — must fix before commercial launch

### A-1 · The admin panel is not an application

**Why it matters.** There is no way to approve a driver, resolve a dispute, top
up a wallet, or change the commission rate. The backend endpoints exist and are
tested; nothing can reach them but `curl`.

**Evidence.**
```
$ ls apps/admin/src
data-provider.ts  money.ts  money.test.ts

$ npx vite build
error during build: Could not resolve entry module "index.html".
✓ 0 modules transformed.   BUILD_EXIT=1
```
No `index.html`, no `main.tsx`, no `App.tsx`, no `vite.config.ts`, no
components, no routes, no login screen. The 11 passing "admin tests" test a
currency formatter.

**Exact fix.** Build the Refine application over the existing `data-provider.ts`
(which is correct and already maps every resource to a contract path): entry
point, router, auth provider against `/v1/auth`, and list/show/edit pages for
`drivers`, `rides`, `disputes`, `config`.

**Files:** `apps/admin/`
**Verify:** `pnpm --filter @rideapp/admin build`, then sign in and suspend a driver.
**Owner decision:** no. **Complexity:** Medium.

---

### M-3 · There is no map in either app

**Why it matters.** A rider cannot choose a pickup point, cannot choose a
destination on a map, and cannot watch the driver approach. That is the core
interaction of the product.

**Evidence.** `google_maps_flutter` is declared in both pubspecs, but
`GoogleMap` is never instantiated anywhere in 27 Dart files. The picker is
explicitly `/// Placeholder for the map picker.` and the tracking screen says
`// GoogleMap goes here`.

**Exact fix.** Implement the map picker and the tracking map. Needs a Maps API
key with Android restrictions — **CONFIGURATION REQUIRED** as well as code.

**Files:** `apps/rider/lib/screens/request_ride_screen.dart`, `track_ride_screen.dart`
**Owner decision:** supply the Maps key. **Complexity:** Medium.

---

### N-1 · Push notifications are a logged no-op

**Why it matters.** Offers expire in 15 seconds. A driver whose phone is in
their pocket receives nothing, so drivers must sit staring at a foregrounded
app to earn. In practice the supply side does not function.

**Evidence.** `services/api/src/worker.ts:163` accepts the job and logs
`push.pending / "push delivery is not implemented in v1"`. No FCM SDK, no
notification module anywhere in the backend.

**Exact fix.** Implement the FCM sender behind the existing queue job, plus
device-token registration (there is no endpoint for it today).
**CONFIGURATION REQUIRED:** FCM service account.

**Files:** `services/api/src/worker.ts`, new token-registration endpoint + migration
**Owner decision:** supply FCM credentials. **Complexity:** Medium.

---

### D-15 · The database fake cannot model concurrent transactions

**Why it matters.** It means the repository's concurrency evidence is weaker
than the test names imply, and it hid a real assertion failure this session.

**Evidence.** `FakeDatabase.transaction` snapshots **every table** on entry and
restores the snapshot on any failure. With 20 concurrent accepts, the single
winner commits and the 19 rollbacks then erase its write — observed directly:
one `fulfilled`, and `ride_events` containing only `["REQUESTED","OFFERED"]`.
Real PostgreSQL isolates per connection and would keep it.

**Exact fix.** Do not extend the fake to emulate MVCC. Run the concurrency
suite against real PostgreSQL (see D-2). The fake is fine for shape and wiring;
it must stop being cited as durability evidence.

**Files:** `services/api/test/fakes/fake-database.ts`
**Owner decision:** no. **Complexity:** Low (documentation) / covered by D-2 (verification).

---

### DB-1 · Migrations have never been executed

Six up + six down migrations exist and pass a static safety check. None has ever
run. The append-only ledger triggers, the deferred balance constraint, the
partial unique indexes and the new `session_id` column are SQL text that no
database has parsed.

**Verify:** `pnpm --filter @rideapp/api migrate:up` then `migrate:down 6` then up again.
**Complexity:** Low to run.

---

## Fixed during this audit

| ID | Was | Now |
|---|---|---|
| **D-14** | Any driver could accept a ride offered to someone else | Ownership checked against a PENDING `ride_offers` row in the same transaction. Mutation-tested |
| D-13 | Going offline left the offer parked with an absent driver | Going offline releases the offer. Mutation-tested: without the fix the accept returns 200, with it 404 |
| S-11 | `ws` 8.18.3, high-severity DoS on the WebSocket server | 8.21.0, advisory cleared |
| M-2 (code half) | `Firebase.initializeApp()` missing | Added to both apps — **uncompiled** |

---

## Shortest realistic path to GO

1. **Install Docker** → run migrations, run the real-Redis conformance suite,
   run the concurrency tests for real. Closes D-2, D-15, DB-1. *Nothing else
   should be trusted until this passes.*
2. **Generate the Android host projects** and sign them → closes M-1.
3. **Supply Firebase + Maps + FCM credentials** → unblocks M-2, M-3, N-1.
4. **Build the admin application** over the existing data provider → closes A-1.
5. **Implement the maps UI and push delivery** → closes M-3, N-1.
6. **Test on a real Xiaomi and a real Samsung** for 20 minutes of driving with
   the screen off → the CLAUDE.md §5.3 requirement that no emulator can stand in for.
7. **Run k6** at 500 concurrent against a VPS-like target.

Steps 1–2 are days. Steps 4–5 are the bulk of the remaining engineering.
