#!/bin/sh
set -eu

# This volume contains only disposable restore-drill output.
find /restore -mindepth 1 -maxdepth 1 -type d -name 'restore-*' -exec rm -rf -- {} +
target="/restore/restore-$(date -u +%Y%m%dT%H%M%SZ)"
restic restore latest --target "$target"
echo "Downloaded latest snapshot into the isolated restore workspace."
