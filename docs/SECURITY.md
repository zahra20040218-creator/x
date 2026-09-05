# Security

What is enforced, where, and what is still open. Scanned and verified
2026-08-24.

---

## Secrets

| Check | Result |
|---|---|
| Secret-shaped files tracked in git | 0 |
| Same, across the whole history (`git log --all --diff-filter=A`) | 0 |
| `AIza…`, `AKIA…`, `sk_live_`, `ya29.`, `BEGIN PRIVATE KEY` in tracked content | 0 |
| Same, across all history | 0 |
| Environment variables read by code but undocumented | 0 |

The only `BEGIN PRIVATE KEY` match anywhere is `.env.example`, whose value is
`CHANGE_ME`.

Gitignored and never committed: `key.properties`, `*.jks`, `*.keystore`,
`local.properties`, `.env`, `google-services.json`.

The two upload keystores live in `~/keystores/`, **outside the repository**.
A signing key cannot be changed after the first upload to Play; losing them
means the apps can never be updated again, only republished under new package
names. Back them up.

---

## What the client is not allowed to decide

The server never trusts a client-supplied `userId`, `role`, `driverId`, price,
ride status, payment status or document status. Identity comes from the verified
token; everything else is derived server-side.

Specifically enforced:

- **Status** — only `RideStateMachine` writes `ride.status`. An invalid
  transition is a 409, never a silent no-op.
- **Price** — the fare is computed server-side from `platform_config`, and the
  commission is snapshotted onto the ride at creation so a mid-trip config
  change cannot alter terms a driver already accepted.
- **Assignment** — a driver cannot offer themselves a ride. `acceptRide`
  requires a `PENDING` offer addressed to that driver; without it the answer is
  404.
- **Documents** — verification status is writable only by an admin, and the
  write is audited.

---

## Not-found rather than forbidden

Several endpoints answer 404 where 403 would be the obvious choice: `GET
/rides/{id}`, `POST /admin/disputes`, and ride actions on someone else's ride.

This is deliberate. A 403 confirms the id exists, which turns any endpoint
taking an id into an enumeration oracle. Covered by tests that assert 404
specifically, so a well-meaning change to "clearer" error codes fails the suite.

---

## Rate limiting

Risk-tiered rather than one global limit. Each route declares a tier, and the
tier decides what happens when **Redis itself** is unavailable:

| Tier | Redis down | Reasoning |
|---|---|---|
| `CRITICAL` | degrade to a local in-process limit | auth, device registration |
| `STANDARD` | degrade | ride creation, most writes |
| `OPERATIONAL` | allow | location ingest, ride polling — refusing these blanks a rider's tracking screen mid-ride |

An undeclared route defaults to `STANDARD`, because an unclassified route is one
nobody has thought about.

Observed under load: 29 `rate limiter unavailable; allowing request` lines in a
five-minute run at 400 concurrent drivers. The degrade path is exercised, not
theoretical.

`TRUST_PROXY` must be set correctly. Unset behind a proxy puts every client in
one bucket keyed on the proxy's address; set without a proxy lets any client
spoof `X-Forwarded-For` and reset their own bucket. Both mistakes are silent.

---

## Transport

- Release manifests: `usesCleartextTraffic="false"`, verified on the merged
  manifest of a built bundle.
- Debug builds carry a network security config permitting cleartext **only** to
  `10.0.2.2`, `10.0.3.2`, `localhost` and `127.0.0.1`. It lives under
  `src/debug/`, so it is not merged into a release — verified by its absence
  from the release AAB.
- A release build refuses to start unless the API is `https://` and the socket
  is `wss://`, and refuses a development host outright.
- CORS rejects `*` at boot. With credentials it is not a lax setting, it is an
  open door to every admin action from any site a logged-in operator visits.

---

## Storage on device

Tokens go to `flutter_secure_storage` with `encryptedSharedPreferences: true`.
Every occurrence of `SharedPreferences` in this codebase is a comment explaining
why it is **not** used: a refresh token in plain SharedPreferences is a
world-readable XML file on a rooted handset, which is common enough in this
market to plan for.

---

## Logging

Structured (`pino`), every line carrying a `request_id`. Phone numbers,
coordinates and full names are never logged. The audit log redacts phone numbers
and deliberately omits document reference numbers — it is exported for disputes,
and a document number is the closest thing to an identity document this system
holds.

`/v1/metrics` requires a bearer token and returns **404** when unset or wrong.
A 401 would confirm metrics are served from that host.

---

## Fixed this session

| Issue | Severity |
|---|---|
| Any WebSocket client could crash the API process (unhandled Redis subscribe rejection) | **critical** — trivially a denial of service |
| Release bundles shipped pointing at a development host over plaintext | high |
| Release builds signed with the public debug key | high |
| Statement pagination silently dropped ledger rows | high — money |
| PgBouncer guard missed `postgres://host/db` (no port ⇒ 5432) | medium |

---

## Open

- **App Check / Play Integrity** — not implemented. Needs a Firebase project.
- **Dependency advisories** — transitive highs remain in `path-to-regexp` (via
  `@nestjs/core`, ReDoS) and `multer` (via `@nestjs/platform-express`). Neither
  is directly used; both need an upstream release.
- **Uploads** — none exist. v1 records that an administrator saw a document, not
  the document. If uploads are ever added, none of the file-handling controls
  are in place yet.
- **Secret manager** — secrets come from the environment. Adequate for a single
  VPS; move to a managed secret store before there is more than one.
