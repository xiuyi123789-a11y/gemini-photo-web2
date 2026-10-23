#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
umask 077
command -v timeout >/dev/null || { echo "GNU timeout is required."; exit 1; }
compose=(docker compose --env-file .env.tencent)
target="backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$target"
# Stop writes so database and image snapshots describe the same point in time.
trap 'timeout --foreground --kill-after=10s 45s "${compose[@]}" start app </dev/null' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
timeout --foreground --kill-after=10s 45s "${compose[@]}" stop app </dev/null
echo "Database backup (timeout 90s)."
timeout --foreground --kill-after=10s 90s "${compose[@]}" exec -T --interactive=false db timeout --kill-after=5s 80s pg_dump --no-password --verbose --lock-wait-timeout=30s -U quantumleap -d quantumleap -Fc </dev/null > "$target/database.dump"
# A one-off container can read the existing image volume while the app is stopped.
echo "Image backup (timeout 180s)."
timeout --foreground --kill-after=10s 180s "${compose[@]}" run --rm --no-deps -T --interactive=false --entrypoint tar app -C /app/data --checkpoint=1000 -czf - . </dev/null > "$target/images.tar.gz"
test -s "$target/database.dump"
test -s "$target/images.tar.gz"
echo "Backup saved to $target; copy BOTH files to a separate encrypted backup location."
