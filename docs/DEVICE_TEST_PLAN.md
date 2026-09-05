# Device test plan

`CLAUDE.md` §5.3 calls background location "the single most common cause of
ride-hailing MVP failure in production". This is the plan for finding out
whether that applies to this build, and it cannot be run on an emulator.

**Devices: one Xiaomi, one Samsung.** Not because those two are special, but
because they are the two most aggressive at killing background work and are the
two most common in this market. An emulator runs a stock AOSP power manager and
will pass everything here regardless of whether the app is correct.

Borrowing both for an afternoon is sufficient.

---

## Before you start

On each device:

1. Install the **driver** debug build.
2. Sign in.
3. Grant location: **Allow all the time**, not "while using the app".
4. Accept the battery-optimisation exemption when the app asks. If you decline
   it, note that — a run with it declined is also worth doing once, because
   plenty of real drivers will decline it.
5. On Xiaomi additionally: Settings → Apps → Darb Driver → **Autostart ON**, and
   Battery saver → **No restrictions**. Xiaomi kills background services
   regardless of the standard exemption, and this is not something the app can
   set for itself.

Have the server logs open: `driver.location` ingest lines are the evidence.

---

## The runs

Record for each: how many location updates arrived, the longest gap, and whether
the foreground notification survived.

### 1. Screen on, app foreground — 10 minutes
Baseline. If this fails, nothing else is worth running.

**Pass:** updates roughly every 5s, no gap over 15s.

### 2. Screen off — 30 minutes
The first real test. Lock the screen and leave it.

**Pass:** updates continue throughout. **This is where a missing or misdeclared
foreground service shows up**, and a failure here is usually total rather than
partial — updates stop within a minute or two of the screen going off.

### 3. App backgrounded, screen on — 30 minutes
Open another app and leave it there.

**Pass:** updates continue; the persistent notification stays visible.

### 4. Moving in a vehicle — 30 to 60 minutes
Drive a real route. This is the only run that exercises real GPS behaviour,
cell handover, and accuracy variation together.

**Pass:** the track on the rider's map follows the road. Watch for coordinates
that jump kilometres and back — outlier filtering is the thing under test.

### 5. Network switching
Wi-Fi → mobile → Wi-Fi, while online.

**Pass:** the buffer flushes after each switch, no update is permanently lost,
and the WebSocket reconnects. `RealtimeClient` backs off exponentially and
resyncs after `ready`; this is where you confirm the resync actually happens.

### 6. Battery saver on — 20 minutes
Enable the system battery saver and lock the screen.

**Pass or documented fail.** Some devices will throttle regardless. What matters
is knowing which, and whether the app recovers when saver is switched off — not
pretending it never happens.

### 7. No connectivity — 10 minutes
Aeroplane mode with the driver online, then restore.

**Pass:** locations buffer locally and flush on reconnect. Nothing is lost, and
nothing is replayed with a stale timestamp — every sample carries the time it
was recorded, not the time it was sent.

### 8. GPS off, then on
Turn off location services for 5 minutes, then back on.

**Pass:** the app reports the degraded state rather than silently sending
nothing, and resumes without a restart.

### 9. Kill and relaunch
Swipe the app away from recents, wait a minute, reopen.

**Pass:** state is restored, the socket reconnects, and if the driver was
online they are still online or are told clearly that they are not.

### 10. Reboot
Restart the phone with the driver online.

**Expected:** the driver is offline. That is acceptable and correct. What must
not happen is the app believing it is still online while sending nothing —
that is a driver who thinks they are earning and is not.

### 11. Long soak — 2 to 4 hours
Driver online, screen off, phone in a pocket.

**Pass:** updates throughout, no memory growth, notification alive, and the
server's `stale driver` sweep never fires for this driver.

---

## The end-to-end run

With both devices, one as rider and one as driver:

```
driver online → rider requests → offer arrives → accept → arrive →
start → drive → complete → both see the final state
```

Measured server-side on 2026-08-24, single user, everything on one machine:
**offer arrives 36–66 ms after the ride request**. On a real handset over a
mobile network, expect materially more. The target is 3 seconds.

Then repeat with adversity:

- Rider force-closes the app mid-ride and reopens it.
- Driver loses signal between accepting and arriving.
- Two drivers try to accept the same offer. Exactly one may win — this is
  covered by an automated test at 961 concurrent attempts, but seeing it on
  two handsets is worth the minute it takes.
- Rider cancels while the driver is en route.

---

## Recording the result

For each run: device, Android version, duration, updates received, longest gap,
pass or fail, and any vendor setting you had to change.

A run that needed Xiaomi's Autostart toggled on is not a pass — it is a pass
**with a prerequisite**, and that prerequisite belongs in the driver onboarding
screen. Write it down.

**Do not mark any of this passed from an emulator.**
