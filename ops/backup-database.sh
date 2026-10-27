#!/bin/sh
set -eu

# The encrypted repository is initialized once. A wrong password still fails.
if ! restic snapshots >/dev/null 2>&1; then
  restic init
fi
restic backup /backups
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
restic check
# Staging files are not backups after Restic has safely stored them off-site.
find /backups -type f -name 'nexaai-*.dump' -mtime +2 -delete
echo "Encrypted off-site database backup completed and checked."
