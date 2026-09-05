#!/usr/bin/env bash
#
# Local PostgreSQL + PostGIS + Redis for a machine where Docker will not run.
#
#   wsl -d Ubuntu -u root -- bash /mnt/c/.../scripts/wsl-infra.sh
#
# `-u root` rather than sudo: sudo in WSL asks for a password that cannot be
# supplied non-interactively.
#
# Assumes postgresql-18 and postgresql-18-postgis-3 are installed. See
# docs/LOCAL_INFRA_WSL.md for the apt line and for the two settings that
# actually matter (TCP listening, and PostGIS being per-database).
#
# REMEMBER: WSL terminates the distribution when its last process exits, so
# this script starts services that die moments after it returns unless
# something keeps the distro alive:
#
#   wsl -d Ubuntu -u root -- sleep infinity
#
set -euo pipefail

pg_ctlcluster 18 main start 2>/dev/null || true
sleep 3
pg_isready || { echo "POSTGRES NOT READY"; exit 1; }

# Role and databases the project expects. `docker-compose.yml` uses
# rideapp/rideapp, so matching it keeps one connection string for both paths.
su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='rideapp'\"" | grep -q 1 \
  || su postgres -c "psql -c \"CREATE ROLE rideapp LOGIN SUPERUSER PASSWORD 'rideapp'\""

for db in rideapp rideapp_test; do
  su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$db'\"" | grep -q 1 \
    || su postgres -c "createdb -O rideapp $db"
  # PostGIS per database, not per cluster - migration 0001 line 5 needs it.
  su postgres -c "psql -d $db -c 'CREATE EXTENSION IF NOT EXISTS postgis'" >/dev/null
  su postgres -c "psql -d $db -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto'" >/dev/null
done

echo "--- verification ---"
su postgres -c "psql -d rideapp -tAc \"SELECT 'postgis ' || postgis_version()\""
su postgres -c "psql -d rideapp_test -tAc \"SELECT 'test db ok'\""
redis-cli ping
echo "SETUP_COMPLETE"
