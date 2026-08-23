# DISASTER_RECOVERY.md

**Status: the restore procedure below has actually been executed and verified**
— 2026-08-23, against PostgreSQL 17.11. This is the first thing in this
repository that can be described as tested rather than designed.

---

## Why this exists

A ride-hailing platform holds a double-entry financial ledger. Every other risk
in this codebase is recoverable; losing the ledger is not — you cannot
reconstruct who is owed what from memory, and drivers will not accept "the
database was lost" as an answer about their earnings.

Before today there was no backup tooling of any kind.

## Taking a backup

```bash
PG_BIN=/c/Users/moaay/pg17/pgsql/bin \
PGDATABASE=rideapp \
BACKUP_DIR=/path/to/backups \
  bash infra/backup.sh
```

Custom format (`-Fc`), compressed, `--no-owner --no-privileges` so it restores
onto a differently-named role. Every backup is **verified at creation** with
`pg_restore --list` and a SHA-256 written alongside it. A dump nobody can open
is a file, not a backup, and the moment to discover that is while someone is
watching.

## Restoring — the tested procedure

```bash
PG_BIN=/c/Users/moaay/pg17/pgsql/bin \
  bash infra/restore.sh /path/to/rideapp-<stamp>.dump [target-db]
```

The target **defaults to a scratch database**, not the live one. Restoring over
production has to be typed out deliberately: the usual reason to run this is a
drill, and a script whose default overwrites production is a loaded gun.

`pg_restore --exit-on-error` is used so a partially restored database is never
reported as success. A half-restored ledger is worse than a failed restore,
because it looks fine.

## What the drill actually proved

Executed end to end on 2026-08-23:

```
==> checking integrity            (sha256 matched)
==> recreating target database: rideapp_restore_check
==> restoring
==> verifying the restored database
--- row counts ---
users        = 4        drivers    = 2
rides        = 0        ledger     = 2
--- financial integrity ---
unbalanced transactions = 0
--- schema integrity ---
tables = 19   indexes = 57   triggers = 7   migrations = 6
```

Row counts matched the source exactly. But counts alone would not catch a
restore that dropped one side of a double entry, so the drill also checks that
**every ledger transaction still sums to zero**, and then goes further —
verifying the restored database still *enforces* its guarantees rather than
merely containing them:

```
$ UPDATE ledger_entries SET amount_iqd = 1;
ERROR: Table ledger_entries is append-only (CLAUDE.md 6.3 / 12.3).
       UPDATE is forbidden. Corrections are new offsetting rows.

$ SELECT balance_iqd FROM driver_wallet_balances;
 12500                          -- exact, not rounded

$ INSERT INTO users (role, phone_e164, ...) VALUES ('RIDER','07700000001',...);
ERROR: violates check constraint "users_phone_e164_format"
```

The append-only trigger, the balance view and the CHECK constraints all survive
a restore and still fire. Counting seven triggers would not have proved that.

## RPO and RTO — measured, and honestly bounded

| | Value | Basis |
|---|---|---|
| **RPO** | = time since the last backup ran | There is **no scheduler yet**, so today the real RPO is "since someone last ran the script by hand". That is not an acceptable production answer |
| **RTO (measured)** | **under 10 seconds** | On the drill database: 4 users, 2 ledger rows, 19 tables |
| **RTO (production)** | **NOT MEASURED** | Restore time scales with data volume. A 50 GB ledger is not a 64 KB one, and quoting the drill figure as a production RTO would be dishonest |

The §86 targets — RPO ≤ 5 min, RTO ≤ 30 min — are **not met today**, because
nothing schedules a backup and nothing has been restored at production scale.

## What is still missing

Ranked by how much risk each removes:

1. **A scheduler.** Without it the RPO is unbounded. A cron entry or a
   Kubernetes CronJob calling `infra/backup.sh` is the smallest possible fix.
2. **Off-site copies.** A backup on the same disk as the database survives
   deletion but not disk failure, theft, or ransomware. Copy to object storage
   in a different failure domain.
3. **Point-in-time recovery.** `pg_dump` gives you the moment the dump ran.
   WAL archiving gives you any moment. With money involved, "we lost the last
   six hours of rides" is a materially different incident from "we lost four
   minutes".
4. **A retention policy.** Deliberately absent from `backup.sh`: a script that
   deletes on a schedule can delete the only surviving copy. Whoever owns the
   infrastructure decides this, and immutable/write-once storage is worth the
   cost for the monthly archive.
5. **A recurring drill.** A restore proven once in August is not a restore
   proven in December. Schedule it, and record the date and duration each time.
6. **Encryption at rest.** These dumps contain phone numbers — personal data
   under any reading, and CLAUDE.md §9 treats them as PII.

## Recovery scenarios

| Scenario | Procedure | State |
|---|---|---|
| Accidental `DELETE` / bad migration | Restore latest dump into a scratch DB, extract the affected rows, apply offsetting ledger entries — **never** UPDATE the ledger | procedure written, **drill for the extract step not run** |
| Database corruption | Restore latest dump into a fresh database, repoint `DATABASE_URL` | **restore step tested**, repointing not |
| Total host loss | Provision a host, install Postgres, restore from the **off-site** copy | **BLOCKED** — no off-site copy exists |
| Ransomware | Restore from an immutable copy | **BLOCKED** — no immutable copy exists |

Rows 3 and 4 are blocked on the same missing thing: a copy that does not live
on this machine.
