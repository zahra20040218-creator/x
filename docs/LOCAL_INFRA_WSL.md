# Local infrastructure without Docker — WSL

Docker Desktop does not work on the owner's machine. This is the path that
does, and it is the one the 153 integration tests were first run on.

It needs no signup, no cloud account, and no VPS. Everything runs on the
machine you are already using.

---

## Why not Docker

`infra/docker-compose.yml` is still the correct answer for a server, and
nothing here replaces it. It simply cannot run on this machine, and waiting
for that to change kept 153 tests unrun — including the atomic-claim proof
that CLAUDE.md §5.1 rests on.

WSL2 gives the same three services natively: PostgreSQL, PostGIS and Redis.

---

## One-time setup

Ubuntu 26.04 was already installed under WSL, with **Redis 8.0.5 already
running**. Only PostgreSQL was missing.

```bash
# From Windows. `-u root` avoids sudo, which asks for a password WSL cannot
# supply non-interactively.
wsl -d Ubuntu -u root -- bash -lc "
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq postgresql-18 postgresql-18-postgis-3 postgresql-client-18
"
```

The PostGIS package name is versioned to the server: on Ubuntu 26.04 the
candidate is PostgreSQL **18**, so it is `postgresql-18-postgis-3`.
`postgresql-17-postgis-3` does not exist there.

### The two settings that actually matter

**1. PostgreSQL must listen on TCP.** Out of the box it binds only the unix
socket `/var/run/postgresql`. `pg_isready` inside WSL then reports success
while Windows sees `ECONNREFUSED`, because a unix socket cannot cross the
WSL boundary — WSL2 mirrors listening *TCP* ports to the host and nothing
else. In `/etc/postgresql/18/main/postgresql.conf`:

```
listen_addresses = '*'
```

and a matching `host ... trust` line in `pg_hba.conf`. That is safe here and
only here: this cluster holds test fixtures on a developer machine.

**2. PostGIS is per-database, not per-cluster.** Migration 0001 runs
`CREATE EXTENSION IF NOT EXISTS postgis` on line 5 and fails the whole run
without it, so the extension is created in `rideapp` AND `rideapp_test`.

The script that does all of this: `scripts/wsl-infra.sh`.

---

## Every session: keep WSL alive

**WSL terminates the distribution when its last process exits.** Run the
setup, watch it succeed, and thirty seconds later Postgres is gone — which
looks exactly like a broken install and is not one.

```bash
# Leave this running in a spare terminal.
wsl -d Ubuntu -u root -- sleep infinity
```

Anything long-lived works. Without it, every command that starts a service
also ends it.

---

## Running the integration suite

```bash
export REAL_INFRA=1
export TEST_DATABASE_URL=postgres://rideapp:rideapp@localhost:5432/rideapp_test
export DATABASE_MIGRATION_URL=postgres://rideapp:rideapp@localhost:5432/rideapp_test
export TEST_REDIS_URL=redis://localhost:6379

cd services/api
node dist/db/migrate.js up      # 15 migrations
npx vitest run --project integration
```

`localhost`, not `127.0.0.1`. WSL's loopback mirroring resolves the hostname;
the bare IPv4 literal is refused.

**Result, 2026-09-05: 153 passed, 11 files.** First time any of them had ever
run. Among them:

```
✓ setIfAbsent (the atomic claim) — yields exactly one winner when many callers race
✓ lets exactly one of two drivers win when both hold a pending offer
✓ allows only one ACTIVE bid per driver, at the database level
✓ allows only one live subscription per driver, at the database level
```

The first two are CLAUDE.md §5.1 — "two drivers must never accept the same
ride" — proven against real Redis rather than the in-memory fake.

---

## Testing on a physical phone

The phone and the laptop share a WiFi network, so no public hosting is needed
for device testing.

```bash
ipconfig | findstr IPv4          # e.g. 192.168.1.15

cd apps/aly
flutter build apk --debug \
  --dart-define=API_BASE_URL=http://192.168.1.15:3000/v1 \
  --dart-define=WS_URL=ws://192.168.1.15:3000/v1/realtime
```

Plain `http` is deliberate and only works here: `EndpointConfig.resolve`
allows anything in a debug build ("a developer pointing at their own machine
is the point") and refuses non-TLS in release.

**Run the worker too.** `dist/main.js` and `dist/worker.js` are two processes,
and the worker owns ride dispatch. Without it a rider requests a ride, gets a
201, and no driver is ever offered it — the app looks alive and is not.

---

## What this does NOT replace

PgBouncer. `infra/docker-compose.yml` puts it between the API and Postgres
because CLAUDE.md §3.3 requires a hard connection cap for the 500-concurrent
target. This setup connects directly, which is fine for tests and a device
demo and is not the production shape.

For production: one VPS, `git clone`, `docker compose up -d`. The compose file
already describes the whole system correctly.
