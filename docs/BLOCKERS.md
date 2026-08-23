# BLOCKERS.md

Things that cannot proceed without a human decision or a human-supplied
credential. **No value here has been invented or guessed.**

**Verified 2026-08-23** by running the checks, not by reading a prior report:

```
$ docker --version        docker: command not found
$ docker compose version  docker: command not found
$ psql / pg_isready       NOT FOUND
$ redis-cli / redis-server NOT FOUND
$ k6                      NOT FOUND
$ flutter / dart          NOT FOUND
$ gradle                  NOT FOUND
$ adb devices             daemon started - List of devices attached: (none)
$ netstat | grep 5432|6432|6379   (nothing listening)
```

`adb` is present but **no device is attached**, so the physical-device blocker
is confirmed rather than assumed.

---

## Category: OWNER DECISION REQUIRED

These two are architectural and commercial. They are recorded, not resolved,
and **no code was written in either direction.**

---

## BLOCKER-1 · Mobile + Admin stack conflict · **RESOLVED — OWNER DECIDED 2026-08-23**

> **Decision: KEEP the existing stack.** Flutter, Refine, NestJS, raw `pg`.
> No migration. The brief's Kotlin/Next.js/Prisma requirement is recorded
> as a documented conflict and is **not** being acted on. See DECISIONS.md
> D-013.
>
> **This unblocks nothing on its own.** The mobile apps still have never
> been compiled, because BLOCKER-4 (no Flutter SDK) is untouched by a
> stack decision. Nothing moved to `DONE` as a result.

| Layer | Project Brief | CLAUDE.md (binding) | Current implementation | Decision required |
|---|---|---|---|---|
| Mobile | Kotlin · Jetpack Compose · Hilt · Room | **Flutter** | **Flutter — 25 `.dart` files, 0 `.kt`** | Which stack ships v1? |
| Admin | Next.js App Router | **Refine (React)** | **Refine + Vite** | Which framework ships v1? |
| DB access | Prisma or TypeORM | (unspecified) | Raw `pg` + hand-written SQL | Introduce an ORM? |

**Why this is not mine to decide:** `CLAUDE.md` §0 states — *"If a user request
in a session conflicts with a rule in this file, stop and say so before writing
code. Do not silently comply."* Rewriting two mobile apps is weeks of work that
discards functioning code.

**What I did NOT do, per your instruction:**
- did not rewrite Flutter to Kotlin
- did not treat Flutter as satisfying the Kotlin requirement
- did not delete Dart files to hide the conflict
- did not edit `CLAUDE.md` to make the conflict disappear
- did not claim it resolved

**Options:**

| Option | Cost | Consequence |
|---|---|---|
| **A. Keep Flutter + Refine** | zero | Brief §5 is amended; `CLAUDE.md` stays authoritative |
| **B. Rewrite in Kotlin + Next.js** | weeks; discards all mobile work | `CLAUDE.md` §1 must be formally amended **first** |
| **C. Flutter now, Kotlin later** | zero now | v1 ships Flutter; rewrite is a v2 decision |

**Recommendation: A.** The Flutter code satisfies every mobile requirement in
`CLAUDE.md`, including the §5.3 background-location design. A rewrite buys no
capability — it changes language.

**Verification once decided:** if A or C — `flutter analyze` + `flutter test` on
all three packages. If B — Kotlin modules built against the same API contract,
which is unchanged either way.

---

## BLOCKER-2 · Scope conflict · **SCOPE DECISION PENDING (owner, 2026-08-23)**

> **Decision: deliberately deferred.** KYC, driver approval, surge, zones
> and promotions are neither built nor deleted. `CLAUDE.md` was not edited
> to make the conflict disappear. See DECISIONS.md D-014.

| Requirement | Brief | CLAUDE.md | Current implementation | Decision required |
|---|---|---|---|---|
| **KYC / documents** | §15 requires | §2 **OUT OF SCOPE** | Admin creates drivers manually; suspend flag | Expand v1 scope? |
| **Driver approval flow** | §15 requires | §2 **OUT OF SCOPE** | `is_suspended` boolean only | Expand v1 scope? |
| **Surge pricing** | §16 requires | §2 **OUT OF SCOPE** | Flat configurable tariff | Expand v1 scope? |
| **Zones** | §16 requires | §2 **OUT OF SCOPE** | Single city, no zone model | Expand v1 scope? |
| **Promotions** | §16 requires | §2 **OUT OF SCOPE** | None | Expand v1 scope? |

**Why not resolved:** `CLAUDE.md` §12.7 — *"Never scaffold OUT-OF-SCOPE features
'for later.' Dead code is a liability."* Building these against a document that
forbids them would violate the constitution; deleting the requirement would hide
your brief.

**Neither added nor removed. Recorded.**

**Recommendation:** keep v1 scope. Surge and zones on a single-city,
single-vehicle-class launch with 10 drivers add risk without adding revenue.

---

## Category: ENVIRONMENT REQUIRED

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

## Category: PHYSICAL DEVICE REQUIRED

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

## Category: EXTERNAL ACCOUNT REQUIRED

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


---

## Category: TECHNICAL — decided, not blocked

Recorded here so the decisions are visible, but **these are not blockers**.

### Rate-limiter failure policy: **RISK-TIERED** — superseded the blanket fail-open

**Superseded 2026-08-23.** The blanket fail-open below was the finding S-7,
not the desired end state. The behaviour is now chosen per endpoint by its
`RiskTier`: `OPERATIONAL` still fails open, `CRITICAL` and `STANDARD` degrade
to a stricter in-process limiter. Full reasoning and the per-endpoint table
are in `docs/RATE_LIMIT_POLICY.md`.

The original reasoning is kept below because the availability half of it still
holds and still explains why `OPERATIONAL` fails open.

When Redis is unreachable the limiter **allows** the request and logs a warning
at `warn` level (`event: ratelimit.unavailable`).

**Security reasoning:** rate limiting is a protective control, not a correctness
one. Failing closed converts a Redis blip into a total API outage — riders
cannot request rides and drivers cannot go online — which is a far larger
incident than a window of unthrottled OTP requests. Fail-closed would also make
Redis a hard single point of failure for the entire platform.

**The cost, stated plainly:** while Redis is down there is **no rate limiting at
all**, so OTP abuse is possible during that window. This is accepted, monitored
via the warn log, and is why the status is `PARTIAL`, not `DONE`.

**Verified in the real compiled binary:** 13 requests produced exactly 13
`ratelimit.unavailable` events with no Redis present.

**This policy was chosen for the security reason above, not to make a test
green.** Reversing it is a one-line change (`return true` → `throw`) if you
prefer availability-over-protection to be inverted.

### Audit-log write failure: **swallow and log loudly** — deliberate

An audit INSERT failing inside the caller's transaction would roll back a
legitimate wallet top-up. Losing one audit row is bad; losing the operator's
money movement is worse. The swallow is not silent — it emits
`event: audit.write_failed` at `error`.
