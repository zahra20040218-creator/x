# Deployment

One VPS, four processes, a reverse proxy in front. Deliberately simple: at 500
concurrent users, Kubernetes and microservices are answers to questions this
system is not asking.

```
        TLS
Internet ──► Caddy / nginx ──┬──► API      (HTTP + WebSocket upgrade)
                             └──► admin    (static files)
                                    │
                              PgBouncer ──► PostgreSQL 17
                                    │
                                 Redis 8
                                    │
                                 worker    (BullMQ)
```

## Minimum host

4 vCPU, 8 GB RAM — the target `CLAUDE.md` §3 is written against. Everything
below assumes PostgreSQL and Redis on the same box, which is fine to start and
is the first thing to split when it stops being fine.

## The two that are not optional

**PgBouncer.** The application pool is deliberately 10 because PgBouncer is
supposed to multiplex in front of it. Without it, 400 concurrent drivers
exhausted the pool and returned 500s — measured, see `LOAD_TESTING.md`. Run it
in transaction pooling mode. The API refuses to boot in production against port
5432.

**The worker.** Dispatch happens in the worker. If it is not running, rides are
created and never offered to anyone, and nothing about the API looks wrong.

## Order of operations

```bash
node dist/db/migrate.js up      # direct to Postgres, not through PgBouncer
node dist/main.js               # API
node dist/worker.js             # worker
```

Migrations connect directly because DDL needs a stable session and transaction
pooling does not give one. That is the single documented exception to §3.3.

## Reverse proxy

Needs `Upgrade`/`Connection` passthrough for `/v1/realtime` and a read timeout
longer than the socket's idle period, or every WebSocket is cut at the proxy's
default. TLS from Let's Encrypt; Caddy does it with no configuration, nginx
needs certbot.

Health: `GET /v1/health` (liveness), `GET /v1/health/ready` (readiness — checks
Postgres and Redis).

## Zero-downtime

Both processes are stateless, so a rolling restart works: start the new API,
wait for readiness, drain the old one. `SIGTERM` closes the realtime gateway and
finishes in-flight work; clients reconnect with backoff.

Migrations must be backward-compatible with the running version for the duration
of a rollout. Forward-only and reversible is already the rule.

## Scaling, when it is needed

Add API processes behind the proxy first — realtime fan-out already goes through
Redis pub/sub precisely so a client connected to one process receives an event
raised on another. Then move PostgreSQL and Redis to managed instances. Only
then consider anything more elaborate.

## Backups

See `DISASTER_RECOVERY.md`. Redis needs no backup: everything in it is either
rebuildable within seconds or expires on its own.
