# Release

How to produce a bundle that is actually shippable, and what stops you if you
don't.

Everything here is enforced somewhere — by Gradle, by the app at startup, or by
`scripts/build-release.sh`. Nothing in this document is advisory.

---

## 1. What a release needs

| Input | Where it comes from | What happens without it |
|---|---|---|
| Upload keystore | `apps/<app>/android/key.properties`, or `ANDROID_KEYSTORE_*` env | **Gradle fails the build.** No debug-signed fallback. |
| `API_BASE_URL` | `--dart-define` at build time | App refuses to start and says so. |
| `WS_URL` | `--dart-define` at build time | Same. |
| `MAPS_API_KEY` | env, or `android/local.properties` | Map screens show the "not configured" state rather than a blank grey tile. |
| `google-services.json` | Firebase console, per app | `Firebase.initializeApp()` throws at startup; sign-in and push cannot work. |

None of these are in the repository, and none of them should be.

---

## 2. Signing

Two upload keys exist, one per app, generated 2026-08-24 and valid until
2054-01-09. They live **outside** the repository, in `~/keystores/`.

```
rider-upload-key.jks    alias: upload
driver-upload-key.jks   alias: upload
```

Fingerprints — these are public, and are what Google Play, Firebase and the
Maps key restriction need:

| App | SHA-1 |
|---|---|
| Rider | `52:30:A8:A2:3D:7D:E1:B3:92:8B:4D:61:FD:F4:DE:8A:4B:4A:E2:6B` |
| Driver | `CE:9F:3F:8C:74:91:B6:4A:30:EE:EE:9D:0B:AB:EC:CD:31:30:B5:C3` |

Passwords are in `apps/<app>/android/key.properties`, which is gitignored, and
in no other place. **Back these two files and the two `.jks` files up now.**
A signing key cannot be changed after the first upload to Play; losing it means
the app can never be updated again, only republished under a new package name.

### Why the build fails rather than falling back

The Flutter template signs release with the debug key so `flutter run --release`
works. That is fine for a template and fatal for a product: Play rejects a
debug-signed bundle, and the case where it doesn't is worse — an artifact
everyone believes carries the upload key when it doesn't. `app/build.gradle.kts`
therefore checks the task graph and throws.

Verify what a bundle was actually signed with:

```bash
unzip -p app-release.aab META-INF/UPLOAD.RSA | keytool -printcert
```

`Owner: CN=Darb` is the upload key. `CN=Android Debug` is the debug key and must
never reach Play.

---

## 3. Building

```bash
scripts/build-release.sh rider  https://api.example.iq/v1 wss://api.example.iq/v1/realtime
```

The script refuses to run without both URLs, and refuses `http://` or `ws://`.
It exists because `flutter build appbundle --release` on its own succeeds while
producing a bundle aimed at `http://10.0.2.2:3000/v1` — the Android emulator's
route to a developer's machine. That bundle installs, opens, and fails every
request in a way users read as a bad connection.

The app now refuses to start on such a build and names the missing flag
(`EndpointConfig`), but the *build* still succeeds, so the script is the earlier
line of defence.

---

## 4. Cleartext

Release bundles are strictly TLS: `usesCleartextTraffic="false"` in both main
manifests.

Debug builds get `src/debug/res/xml/network_security_config.xml`, which permits
cleartext to `10.0.2.2`, `10.0.3.2`, `localhost` and `127.0.0.1` and nothing
else. Without it the development default cannot connect at all — Android has
blocked cleartext by default since API 28, and the symptom is a network error
indistinguishable from a server that isn't running.

That file is under `src/debug`, so it is not merged into a release bundle.

---

## 5. R8 / shrinking

Deliberately **off**.

Flutter compiles Dart ahead of time, so shrinking only touches the Java/Kotlin
shim — a few hundred KB. Against that, `firebase_messaging` and
`google_maps_flutter` both resolve classes reflectively, and a missing keep rule
fails at runtime on a handset rather than at build time. Turning it on is a
one-line change in `app/build.gradle.kts` once there is a device to verify it
on. It should not be turned on before then.

---

## 6. Database

Migrations are forward-only and reversible. Before a release:

```bash
DATABASE_URL=... node dist/db/migrate.js up
```

`0008` and `0009` add keyset indexes and have been run down and up on a real
PostgreSQL. `src/db/migrations.test.ts` pins the migration list, so adding one
without updating that test fails the suite — which is intentional.

---

## 7. Checklist

- [ ] `pnpm test` green, including `REAL_INFRA=1`
- [ ] `flutter test` green in `packages/core`, `apps/rider`, `apps/driver`
- [ ] `flutter analyze` — zero errors, zero warnings
- [ ] Migrations applied on the target database
- [ ] `google-services.json` in place for both apps
- [ ] `MAPS_API_KEY` set, and both SHA-1s registered against it
- [ ] Bundle built via `scripts/build-release.sh`, not by hand
- [ ] Signature checked with `keytool -printcert`
- [ ] Installed on a physical Xiaomi and a physical Samsung, and the driver
      background-location test in §5.3 of `CLAUDE.md` actually run

The last item is not a formality. Aggressive process-killing on those two
vendors is the single most common cause of ride-hailing MVP failure in
production, and no emulator reproduces it.
