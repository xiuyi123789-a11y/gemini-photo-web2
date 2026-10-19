#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
umask 077
compose=(docker compose --env-file .env.tencent)
target="backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$target"
# Stop writes so database and image snapshots describe the same point in time.
trap '"${compose[@]}" start app >/dev/null' EXIT
"${compose[@]}" stop app
"${compose[@]}" exec -T db pg_dump -U quantumleap -d quantumleap -Fc > "$target/database.dump"
# A one-off container can read the existing image volume while the app is stopped.
"${compose[@]}" run --rm --no-deps -T --entrypoint tar app -C /app/data -czf - . > "$target/images.tar.gz"
test -s "$target/database.dump"
test -s "$target/images.tar.gz"
echo "Backup saved to $target; copy BOTH files to a separate encrypted backup location."
