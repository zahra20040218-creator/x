# Device Streaming — session checklist

Android Device Streaming gives ADB access to a **real** handset in a Google data
centre. Not an emulator. That closes most integration doubt in one sitting.

**It does not replace the §5.3 test.** See "What this cannot answer" at the end
— that part still needs a phone in your hand, and it is the part most likely to
reveal remaining work.

---

## Before you connect

```bash
scripts/device-session.sh start
```

Brings up PostgreSQL checks, migrations, fixtures, the API, **the worker**, and
the ADB bridge. It refuses to continue if Postgres or Redis is down, and tells
you which.

The worker matters: **ride dispatch happens there**. Without it a ride is
created and never offered to anyone, and nothing about the API looks wrong.

Then, in Android Studio: **Device Manager → Firebase → pick a device → Start**.

Once it appears:

```bash
scripts/device-session.sh bridge     # if start ran before the device attached
scripts/device-session.sh install
```

Keep a second terminal open on:

```bash
scripts/device-session.sh watch
```

That is the ground truth. What the phone shows is a claim; what the server
logged is the evidence.

> **The bridge dies on every disconnect.** Streaming sessions drop. When
> anything stops working, re-run `bridge` before assuming a bug.

---

## Test number

```
+9647700000001      code 123456
```

A Firebase test number. No SMS is sent, so it works on the Spark plan and
nothing is billed. Use it on **both** apps.

---

## The checks

Record each as PASS / FAIL / SKIPPED. A FAIL with the server log attached is
worth more to me than ten passes.

### A — It runs at all

| # | Do | Expect |
|---|---|---|
| A1 | Open Darb Rider | Arabic, right-to-left, no crash |
| A2 | Open Darb Driver | Same |
| A3 | Check the app names on the launcher | `درب` and `سائق درب`, not package names |

**A crash here is the one that matters most.** `Firebase.initializeApp()` runs
before anything is drawn — if the config is wrong the app dies on a white
screen. Get the stack trace: `adb logcat -d | grep -i firebase`.

### B — Sign-in

| # | Do | Expect |
|---|---|---|
| B1 | Rider: enter `+9647700000001` | Code screen, no error |
| B2 | Enter `123456` | Signed in |
| B3 | `watch` terminal | an `auth` event appears |
| B4 | Driver: same number | Signed in |
| B5 | Close and reopen the rider | Still signed in — no re-entry |

B5 tests that the session survives a restart. Tokens are in encrypted storage;
if it asks for the number again, that store is not persisting.

### C — The driver goes online

| # | Do | Expect |
|---|---|---|
| C1 | Grant location **Allow all the time** | — |
| C2 | Accept the battery exemption screen | — |
| C3 | Toggle online | Switch stays on |
| C4 | `watch` | `driver.location` events start, roughly every 5s |
| C5 | Persistent notification in the shade | Present, and stays |

If C3 fails with a document message, the compliance policy is enabled. Either
verify the documents in the admin panel or clear the policy:

```sql
UPDATE platform_config SET value='' WHERE key='required_driver_documents';
```

### D — The ride

| # | Do | Expect |
|---|---|---|
| D1 | Rider: pick pickup and destination | Fare estimate appears |
| D2 | Request the ride | `ride.dispatched` in `watch` |
| D3 | **Driver receives the offer** | Offer sheet appears |
| D4 | Time D2 → D3 | Under 3 seconds |
| D5 | Accept | Rider's screen changes without being touched |
| D6 | Arrived → Start → Complete | Each transition reaches both apps |
| D7 | Rider: receipt | Settled fare, not an estimate |

**D3 and D5 are the point of the whole session.** They are what the realtime
channel was rebuilt for. Measured server-side at 36–436 ms; over a data-centre
network expect more, but nowhere near 3 seconds.

If D3 never arrives: check `watch` for `realtime.published`. `receivers:0`
means the driver's socket is not connected — usually the bridge died.

### E — Adversity, via ADB

| # | Do | Expect |
|---|---|---|
| E1 | `adb shell svc wifi disable` mid-ride, wait 30s, re-enable | Reconnects; no data lost |
| E2 | `adb shell am force-stop iq.rideapp.rideapp_driver`, reopen | Still online, or clearly says it is not |
| E3 | `adb shell dumpsys deviceidle force-idle` for 5 min | Location updates continue |
| E4 | `adb shell dumpsys deviceidle unforce` | Recovers |
| E5 | Two riders request at once | Two different drivers, never the same one |

E3 is the closest this can get to §5.3. It exercises Doze, which is a genuine
part of the problem — but not vendor process-killing, and not a real screen-off
hour.

### F — What it must never do

| # | Check |
|---|---|
| F1 | The driver never sees another driver's ride |
| F2 | The rider never sees another rider's ride |
| F3 | No screen shows a raw status like `IN_PROGRESS` — Arabic only |
| F4 | No English fallback text anywhere in the Arabic UI |
| F5 | A rejected offer goes to another driver, not nowhere |

---

## What this cannot answer

| Not testable here | Why |
|---|---|
| GPS while moving | The device is bolted in a rack |
| Wi-Fi ↔ mobile handover | One data-centre network |
| A screen-off hour | Sessions are time limited, harder on Spark |
| Xiaomi MIUI process killing | Depends on the device list; usually Pixel and Samsung |
| Real battery behaviour | Permanently on mains power |

**The remaining physical test is one hour, on a borrowed phone:**

```
driver online → screen off → 30 minutes → did updates continue?
+ a drive around the block
+ Wi-Fi ↔ mobile data
+ Xiaomi Autostart enabled
```

That hour is the one that can still reveal unfinished work. Everything on this
page is integration confidence, which is worth having first — it means the hour
with the phone is spent on the question only a phone can answer.

---

## Sending me the result

Per check: the number, PASS/FAIL, and for any failure the `watch` output around
it plus `adb logcat -d | tail -50`.

Do not summarise a failure as "it didn't work". The log line is the thing.
