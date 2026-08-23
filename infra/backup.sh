#!/usr/bin/env bash
#
# Take a verified backup of the ride-hailing database.
#
# There was no backup tooling in this repository at all. That is the single
# most disqualifying gap for a system that holds a financial ledger: every
# other risk here is recoverable, and losing the ledger is not.
#
# Two decisions are load-bearing:
#
#   * **Custom format (-Fc), not plain SQL.** It compresses, it restores in
#     parallel, and - the reason that matters - `pg_restore -l` can list its
#     contents, which is how this script proves the file is readable before
#     calling it a backup.
#
#   * **Every backup is verified immediately.** A dump nobody can open is not a
#     backup, it is a file. Verification here is cheap; discovering the problem
#     during an incident is not.
#
# What this does NOT do, deliberately: it does not delete anything on a
# schedule, and it does not copy anything off this machine. Both are real
# requirements (see docs/DISASTER_RECOVERY.md) and both need decisions that
# belong to whoever owns the infrastructure - a retention policy that silently
# deletes the only surviving copy is worse than no retention policy.
set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-rideapp}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
PG_BIN="${PG_BIN:-}"

pg() { if [ -n "$PG_BIN" ]; then echo "$PG_BIN/$1"; else echo "$1"; fi; }

mkdir -p "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/${PGDATABASE}-${STAMP}.dump"

echo "==> dumping ${PGDATABASE} from ${PGHOST}:${PGPORT}"
"$(pg pg_dump)" \
  -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-privileges \
  --file="$FILE"

if [ ! -s "$FILE" ]; then
  echo "FAILED: dump file is empty" >&2
  exit 1
fi

# Verification. An unreadable dump must fail HERE, loudly, while someone is
# watching - not six months from now during an outage.
echo "==> verifying the dump is readable"
OBJECTS="$("$(pg pg_restore)" --list "$FILE" | grep -cv '^;' || true)"
if [ "$OBJECTS" -lt 1 ]; then
  echo "FAILED: pg_restore could not list any objects in $FILE" >&2
  exit 1
fi

# A checksum, so a later restore can prove it read the same bytes that were
# written - silent corruption on cheap storage is a real failure mode.
sha256sum "$FILE" > "$FILE.sha256"

SIZE="$(du -h "$FILE" | cut -f1)"
echo "==> OK"
echo "    file    : $FILE"
echo "    size    : $SIZE"
echo "    objects : $OBJECTS"
echo "    sha256  : $(cut -d' ' -f1 < "$FILE.sha256")"
echo
echo "This backup is NOT yet proven restorable. Run infra/restore.sh against a"
echo "scratch database to prove it - see docs/DISASTER_RECOVERY.md."
