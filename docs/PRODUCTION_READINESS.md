# PRODUCTION_READINESS.md

Scalability, high availability and continuity — sections 75–113 of the brief.

**Legend.** `GREEN` = verified by running it · `YELLOW` = implemented, not fully
verified · `RED` = missing or blocked.

**Nothing here is GREEN on the strength of reading source code.** Several items
that look correct in the source are YELLOW for exactly that reason.

Last updated 2026-08-23.

---

## 1. Current architecture

| Layer | Technology | Stateless? |
|---|---|---|
| Rider / driver apps | Flutter (Android only, v1) | n/a |
| API | NestJS 11 + Express 5, Node 24 | **yes** |
| Worker | same image, `dist/worker.js`, BullMQ | **yes** |
| Admin | Refine/React — **not built** (see RED) | n/a |
| Datastore | PostgreSQL 16 + PostGIS, via PgBouncer (transaction pooling) | authoritative |
| Cache / coordination | Redis 7.4, AOF everysec | **not** authoritative |
| Realtime | `ws`, fanned out over Redis pub/sub | |

## 2. Horizontal scaling — §77

| Property | Status | Evidence |
|---|---|---|
| API instances are interchangeable | **YELLOW** | No session state in process memory: auth is a bearer token, and the guard reloads the user from Postgres on every request. Sessions live in `refresh_tokens`. Verified by reading + tests against fakes; **never run as more than one instance** |
| WebSocket works across instances | **YELLOW** | `RealtimeGateway` publishes and subscribes through **Redis pub/sub**, not an in-process map, so a rider on instance A receives an event emitted by instance C. Checked in source; **never run multi-instance** |
| Driver presence / locations shared | **YELLOW** | Redis `GEOADD` only, never Postgres on the request path (CLAUDE.md §3.1) |
| Distributed lock shared | **YELLOW** | Redis `SET NX PX`; **never executed against real Redis** — D-2 |
| Rate limiting shared | **YELLOW** | Redis fixed window; degrades to a per-instance limiter when Redis is down, at `limit / RATE_LIMIT_LOCAL_DIVISOR` — **set that to your instance count** |
| No local filesystem state | **GREEN** | No writes to disk in any request path; the only file state is the driver app's own offline location buffer |

**Known non-interchangeability: none found.** But "found" here means source review
plus single-instance tests, not a multi-instance run.

## 3. High availability — §76

| Component | Status | Note |
|---|---|---|
| Multiple API instances | **RED** | Never run. Compose defines one |
| Multiple workers | **RED** | Never run. BullMQ supports it; unproven |
| Load balancer | **RED** | Not configured. No reverse proxy in the repo |
| Health / readiness / liveness | **GREEN** | `/v1/health` touches nothing; `/v1/health/ready` checks Postgres **and** Redis and returns 503 when either is down — verified live on the compiled binary |
| Health checks exempt from rate limiting | **GREEN** | 400 live requests to `/v1/health`, 0 non-200. Without the exemption the degrade policy would have rejected ~325 of them |
| Graceful shutdown | **YELLOW** | SIGTERM handlers close workers, queues and Redis; `tini` is PID 1 in the image so the signal actually arrives. **Never exercised under load** |
| Connection draining | **RED** | Not implemented — in-flight HTTP requests are not tracked to completion on shutdown |
| Postgres HA | **RED** | Single instance, no replica, no failover |
| Redis HA | **RED** | Single instance. §88 requires this not be a SPOF |
| Durable queues | **YELLOW** | BullMQ on Redis with AOF everysec; never run |
| Centralised logging | **RED** | Structured pino to stdout; nothing collects it |
| Centralised monitoring | **RED** | No metrics endpoint, no Sentry, no dashboards |

## 4. Capacity — §79

| | Value | Basis |
|---|---|---|
| Target launch capacity | 500 concurrent users, p95 < 200 ms, 4-core VPS | CLAUDE.md §3 |
| **Tested capacity** | **NONE** | k6 not installed; no load test has ever run |
| Estimated bottleneck | PgBouncer `DEFAULT_POOL_SIZE: 25` under transaction pooling | reasoned, not measured |

**Do not quote a supported user count.** There is no evidence for one.

## 5. Zero-downtime deployment — §81, §83, §108

| Item | Status |
|---|---|
| Rolling / blue-green / canary | **RED** — no deployment pipeline exists |
| Migration strategy documented | **YELLOW** — forward-only and reversible per CLAUDE.md §9; 6 up + 6 down migrations exist |
| Migrations backward-compatible (expand → contract) | **YELLOW** — no migration drops a column. **Migration 0006 is a deliberate exception**: it makes `sid` required in access tokens, so tokens issued by the previous build are refused. Cost is one forced re-login; recorded because it violates the general rule |
| Migrations executed | **RED** — never run against a real database |
| Rollback tested | **RED** |

## 6. Backups and recovery — §84–87

| Item | Status |
|---|---|
| Automated backups | **RED** — none |
| Off-site copies | **RED** |
| Restore procedure | **RED** — not written |
| Restore tested | **RED** — never |
| RPO | **NOT VERIFIED** — target ≤ 5 min, nothing implements it |
| RTO | **NOT VERIFIED** — target ≤ 30 min, nothing implements it |

**A system with no tested restore is not production-ready**, independent of
every other row in this file.

## 7. Redis as a single point of failure — §88

The brief is explicit: *if Redis fails, two drivers must still not accept the
same ride.*

There are two layers:

1. **Redis claim** — `SET ride:{id}:claim NX PX 30000`. **YELLOW**, never run
   against real Redis (D-2).
2. **Database backstop** — the guarded `UPDATE ... WHERE status = 'OFFERED'`
   (zero rows ⇒ 409) plus the partial unique index
   `rides_one_active_per_driver_uq`. **YELLOW**, never executed against real
   PostgreSQL.

So the answer to "what happens if Redis fails" is: *the design says the database
still prevents it, and that has never been demonstrated.* Closing this is the
purpose of `test/integration/real-postgres.test.ts`.

**Additionally: a third authorisation layer was added** — `accept` now requires
a `PENDING` row in `ride_offers` for that driver (D-14). Before that fix any
driver could accept a ride dispatched to someone else, which meant Redis was not
merely the main protection, it was protecting the wrong property.

## 8. Failure modes — §89, §90

| Scenario | Status |
|---|---|
| Redis unavailable | **YELLOW** — readiness 503; rate limiter degrades by tier (verified live on the binary with no Redis); matching would fail |
| Redis slow / hung | **YELLOW** — bounded by `RATE_LIMIT_REDIS_TIMEOUT_MS` in the limiter only. Other Redis calls have no timeout |
| Postgres unavailable | **YELLOW** — readiness 503; process still boots. Verified live |
| API crash | **RED** — no supervisor configured |
| Worker crash | **RED** |
| Payment provider timeout | **N/A** — gateway is a deliberate stub (CLAUDE.md §7) |
| Push provider failure | **RED** — push is a logged no-op, so there is nothing to fail |
| Maps failure | **RED** — no maps integration exists |
| Circuit breakers | **RED** — none |

## 9. API and mobile continuity — §91–96

| Item | Status |
|---|---|
| API versioning | **YELLOW** — everything is under `/v1`; no v2 exists so compatibility is untested |
| Minimum supported mobile version | **RED** — not implemented, no endpoint, no gate |
| Feature flags / kill switches | **RED** — `platform_config` holds fare and commission only |
| Staged / phased rollout | **RED** — no release pipeline; apps have never been built |
| Crash reporting | **RED** |
| Compatibility matrix | **RED** |

**§96 note:** because there are no feature flags and no minimum-version gate, a
bad mobile release today could only be mitigated by changing backend behaviour
for everyone. That is the single most important gap in this section.

## 10. Environments and gates — §99–102

| Item | Status |
|---|---|
| Local | **YELLOW** — compose now builds (Dockerfile was missing until today) |
| Staging | **RED** — does not exist |
| CI pipeline | **YELLOW** — workflow file exists, has never run |
| Release gate (17 checks) | **PARTIAL** — typecheck, lint, unit, build are real and enforced; integration, E2E-on-real-infra, migration validation, Docker build, staging deploy, smoke tests, performance and rollback verification are all **RED** |

## 11. Observability — §105, §106

| Item | Status |
|---|---|
| Structured logs + request id | **GREEN** — verified in live responses and log lines; PII redacted structurally |
| Audit log for sensitive admin actions | **YELLOW** — implemented and tested against fakes; append-only trigger never executed |
| Health endpoints | **GREEN** |
| Metrics | **RED** |
| Error tracking | **RED** |
| Alerting | **RED** |
| Business dashboards | **RED** |

**§18's question — "if production breaks at 3 a.m., can the team tell why?"** —
today: there are good logs and nothing collecting or watching them. So: no.

## 12. Known single points of failure

Every one of these can take the whole platform down:

1. The single API instance
2. The single worker
3. The single Postgres instance (no replica, **no backup**)
4. The single Redis instance
5. The single deployment (no rollback path)
6. Firebase Auth — no fallback sign-in
7. The absence of any monitoring — failures are invisible rather than fatal, which is worse

**Migration path**, in the order that removes the most risk per unit of effort:

1. Backups + a *tested* restore. Cheapest, removes the only irreversible risk.
2. Two API instances behind a load balancer. The code is already stateless and
   fans out over Redis pub/sub, so this is configuration.
3. Monitoring and alerting.
4. Managed Postgres with a replica, managed Redis with failover.
5. Rolling deploys with health gating, then canary.

Do not over-engineer before launch. Items 1–3 are the ones that matter at 10
drivers as much as at 10,000.

## 13. Answers to §111, with evidence

| # | Question | Answer |
|---|---|---|
| 1 | How many API instances can run simultaneously? | **NOT VERIFIED.** Designed stateless; never run as more than one |
| 2 | Can one API instance die without interruption? | **NOT VERIFIED** — no LB |
| 3 | Can a worker die without losing jobs? | **NOT VERIFIED** — BullMQ persists to Redis; never tested |
| 4 | What if Redis disappears? | Readiness 503; rate limiting degrades by tier (**verified live**); matching stops; duplicate-accept protection falls to the DB backstop, which is **NOT VERIFIED** |
| 5 | What if the Postgres primary fails? | Total outage. No replica |
| 6 | Can the database be restored? | **NO** — no backup exists |
| 7 | How long does restoration take? | **NOT VERIFIED** |
| 8 | Zero-downtime deploy? | **NO** — no pipeline |
| 9 | Rollback? | **NOT VERIFIED** |
| 10 | Schema evolution without downtime? | Partly by design; **migration 0006 forces re-login** |
| 11 | Old mobile + new backend? | **NOT VERIFIED** — no version gate |
| 12 | Staged Android updates? | **NO** — no release pipeline; app has never been built |
| 13 | Phased iOS? | **N/A** — iOS is out of scope (CLAUDE.md §2) |
| 14 | Can a bad mobile feature be disabled remotely? | **NO** — no feature flags |
| 15 | Does it scale horizontally? | Designed to; **NOT VERIFIED** |
| 16 | Tested capacity limits? | **NONE** |
| 17 | RPO | **NOT VERIFIED** |
| 18 | RTO | **NOT VERIFIED** |
| 19 | Last restore test? | **NEVER** |
| 20 | If a whole server dies? | Total outage |
| 21 | If an availability zone fails? | Total outage; single-region by design at this scale |
| 22 | If the payment provider fails? | Cash is unaffected; the gateway is a deliberate stub |
| 23 | If maps fail? | No maps integration exists |
| 24 | If push fails? | Push is a logged no-op; drivers already receive no notifications |

## 14. Summary

| | GREEN | YELLOW | RED |
|---|---|---|---|
| Count | **5** | **17** | **31** |

The GREEN items are: health endpoints, health-check rate-limit exemption,
structured logging with request ids, no local filesystem state, and graceful
degradation of the API when both datastores are down.

Everything else is either unverified or absent. This document should be
re-derived — not edited — after the first run against real infrastructure.
