#!/usr/bin/env bash
#
# Restore a backup into a target database, and prove it worked.
#
# Usage:
#   infra/restore.sh <dump-file> [target-database]
#
# The target defaults to a scratch name rather than the live database. That is
# not politeness - a restore script whose default overwrites production is a
# loaded gun, and the common case for running this is a DRILL, not an incident.
# Restoring over the live database has to be typed out deliberately.
set -euo pipefail

DUMP="${1:?usage: restore.sh <dump-file> [target-database]}"
TARGET="${2:-rideapp_restore_check}"

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
PG_BIN="${PG_BIN:-}"

pg() { if [ -n "$PG_BIN" ]; then echo "$PG_BIN/$1"; else echo "$1"; fi; }

[ -f "$DUMP" ] || { echo "no such dump: $DUMP" >&2; exit 1; }

# If a checksum was recorded, the restore refuses to proceed on a file that has
# changed since it was written.
if [ -f "$DUMP.sha256" ]; then
  echo "==> checking integrity"
  sha256sum -c "$DUMP.sha256" >/dev/null || {
    echo "FAILED: $DUMP does not match its recorded checksum. Do not trust it." >&2
    exit 1
  }
fi

echo "==> recreating target database: $TARGET"
"$(pg psql)" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$TARGET\";" \
  -c "CREATE DATABASE \"$TARGET\";" >/dev/null

echo "==> restoring"
# --exit-on-error so a partially restored database is never reported as a
# success. A half-restored ledger is worse than a failed restore, because it
# looks fine.
"$(pg pg_restore)" \
  -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$TARGET" \
  --no-owner --no-privileges --exit-on-error \
  "$DUMP"

echo "==> verifying the restored database"

"$(pg psql)" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$TARGET" -v ON_ERROR_STOP=1 -tA <<'SQL'
\echo '--- row counts ---'
SELECT 'users        = ' || count(*) FROM users;
SELECT 'drivers      = ' || count(*) FROM drivers;
SELECT 'rides        = ' || count(*) FROM rides;
SELECT 'ledger       = ' || count(*) FROM ledger_entries;

\echo '--- financial integrity ---'
-- Every ledger transaction must still sum to zero. This is the check that
-- actually matters: a restore that loses one side of a double entry would
-- leave the books wrong in a way row counts alone would not reveal.
SELECT 'unbalanced transactions = ' || count(*) FROM (
  SELECT transaction_id
    FROM ledger_entries
   GROUP BY transaction_id
  HAVING SUM(CASE WHEN direction = 'CREDIT' THEN amount_iqd ELSE -amount_iqd END) <> 0
) bad;

\echo '--- schema integrity ---'
SELECT 'tables       = ' || count(*) FROM pg_tables WHERE schemaname = 'public';
SELECT 'indexes      = ' || count(*) FROM pg_indexes WHERE schemaname = 'public';
SELECT 'triggers     = ' || count(*) FROM pg_trigger WHERE NOT tgisinternal;
SELECT 'migrations   = ' || count(*) FROM schema_migrations;
SQL

echo
echo "==> restored into '$TARGET'."
echo "    Compare the numbers above against the source before trusting it,"
echo "    and check that 'unbalanced transactions = 0'."
