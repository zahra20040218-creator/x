# REAL_INFRA_SETUP.md

**Status: BLOCKED — one UAC click away.**

Steps 1–3 of the "shortest path to GO" all stop at the same gate: this shell is
not an administrator, and every route to real infrastructure on Windows needs
elevation that a non-interactive process cannot obtain.

## What was attempted, and exactly how it failed

```
$ docker / psql / redis-server / flutter          -> NOT FOUND
$ wsl -l -v                                       -> "no installed distributions"
$ winget --version                                -> v1.29.290   (works)
$ winget install PostgreSQL.PostgreSQL.17 --silent --disable-interactivity
    Downloading https://get.enterprisedb.com/postgresql/...x64.exe
    Successfully verified installer hash
    Starting package install...
    0x800704c7 : The operation was canceled by the user      <- the UAC prompt
$ [Security.Principal.WindowsPrincipal].IsInRole(Administrator)
    IsAdmin: False
```

The installer downloaded and hash-verified. It died at elevation. Docker
Desktop, a WSL distro, a PostgreSQL service and Memurai all hit the same wall,
and Docker Desktop additionally needs a reboot.

## What you need to run (one elevated terminal)

Right-click Windows Terminal or PowerShell → **Run as administrator**:

```powershell
winget install --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
```

Reboot when prompted, start Docker Desktop once so it finishes WSL2 setup, then
back in the normal terminal:

```bash
docker compose -f infra/docker-compose.yml up -d
```

### Alternative, if you would rather not install Docker

Postgres and Redis directly. Redis has no official Windows build, so this route
needs WSL anyway:

```powershell
wsl --install -d Ubuntu        # elevated; reboot; then set a UNIX user/password
```
```bash
wsl -e sudo apt update
wsl -e sudo apt install -y postgresql redis-server
wsl -e sudo service postgresql start
wsl -e sudo service redis-server start
```

## Then step 2 is one command

```bash
cd services/api
export REAL_INFRA=1
export TEST_DATABASE_URL=postgres://rideapp:rideapp@localhost:5432/rideapp_test
export TEST_REDIS_URL=redis://localhost:6379/15
pnpm --filter @rideapp/api migrate:up
pnpm --filter @rideapp/api test
```

`TEST_REDIS_URL` points at **db 15** deliberately — the harness calls `FLUSHDB`
between tests, and pointing it at db 0 of a Redis you care about would erase it.

## What the harness guarantees

`test/support/real-infra.ts` exists to prevent one specific lie: a green run
being reported as "verified against real infrastructure" when it quietly used
the fakes.

- Real infrastructure is **opt-in** (`REAL_INFRA=1`), never automatic.
- When it is demanded and absent, every helper **throws**. It never falls back
  and never skips.
- `assertRealDatabase` / `assertRealRedis` re-check the object the app was
  actually built with, so an upstream wiring mistake fails the run.

Proven, not asserted:

```
$ REAL_INFRA=1 npx vitest run --project integration     # no URLs set
  × states plainly whether this run touched real infrastructure
    → expected false to be true
  Tests  1 failed | 5 passed
```

And with `REAL_INFRA` off, every run prints:

```
[REAL_INFRA=off] This run used the in-memory fakes.
  D-2 (real Redis) and D-15 (real Postgres concurrency) remain OPEN.
  Do not report this run as verification against real infrastructure.
```

## Still to build once infrastructure exists

The harness is the foundation, not the whole of step 2. Remaining:

1. Point the e2e suite at the real adapters (`AppModule.forRoot` already accepts
   them — it falls back to `PgDatabase`/ioredis when none are passed, so this is
   wiring, not redesign).
2. Per-file schema isolation, since vitest runs files in parallel and they would
   otherwise truncate each other's rows.
3. Re-run the 20-way accept race and the ledger tests against real Postgres —
   the two places D-15 showed the fake diverging.

**Note on "strip out FakeDatabase":** the fakes should stay. Deleting them
would make the suite unrunnable without Docker, which is the situation you are
in right now. The fix for D-2/D-15 is that the same tests must *also* run
against real services and that no run may claim to have done so when it did
not — which is what the harness enforces.
