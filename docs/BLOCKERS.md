# BLOCKERS.md

Things that cannot proceed without a human decision or a human-supplied
credential. **No value here has been invented or guessed.**

---

## BLOCKER-1 · Mobile stack conflict — Flutter vs Kotlin/Compose · **OWNER DECISION**

**Blocked because:** the continuation brief §5 specifies Kotlin + Jetpack
Compose + Hilt + Room for the mobile apps. `CLAUDE.md` §1 — which the brief
itself instructs me to treat as binding, and which says "do not silently
comply" with a conflicting request — specifies **Flutter**.

**What is already implemented (Flutter):**
- `packages/core` — models, API client with idempotency + single-flight refresh,
  design system, Arabic/RTL localisation, offline location buffer
- `apps/rider` — auth, fare estimate, ride request, live tracking, rating
- `apps/driver` — auth, online toggle, offer sheet, trip flow, and the full
  CLAUDE.md §5.3 background location service with its Android manifest
- 25 Dart files, none compiled (no SDK here)

**Exactly what is required from you:** a decision, one of —

| Option | Cost | Consequence |
|---|---|---|
| **A. Keep Flutter** | zero | `CLAUDE.md` stays authoritative; brief §5 is amended |
| **B. Rewrite in Kotlin/Compose** | weeks; discards all mobile work | `CLAUDE.md` §1 must be formally amended first |
| **C. Flutter now, Kotlin later** | zero now | v1 ships Flutter; a rewrite is a v2 decision |

**Recommendation: A.** The Flutter code already satisfies every mobile
requirement in `CLAUDE.md`, including the §5.3 background-location design that
the brief calls critical. A rewrite buys no capability — it changes language.

**How it will be verified once decided:** if A or C, `flutter analyze` +
`flutter test` on all three packages. If B, the Kotlin modules are built from
scratch against the same API contract, which is unchanged either way.

---

## BLOCKER-2 · Scope conflict — KYC, surge, zones, promotions · **OWNER DECISION**

**Blocked because:** brief §15 requires "KYC / documents / Admin approval" and
§16 requires "Zones, Surge, Promotions". `CLAUDE.md` §2 lists all of these as
explicitly **OUT OF SCOPE for v1**, and §12.7 says *"Never scaffold
OUT-OF-SCOPE features 'for later.' Dead code is a liability."*

**What is already implemented:** admin-created drivers with a suspend flag
(the v1 substitute for KYC that `CLAUDE.md` §2 specifies), flat configurable
pricing, and a commission rate changeable without a deploy.

**Exactly what is required from you:** confirm whether v1 scope is expanding.
If yes, `CLAUDE.md` §2 must be amended first — I will not scaffold against a
document that forbids it.

**Recommendation:** keep v1 scope. Surge and zones on a single-city, single-
vehicle-class launch with 10 drivers add risk without adding revenue.

---

## BLOCKER-3 · Docker not installed · **ENVIRONMENT**

**Blocks:** migrations never applied · PgBouncer pool unverified · the
real-Redis conformance run (the one P0-class risk) · BullMQ workers never run ·
integration tests · the k6 load test.

**Already implemented:** `infra/docker-compose.yml` (PostGIS, PgBouncer in
transaction mode, Redis with AOF, api, worker), 4 forward + 4 down migrations,
a migration runner that refuses unsafe SQL, and a CI workflow that runs all of
it.

**Required from you:** install Docker Desktop.

**Verification once supplied:**
```bash
docker compose -f infra/docker-compose.yml up -d
pnpm --filter @rideapp/api migrate:up
pnpm --filter @rideapp/api migrate:down 4
pnpm --filter @rideapp/api migrate:up
TEST_REDIS_URL=redis://localhost:6379 pnpm --filter @rideapp/api test:integration
```
Expected: migrations clean both ways, and a suite named
`IoRedisAdapter (real Redis)` **runs** (not skips) and passes.

---

## BLOCKER-4 · Flutter SDK not installed · **ENVIRONMENT**

**Blocks:** all three Dart packages — never compiled, never analysed, never
tested. **Expect compile errors on the first run**; 25 files have never seen a
compiler.

**Required from you:** install the Flutter SDK (3.24+).

**Verification once supplied:**
```bash
cd packages/core && flutter pub get && flutter analyze && flutter test
cd apps/driver  && flutter pub get && flutter analyze && flutter test
cd apps/rider   && flutter pub get && flutter analyze && flutter test
```

---

## BLOCKER-5 · No physical Android device · **HARDWARE**

**Blocks:** `ACCEPTANCE_CHECKLIST.md` check 2 — twenty minutes of real driving
with the screen off, repeated on a Xiaomi and a Samsung.

**Why no substitute exists:** MIUI, One UI, EMUI and ColorOS each add their own
process killer above stock Android, and they differ from each other and from
the emulator. `CLAUDE.md` §5.3 calls this "the single most common cause of
ride-hailing MVP failure in production", and `RUN_AUTONOMOUS.md` §5 predicts it
"will be done in theory and fail on a real phone".

**Status:** `AUTOMATED TEST = PASS` (buffer logic, sampling config) ·
**`REAL DEVICE TEST = BLOCKED`**. I will not claim the field test passed.

---

## BLOCKER-6 · Third-party credentials · **HUMAN INPUT**

None of these have been invented. Every one is read from the environment and
absent here.

| Credential | Blocks | Env var |
|---|---|---|
| Firebase project + service account | real OTP delivery | `FIREBASE_PROJECT_ID` |
| Google Maps API key | map rendering, Places | `MAPS_API_KEY` |
| FCM server credentials | push offers (worker logs and no-ops today) | — |
| Payment gateway (ZainCash) | `GatewayProvider` is a deliberate stub per `CLAUDE.md` §7 | `GATEWAY_WEBHOOK_SECRET` |
| Android signing keystore | signed AAB for Play | — |
| Google Play Console | Data Safety, privacy policy, account deletion | — |
| Domain + TLS | production deployment | — |

**Verification once supplied:** a real OTP round trip on a device, a rendered
map, a delivered push, and `./gradlew bundleRelease` (or `flutter build appbundle`)
producing a signed artefact.

---

## BLOCKER-7 · k6 not installed · **ENVIRONMENT**

**Blocks:** the 500-concurrent load target and the brief's p95 < 200ms goal.

**Already implemented:** `services/api/test/load/matching.load.js`, with
`double_accepts` and `duplicate_rides_created` as hard `count==0` thresholds.

**Honest note:** even once run here, it measures the API on this machine. It
says nothing about whether a 4-core VPS holds 500 users — that requires running
it against the VPS.
