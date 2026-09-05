# External setup

Everything here needs an account, a console, or a physical device. Nothing here
can be done inside the repository, and the code for all of it is already written
and waiting.

For each item: **where**, **what to add**, **where the value comes from**, and
**how to check it worked**.

---

> **Update, 2026-09-05 — one app now, not two.**
>
> `apps/aly` exists (CLAUDE.md §1.1) and is the app that ships. It carries the
> **rider** `applicationId`, `iq.rideapp.rideapp_rider`, and is signed with the
> **rider** upload key — verified on a real release build:
>
> ```
> package: name='iq.rideapp.rideapp_rider'   application-label:'ALY' / 'الي'
> Signer #1 SHA-1: 52:30:A8:A2:3D:7D:E1:B3:92:8B:4D:61:FD:F4:DE:8A:4B:4A:E2:6B
> ```
>
> So everywhere below reads "rider", it now means ALY, and the **driver**
> package and its fingerprints matter only while `apps/driver` is still
> installed on someone's phone. Concretely:
>
> - `google-services.json` (rider) also goes to `apps/aly/android/app/`.
> - `MAPS_API_KEY` also goes to `apps/aly/android/local.properties`.
> - Ship with `scripts/build-release.sh aly …`.
>
> `apps/rider` and `apps/driver` are deliberately still present and still built
> — see DECISIONS.md D-023 for why retiring them is not reversible.

## 1. Firebase — blocks sign-in and push

Without this there is no authentication at all, so it blocks everything else.

**Where:** [console.firebase.google.com](https://console.firebase.google.com) →
new project → add two Android apps.

**Package names** (final; an `applicationId` cannot change after publishing):

```
iq.rideapp.rideapp_rider
iq.rideapp.rideapp_driver
```

### Certificate fingerprints

Register **all** of these. They are not interchangeable, and Firebase Phone Auth
now uses SHA-256 as well as SHA-1.

| App | Build | SHA-1 | SHA-256 |
|---|---|---|---|
| Both | Debug | `24:0C:FC:66:42:BB:FB:1D:2A:AE:0D:1E:E7:EA:B7:43:7D:50:8F:2B` | `1E:F5:D9:03:10:3A:F8:7C:6B:E7:85:75:B6:2A:FE:EA:35:D1:96:2E:21:F2:C0:F0:92:B9:93:F7:EF:22:4A:C2` |
| Rider | Upload | `52:30:A8:A2:3D:7D:E1:B3:92:8B:4D:61:FD:F4:DE:8A:4B:4A:E2:6B` | `2C:96:FD:31:1A:E2:52:D1:63:54:4F:5F:52:69:DC:0C:7A:23:C4:AF:95:DA:FD:C5:C0:82:74:CB:11:79:C0:FE` |
| Driver | Upload | `CE:9F:3F:8C:74:91:B6:4A:30:EE:EE:9D:0B:AB:EC:CD:31:30:B5:C3` | `AB:4F:40:F1:FA:0C:F6:8A:97:7B:31:95:71:E3:02:78:99:84:25:87:C8:0B:91:D8:BB:DD:76:39:26:47:48:A9` |
| Both | **Play App Signing** | *not obtainable locally* | *not obtainable locally* |

The debug fingerprint is shared by both apps because both use the same
`~/.android/debug.keystore`.

**The one that catches people:** Google re-signs your bundle with its own key.
That produces a **fourth** fingerprint, visible only in Play Console → Setup →
App signing, and only after the first upload. If you do not add it, sign-in
works on your machine and fails for everyone who installs from the store.

Re-derive any of the local ones with:

```bash
keytool -list -v -keystore ~/keystores/rider-upload-key.jks -alias upload
```

### What to download and where to put it

| File | Destination | Verify |
|---|---|---|
| `google-services.json` (rider) | **`apps/aly/android/app/`** | app starts past `Firebase.initializeApp()` |
| `google-services.json` (rider) | `apps/rider/android/app/` | same — only while that app still ships |
| `google-services.json` (driver) | `apps/driver/android/app/` | same — only while that app still ships |

Enable **Authentication → Sign-in method → Phone**, and add test numbers there
while developing so you are not spending real SMS.

### Backend credentials

Project settings → Service accounts → Generate new private key. The JSON goes
into `FCM_SERVICE_ACCOUNT_JSON` **on the server only**.

Never in the APK, never in the repository, never in a build argument. The app
does not need it and cannot use it.

**Check it worked:** with the variable set, the API logs `push.configured` at
startup instead of `push.unconfigured`.

---

## 2. Google Maps — blocks the map screens

**Where:** [console.cloud.google.com](https://console.cloud.google.com), same
project as Firebase.

Enable **Maps SDK for Android**. Enable Geocoding, Places or Routes only if you
actually call them — each is billed separately and the free allowances differ
per SKU.

**Restrict the key.** A Maps key inside an APK is extractable; treating it as a
secret is the wrong model. The protection is the restriction:

- Application restriction: **Android apps**
- Add both package names with **all four** SHA-1 fingerprints above
- API restriction: only the APIs you enabled

Set a **billing budget and alert** before you ship. An unrestricted key that
leaks is billed to you.

**Where it goes:** `apps/<app>/android/local.properties`, which is gitignored:

```
MAPS_API_KEY=...
```

**Check it worked:** the map renders tiles. A restriction mismatch shows a grey
grid and an authorisation failure in logcat — which is exactly why the app
refuses to instantiate the map widget at all when no key is configured, rather
than showing you a grey square and letting you guess.

---

## 3. Production endpoint — blocks a shippable build

Both release bundles in `~/rideapp-artifacts/` were built against
`https://api.darb.iq/v1`, **a placeholder**. Replace it with your real domain.

You need: a domain, a VPS, and TLS. Then:

```bash
scripts/build-release.sh rider  https://api.YOURDOMAIN/v1 wss://api.YOURDOMAIN/v1/realtime
scripts/build-release.sh driver https://api.YOURDOMAIN/v1 wss://api.YOURDOMAIN/v1/realtime
```

The script refuses `http://` and `ws://`, and the app refuses to start on a
build that points at a development host.

**Check it worked:** install the bundle and confirm it does not show the
"This build is misconfigured" screen.

---

## 4. Physical devices — the real launch gate

**One Xiaomi and one Samsung.** Borrowing them for an afternoon is enough; this
does not need a purchase.

No emulator reproduces vendor process-killing, and background location is the
single most common cause of ride-hailing MVP failure in production. See
[DEVICE_TEST_PLAN.md](DEVICE_TEST_PLAN.md) for what to run.

**This is the item that decides whether the project is ready.** Everything else
on this page is a procedure.

---

## 5. Firebase App Check — not yet implemented

Not built. It needs a Firebase project to verify tokens against, and there was
no value in writing verification against a project that does not exist.

When the project exists: enable App Check with the Play Integrity provider, and
verify the token server-side in a guard alongside the existing auth guard. App
Check answers "is this a genuine build of my app?" — it is **not** a substitute
for authentication, which answers "who is this?"

---

## 6. Play Console

- Enrol in **Play App Signing** (default for new apps).
- Register both package names.
- Upload to internal testing first.
- Complete the **Data safety** form. Declare precise location, collected
  continuously while the driver is online, used for ride matching. Declaring
  this wrongly is a policy violation, not a paperwork error.
- Check the current status of **Android Developer Verification**. Enforcement
  began 2026-09-30 in Brazil, Indonesia, Singapore and Thailand for apps
  distributed through participating stores, expanding in 2027. Confirm what
  applies to Iraq and to your distribution channel before you rely on any
  summary of it — including this one.

---

## 7. Legal — the only item no engineer can close

Which driver documents are required to operate a ride-hailing service in Iraq is
a question for a lawyer and the transport authority.

The system supports it either way: `required_driver_documents` in
`platform_config` is empty by default, and setting it takes effect within 30
seconds without a deploy. See `DECISIONS.md` D-018.

```sql
UPDATE platform_config
   SET value = 'DRIVING_LICENCE,VEHICLE_REGISTRATION'
 WHERE key = 'required_driver_documents';
```

Enabling it immediately blocks every driver who does not hold verified,
unexpired copies of those documents.
