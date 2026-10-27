#!/bin/sh
set -eu
umask 077

# A custom-format dump supports integrity listing and controlled pg_restore.
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
temporary="/backups/nexaai-${stamp}.dump.partial"
completed="/backups/nexaai-${stamp}.dump"
pg_dump --format=custom --no-owner --no-acl --file="$temporary"
pg_restore --list "$temporary" >/dev/null
mv "$temporary" "$completed"
echo "Created and listed ${completed}."
