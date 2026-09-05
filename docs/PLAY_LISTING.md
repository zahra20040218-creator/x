# Play Console — listing and Data safety

Everything here is derived from the code, with the file that proves each
claim. Where a question cannot be answered from the code it says so and names
who has to answer it.

**Read the Data safety section as a compliance document, not marketing copy.**
Declaring it wrongly is a policy violation, not a paperwork error, and the
declaration this app has to make — precise location, collected continuously in
the background — is one Google reviews closely.

---

## 1. What the app is

| Field | Value |
|---|---|
| App name | **ALY** (Arabic devices show **الي**) |
| Package | `iq.rideapp.rideapp_rider` |
| Category | Maps & Navigation |
| Content rating | Everyone (no user-generated content, no ads, no purchases in-app) |
| Default language | Arabic (Iraq) — `ar-IQ` |
| Secondary | English |
| Countries | Iraq only |

The package name reads `rider` and the app is not rider-only. That is
deliberate and permanent: `applicationId` cannot change after publishing, and
CLAUDE.md:29 fixes it. The name users see is `ALY`, from
`android/app/src/main/res/values/strings.xml`.

---

## 2. Data safety — the answers, with their evidence

### Location · Precise location

| Question | Answer |
|---|---|
| Collected? | **Yes** |
| Shared with third parties? | **No** |
| Processed ephemerally? | **No** — some of it is stored |
| Required or optional? | **Required** for Driver mode; optional for Rider mode |
| Purpose | App functionality (ride matching and navigation) |

**Declare background collection.** The driver's position is sampled while the
app is not in the foreground, through an Android foreground service —
`ACCESS_BACKGROUND_LOCATION` and `FOREGROUND_SERVICE_LOCATION` are both in the
manifest, and the service is declared with `foregroundServiceType="location"`.
Google cross-checks the declaration against the manifest, and a mismatch here
is the most common reason a ride-hailing app is rejected.

**Retention:** driver location history is deleted after **90 days**
(`location_retention_days`, migration 0014). Live positions are held in Redis
only and expire with the driver's session (CLAUDE.md §3.1). If an operator
changes that config value, this section must change with it.

**Rider location** is foreground-only. The rider app has deliberately never
requested `ACCESS_BACKGROUND_LOCATION` — asking a passenger for "allow all the
time" is an unjustifiable privacy ask, and the rider manifest says so in a
comment.

### Personal info · Phone number

| Question | Answer |
|---|---|
| Collected? | **Yes** |
| Shared? | **No** |
| Purpose | Account management (this is the login identity) |
| Required? | **Yes** |

Stored E.164 (`users.phone_e164`). Verified through Firebase Phone Auth, which
means Google receives it as the identity provider — that is a *processor*
relationship, not third-party sharing, and is declared as such.

**A driver never sees a rider's phone number and vice versa.** There is an
end-to-end test asserting exactly that (`api.e2e.test.ts`, "the driver never
receives the rider phone number").

### Personal info · Name

| Question | Answer |
|---|---|
| Collected? | **Yes** |
| Shared? | **No** |
| Purpose | App functionality (the other party sees who they are meeting) |
| Required? | **No** — riders who leave it blank are stored as `راكب` |

### Financial info

**Not collected.** No card, no bank account, no payment instrument reaches the
app. Fares are cash between rider and driver; the ledger records that a
transfer happened, never how it was funded. `GatewayProvider` is a stub that
throws (CLAUDE.md §7).

Declare **no** financial data. Revisit only if a live payment rail is ever
integrated — see `DECISIONS.md` D-019.

### Messages, Photos, Contacts, Calendar, Files, Health

**None collected.** No in-app chat (CLAUDE.md §2 keeps it out of scope), no
document upload, no contact access.

### App activity · Diagnostics

Crash reports and performance data if Crashlytics is enabled. **Currently it is
not** — check before submitting, because this section is wrong the moment
somebody adds the SDK.

### Security answers

| Question | Answer |
|---|---|
| Encrypted in transit? | **Yes** — `usesCleartextTraffic="false"`, and the app refuses to start on a build pointing at `http://` |
| Can users request deletion? | **See below** |

**Account deletion: yes, in-app.** `POST /me/delete`, reachable from the
profile screen in both Rider and Driver mode.

Answer the Play question as **"users can request account deletion in the
app"**, and disclose the retention honestly: it ANONYMISES. Phone number,
name, Firebase identity, device tokens, sessions and driver location history
are erased. Rides, ride events, payments and ledger entries survive, pointing
at an anonymous id, because 18 foreign keys to `users(id)` are
`ON DELETE RESTRICT` and `ledger_entries` is append-only with database
triggers (CLAUDE.md §6.3). Play permits retaining what is required for
legitimate financial purposes when it is disclosed — this is that disclosure.

The in-app confirmation says the same thing in the user's own language before
they proceed, rather than only here.

---

## 3. Permissions that need a written justification

Play asks for these individually, in the Console, with a video for some.

| Permission | Justification |
|---|---|
| `ACCESS_BACKGROUND_LOCATION` | A driver's position must reach the rider while the driver's screen is off and they are driving. Collected only while the driver is explicitly ONLINE, never for riders. |
| `FOREGROUND_SERVICE_LOCATION` | Mandatory from Android 14 for the same service. Without it the service is killed at startup with a SecurityException. |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Android Doze stops the location service minutes after the screen goes off, which reads to a rider as a driver who stopped moving. Requested at onboarding with an explanatory screen (`BatteryExemptionScreen`), never silently. |
| `RECEIVE_BOOT_COMPLETED` | Restores the service after a reboot mid-shift. |
| `POST_NOTIFICATIONS` | The persistent foreground-service notification, and ride offers. |

The background location declaration usually requires a **demo video** showing
the in-app disclosure, the permission prompt, and the feature working. Record
it against the real onboarding flow, not a mock.

---

## 4. Before the first upload

- [ ] **Enrol in Play App Signing.** Google re-signs with its own key, producing
      a **fourth** SHA fingerprint visible only in Console → Setup → App signing,
      and only after the first upload. Add it to Firebase or sign-in works on
      your machine and fails for everyone who installs from the store. This is
      the single most commonly missed step.
- [ ] Upload to **internal testing** first, never production.
- [ ] Privacy policy URL. The text is written and matches this document
      section for section — `docs/PRIVACY_POLICY.md`. It needs THREE things
      before it counts: the bracketed operator name, address and contact email
      filled in; a lawyer's review; and a public, stable URL. Play checks the
      link resolves.
- [ ] Check **Android Developer Verification** status for Iraq and for your
      distribution channel. Enforcement began 2026-09-30 in four countries and
      is expanding; confirm what applies rather than trusting any summary,
      including this one.

## 5. What is NOT ready

Recorded here so nobody discovers it during a submission window:

| Item | State |
|---|---|
| Privacy policy | **Written** (`docs/PRIVACY_POLICY.md`), Arabic and English. Needs operator details, legal review, and hosting at a public URL. |
| Firebase App Check | Not implemented — `docs/EXTERNAL_SETUP.md` §5 |
| Crashlytics | Not integrated, so the Diagnostics answer above is currently "none" |
| Physical device testing | Never done. `docs/DEVICE_TEST_PLAN.md` |
