# CLAUDE.md — Project Constitution

> **ملاحظة بالعربية:** هذا الملف مكتوب بالإنجليزية عمداً. هو ملف موجَّه للآلة لا للبشر، وتعليمات الكود بالإنجليزية تنتج دقة أعلى لأن نماذج الكود مدرَّبة على مصطلحات إنجليزية. الشروحات الموجَّهة لك موجودة في `PROMPTS.md`.
>
> ضع هذا الملف في جذر المستودع باسم `CLAUDE.md` بالضبط. Claude Code يقرأه تلقائياً في كل جلسة.

---

> **Not Claude-specific.** The filename is historical. Every rule below binds
> any agent and any human touching this code. `AGENTS.md` and `GEMINI.md` point
> here rather than copying it — two copies of a constitution are two
> constitutions, and they drift apart at the worst possible moment.

## 0. How to use this file

This is a **binding contract**, not documentation. Every rule here overrides your default behavior.

If a user request in a session conflicts with a rule in this file, **stop and say so** before writing code. Do not silently comply.

If a rule here is ambiguous for the task at hand, **ask one question** rather than guessing.

---

## 1. Project identity

**Product:** **ALY** (Arabic: **الي**) — ride-hailing platform for Baghdad, Iraq.
Single city, single vehicle class, cash-first.

> **Naming, decided 2026-08-25.** ALY is the product name in the UI, the
> launcher, notifications, logs, README and store listings. **Package names do
> NOT change**: `iq.rideapp.rideapp_rider` and `iq.rideapp.rideapp_driver` are
> already registered as Firebase apps with SHA fingerprints and downloaded
> configs. Renaming them would invalidate that work and cannot be undone after
> the first Play upload. The merged app (§1.1) inherits the RIDER package id;
> the driver package is retired.

**Components:**
| Component | Stack | Directory |
|---|---|---|
| ALY app | Flutter (Dart), rider + driver modes | `apps/aly` |
| Rider app *(being merged into `apps/aly`)* | Flutter (Dart) | `apps/rider` |
| Driver app *(being merged into `apps/aly`)* | Flutter (Dart) | `apps/driver` |
| Backend API | NestJS (TypeScript) | `services/api` |
| Admin panel | Refine (React) | `apps/admin` |
| Infra | Docker Compose | `infra/` |

### 1.1 One app, two modes — decided 2026-08-25

ALY ships as **one** application with a Rider mode and a Driver mode, not two
binaries. This reverses the original two-app split; `apps/rider` and
`apps/driver` are being merged into `apps/aly`.

**The mode is a server decision, never a client flag.** A client may not enter
Driver mode unless the server says it may. The server checks, on every
driver-scoped call:

- driver account approved
- required documents verified
- vehicle verified
- subscription valid, where a plan is required
- account not suspended and not banned

`GET /v1/me/capabilities` returns the authoritative set. The UI renders what
that says and decides nothing itself. **Hiding a button is not authorisation.**

**Shared Flutter code** lives in `packages/core` — models, API client, design system. Duplicated widget code between rider and driver is a defect.

---

## 2. Scope boundaries — v1

### IN SCOPE
- Phone OTP auth (Firebase Phone Auth)
- Rider: set pickup + destination, fare estimate, request ride, live-track driver, complete, rate
- Driver: online/offline, receive offer, accept/decline, background location, navigate via deep-link, complete
- Matching: nearest available driver, offer with timeout, atomic claim
- Cash payment + double-entry ledger + driver wallet (commission rate configurable, **default 0**)
- Admin: drivers, rides, wallet top-ups, disputes, fare config
- Arabic UI, RTL layout, IQD currency

### SCOPE EXPANSION — approved by the owner, 2026-08-25

Four systems moved from OUT to IN. They are approved, not assumed; each one
changes rules elsewhere in this file and those changes are noted here.

| System | What it changes |
|---|---|
| **Fare negotiation and driver offers** | Riders propose a fare; drivers bid. This does **not** delete nearest-driver dispatch — §5.1's atomic claim still governs who wins a ride, and direct dispatch remains the fallback when nobody bids. Bids live in their own aggregate (`ride_bids`), not inside `RideStateMachine`. |
| **Driver subscriptions** | Periodic plans alongside commission. A subscription charge is an ordinary double-entry transaction under §6 — **not** a second money system, and **not** a mutable counter. An expired subscription blocks going online; it never edits a ledger row. |
| **Driver KYC, documents and approval** | Drivers upload identity, licence, vehicle registration. Approval is an admin workflow. Feeds the §1.1 capability check. |
| **iOS** | The Flutter source must build for iOS. **Building and signing an IPA requires macOS and an Apple Developer account and cannot happen on the current machine** — that part is BLOCKED, not done. |

### OUT OF SCOPE — do not build, do not scaffold, do not "prepare for"
- In-app navigation (deep-link to Google Maps instead)
- Live payment gateway integration (build the interface only — see §7)
- Surge pricing, scheduled rides, ride sharing, multiple vehicle classes
- In-app chat, SOS, referrals, promo codes
- Multi-city, multi-currency, i18n beyond Arabic + English

**If asked to add anything from the OUT list, respond: "That's out of v1 scope per CLAUDE.md §2. Confirm you want to expand scope?" and wait.**

---

## 3. Architecture invariants — never violate

These four rules exist because the system must handle **500 concurrent users on a 4-core VPS**. Violating any one of them silently destroys that capacity.

1. **Driver locations live in Redis only.** Write to `GEOADD drivers:online`. Never write a location update to PostgreSQL on the request path. A background job flushes location history to Postgres every 30s in batches.

2. **No synchronous external calls in a request handler.** Maps/routing, FCM push, SMS — all go through a BullMQ queue. A request handler that `await`s a third-party HTTP call is a defect.

3. **All DB access goes through PgBouncer** with a hard connection cap. Never open an ad-hoc connection pool.

4. **Every query on a table with >10k rows must have a supporting index.** Composite index on `(status, created_at)` for rides. GiST on geometry columns. If you write a query, you state which index serves it in the PR description.

5. **Pagination is keyset on `(created_at, id)`, and the cursor is an id.** Never `created_at < $cursor`. Three things break it, and all three cost real rows: `created_at` is not unique so the order is not total; `now()` is the *transaction* timestamp, so every row a transaction writes shares one, and a double-entry ledger writes its rows in one transaction by definition; and `timestamptz` is microsecond precision while a JavaScript `Date` is millisecond, so a timestamp that round-trips through JSON no longer matches the row it came from. The server resolves the cursor row itself — see `services/api/src/http/cursor.ts`. This was found losing four of six entries off a driver's statement.

---

## 4. Domain model — ride state machine

States and the **only** permitted transitions:

```
REQUESTED ──> OFFERED ──> ACCEPTED ──> DRIVER_ARRIVED ──> IN_PROGRESS ──> COMPLETED
    │            │            │              │                 │
    │            │            │              │                 └──> CANCELLED_IN_TRIP (admin only)
    │            │            └──────────────┴──> CANCELLED_BY_DRIVER
    │            │                                CANCELLED_BY_RIDER
    │            └──> EXPIRED  (offer timeout, returns to REQUESTED for next driver)
    └──> NO_DRIVERS_FOUND
```

**Rules:**
- Transitions are enforced in a single `RideStateMachine` service. No controller or repository mutates `ride.status` directly.
- Every transition writes a row to `ride_events` (ride_id, from_state, to_state, actor_type, actor_id, timestamp, metadata). This table is append-only.
- An invalid transition throws `InvalidRideTransitionError` and returns HTTP 409. It never silently no-ops.

---

## 5. Concurrency rules — the three defects that kill ride-hailing MVPs

### 5.1 Matching must be atomic
Two drivers must never accept the same ride. Claim with Redis:
```
SET ride:{rideId}:claim {driverId} NX PX 30000
```
Only the driver whose `SET NX` returned OK proceeds. Everyone else gets 409. **Do not implement this with a DB read-then-write.** Do not implement it with an application-level mutex.

### 5.2 Ride creation must be idempotent
The rider app generates a UUID (`Idempotency-Key` header) per ride request and retries with the same key on network failure. Server stores key → ride_id for 24h. Duplicate key returns the original ride, HTTP 200, not a new ride.

**Reason:** Baghdad mobile networks drop requests mid-flight. Without this, a rider who loses signal creates 3 rides and 3 drivers get dispatched.

### 5.3 Background location must survive Doze
Android kills background work aggressively. The driver location service must:
- Run as a foreground service with a persistent notification
- Request battery optimization exemption at onboarding, with an explanatory screen
- Buffer locations locally when offline and flush on reconnect
- Never rely on `WorkManager` for sub-minute intervals

**This is the single most common cause of ride-hailing MVP failure in production.** Treat any location-service task as high-risk and write an explicit test plan for it.

---

## 6. Money rules — non-negotiable

1. **Money is `BIGINT`, in whole Iraqi Dinars.** Never `FLOAT`, never `DOUBLE`, never `NUMERIC` with decimals. IQD has no practically-used subunit.

2. **Double-entry ledger.** Every financial event writes ≥2 rows to `ledger_entries` summing to zero:
   ```
   ledger_entries(id, ride_id, account_type, account_id, direction, amount_iqd, created_at, description)
   ```
   Account types: `DRIVER_WALLET`, `PLATFORM_REVENUE`, `DRIVER_CASH_HELD`, `MANUAL_ADJUSTMENT`.

3. **Ledger is append-only.** No UPDATE, no DELETE, ever. Corrections are new offsetting entries. Any migration or code that mutates a ledger row is a critical defect.

4. **Wallet balance is derived, never stored as a mutable column.** Compute as `SUM(credits) - SUM(debits)`. If performance demands it, use a materialized view refreshed on write — never a hand-maintained counter.

5. **Commission rate is config, not a constant.** Read from `platform_config.commission_bps` (basis points). **Default value: 0.** Changing it must not require a deploy.

---

## 7. Payment provider abstraction

Build the interface. Do not integrate a live gateway.

```typescript
interface PaymentProvider {
  charge(rideId: string, amountIqd: number, ctx: PaymentContext): Promise<PaymentResult>;
  refund(paymentId: string, amountIqd: number): Promise<RefundResult>;
  getStatus(paymentId: string): Promise<PaymentStatus>;
}
```

Implementations:
- `CashProvider` — fully implemented, used in production from day one. Records intent + driver confirmation, writes ledger entries.
- `GatewayProvider` — stub that throws `NotImplementedError`. Structure it so that adding ZainCash later means implementing three methods and adding a webhook controller. Nothing else changes.

**Webhook note:** the target gateway does not permit webhook testing in its UAT environment. Design the webhook handler to be independently testable: pure function `(payload, signature) => LedgerCommand[]`, with a thin HTTP wrapper. Write its unit tests now even though the integration is stubbed.

---

## 8. Localization and formats

| Item | Rule |
|---|---|
| Primary UI language | Arabic, RTL |
| Secondary | English (LTR) |
| Currency display | `12,500 د.ع` — thousands separator, no decimals |
| Phone storage | E.164, `+964XXXXXXXXX` |
| Phone input | Accept `07XXXXXXXXX` and normalize server-side |
| Timezone | Store UTC. Display Asia/Baghdad |
| Dates in UI | Gregorian, Arabic numerals as rendered by locale |

Never hardcode a user-facing string. All strings go through the localization layer, including error messages and toasts.

---

## 9. Code conventions

- TypeScript `strict: true`. No `any`. No `@ts-ignore` without a comment explaining why.
- Dart: `very_good_analysis` lints. No `dynamic` in public APIs.
- No secrets in code or committed config. `.env` only, `.env.example` committed.
- Every endpoint validated with a Zod schema at the boundary. Validation errors return RFC 9457 problem+json.
- Structured logging only (`pino`). Every log line carries `request_id`. **Never log phone numbers, exact coordinates, or full names.**
- Migrations are forward-only and reversible. Never edit an applied migration.
- Conventional Commits. One logical change per commit.

---

## 10. Testing requirements

| Layer | Required coverage |
|---|---|
| State machine + matching + ledger | **95%** — these are the correctness core |
| Other backend services | 70% |
| Flutter widgets | Smoke tests on critical screens only |
| E2E | One happy path + three failure paths (network drop mid-ride, driver declines, no drivers available) |

**Write the test before the implementation** for anything in §5 or §6.

A task is not complete until `pnpm test` and `flutter test` both pass. Never report a task done with failing or skipped tests. Never delete a failing test to make the suite green — fix it or explain why it is wrong.

---

## 11. Definition of Done

A task is done when **all** of these hold:

- [ ] Tests written and passing, coverage thresholds met
- [ ] No new lint errors, no new type errors
- [ ] Migrations run cleanly up and down on a fresh DB
- [ ] Error paths handled explicitly — no bare `catch` that swallows
- [ ] User-facing strings localized
- [ ] Structured logs added at boundaries, no PII in logs
- [ ] Indexes stated for any new query on a large table
- [ ] `README` or ADR updated if an architectural decision was made

---

## 12. Prohibited behaviors

Never do these, even if asked in a session:

1. **Never invent an endpoint** not present in `docs/api-contract.yaml`. Propose a contract change instead.
2. **Never store money as a floating-point type.**
3. **Never mutate or delete a ledger row.**
4. **Never bypass `RideStateMachine`** to set a status directly.
5. **Never implement matching without the atomic Redis claim.**
6. **Never commit secrets**, keys, or real phone numbers — including in tests or fixtures.
7. **Never scaffold OUT-OF-SCOPE features** "for later." Dead code is a liability.
8. **Never claim work is complete when tests fail.** Report the failure.
9. **Never write a migration that drops a column** containing production data without an explicit two-phase plan.
10. **Never use `git push --force`** on a shared branch.

---

## 13. Session discipline

- One feature per session. Run `/clear` between features.
- Start each session by stating: which file(s) you will touch, which tests you will write, and any assumption you are making.
- If context exceeds ~60% of the window mid-task, stop, summarize state to `docs/session-notes.md`, and tell the user to `/clear` and resume.
- Prefer editing existing files over creating new ones. State a reason before creating any new file.
- When uncertain between two designs, present both in ≤5 lines each and ask. Do not build both.
