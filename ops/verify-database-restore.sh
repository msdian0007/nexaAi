#!/bin/sh
set -eu

if [ "${ALLOW_RESTORE_DRILL:-no}" != "yes" ]; then
  echo "Set ALLOW_RESTORE_DRILL=yes to create the temporary drill database." >&2
  exit 2
fi

drill_database="nexaai_restore_drill"
dump="$(find /restore -type f -name 'nexaai-*.dump' | sort | tail -n 1)"
if [ -z "$dump" ]; then
  echo "No restored NexaAI dump was found." >&2
  exit 3
fi

# The fixed prefixed database is temporary and never receives application traffic.
cleanup() { dropdb --if-exists "$drill_database" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
cleanup
createdb "$drill_database"
pg_restore --exit-on-error --no-owner --no-acl --dbname="$drill_database" "$dump"
psql --dbname="$drill_database" --no-psqlrc --tuples-only --command="SELECT extname FROM pg_extension WHERE extname = 'vector';" | grep -q vector
psql --dbname="$drill_database" --no-psqlrc --tuples-only --command='SELECT COUNT(*) FROM "_prisma_migrations";' | grep -Eq '[1-9][0-9]*'
psql --dbname="$drill_database" --no-psqlrc --tuples-only --command='SELECT COUNT(*) FROM "Organization";' >/dev/null
echo "Restore drill passed: dump restored, pgvector and migration history are present."
