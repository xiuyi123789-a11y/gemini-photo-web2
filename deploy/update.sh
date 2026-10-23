#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Run from the existing production Git checkout. Never reset/stash its local config.
cd "$(git rev-parse --show-toplevel)"
expected="${1:?Usage: bash deploy/update.sh EXPECTED_COMMIT [PUBLIC_ORIGIN]}"
public_origin="${2:-https://studio.xiuyi-ai.cn}"
branch="chore/tencent-cloud-migration"
[[ "$expected" =~ ^[0-9a-f]{40}$ ]] || { echo "Expected commit must be a full SHA."; exit 1; }
[[ "$public_origin" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || { echo "Invalid HTTPS origin."; exit 1; }
[[ "$(git branch --show-current)" == "$branch" ]] || { echo "Wrong Git branch; no changes made."; exit 1; }
[[ -f .env.tencent ]] || { echo ".env.tencent is missing; no changes made."; exit 1; }
while IFS= read -r changed; do
  [[ -z "$changed" || "$changed" == "deploy/Caddyfile" ]] || { echo "Uncommitted source changes: $changed. No changes made."; exit 1; }
done < <(git diff --name-only HEAD)

if docker info >/dev/null 2>&1; then docker_cmd=(docker);
elif sudo -n docker info >/dev/null 2>&1; then docker_cmd=(sudo -n docker);
else
  echo "Docker access requires authentication. Run 'sudo docker info' yourself, then rerun this script. Do not share passwords."
  exit 1
fi
compose=("${docker_cmd[@]}" compose --env-file .env.tencent)
command -v timeout >/dev/null || { echo "GNU timeout is required; no changes made."; exit 1; }
step() {
  local label="$1" limit="$2" code
  shift 2
  printf '[%s] %s (timeout %s)\n' "$(date -u +%H:%M:%S)" "$label" "$limit" >&2
  if timeout --foreground --kill-after=10s "$limit" "$@"; then
    printf '[%s] %s: done\n' "$(date -u +%H:%M:%S)" "$label" >&2
  else
    code=$?
    printf '%s failed or timed out (exit %s).\n' "$label" "$code" >&2
    return "$code"
  fi
}
"${compose[@]}" config --quiet
available_kb="$(df -Pk . | awk 'NR==2 {print $4}')"
(( available_kb >= 2097152 )) || { echo "Less than 2 GiB free disk space; no changes made."; exit 1; }
mkdir -p .local/deployments
exec 9>.local/deployments/update.lock
flock -n 9 || { echo "Another deployment is running; no changes made."; exit 1; }

git fetch origin "$branch"
[[ "$(git rev-parse "origin/$branch")" == "$expected" ]] || { echo "Remote commit differs from the reviewed deployment target."; exit 1; }
git merge-base --is-ancestor HEAD "$expected" || { echo "Update is not a fast-forward."; exit 1; }
container="$("${compose[@]}" ps -q app)"
[[ -n "$container" ]] || { echo "Existing app container not found; this script only updates an existing deployment."; exit 1; }
db_container="$("${compose[@]}" ps -q db)"
[[ -n "$db_container" ]] || { echo "Database container not found; no changes made."; exit 1; }
old_image="$("${docker_cmd[@]}" inspect --format '{{.Image}}' "$container")"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup=".local/deployments/$stamp"
mkdir -p "$backup"
rollback_tag="quantumleap-app:rollback-$stamp"
"${docker_cmd[@]}" image tag "$old_image" "$rollback_tag"
git rev-parse HEAD > "$backup/previous-commit.txt"
printf '%s\n' "$old_image" > "$backup/previous-image.txt"
cp -- deploy/Caddyfile "$backup/Caddyfile"
cp -- .env.tencent "$backup/.env.tencent"
printf 'services:\n  app:\n    image: %s\n' "$rollback_tag" > "$backup/rollback.compose.yaml"
stopped=0
replaced=0
backup_container="quantumleap-backup-$stamp"
on_exit() {
  local code=$?
  trap - EXIT
  if (( code != 0 )); then
    timeout --foreground --kill-after=5s 20s "${docker_cmd[@]}" rm -f "$backup_container" >/dev/null 2>&1 || true
  fi
  if (( stopped )); then
    step "Restore previous app" 45s "${compose[@]}" start app </dev/null || echo "App restart failed; run docker compose --env-file .env.tencent start app manually." >&2
  fi
  if (( code != 0 && replaced )); then
    echo "Update failed; restoring the saved application image."
    "${docker_cmd[@]}" compose --env-file .env.tencent -f compose.yaml -f "$backup/rollback.compose.yaml" up -d --no-deps --no-build app || true
    echo "Rollback image: $rollback_tag"
  fi
  if (( code != 0 )); then echo "Deployment not confirmed. Recovery files: $backup"; fi
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Saving a consistent database and image backup."
stopped=1
step "Stop app for backup" 45s "${compose[@]}" stop app </dev/null
# Plain docker exec is noninteractive by default. Close input explicitly so the
# web terminal cannot keep a Compose attach session waiting for keyboard input.
step "Database backup" 90s "${docker_cmd[@]}" exec "$db_container" timeout --kill-after=5s 80s pg_dump --no-password --verbose --lock-wait-timeout=30s -U quantumleap -d quantumleap -Fc </dev/null > "$backup/database.dump"
step "Image backup" 180s "${docker_cmd[@]}" run --rm --name "$backup_container" --network none --volumes-from "$container:ro" --entrypoint tar "$old_image" -C /app/data --checkpoint=1000 -czf - . </dev/null > "$backup/images.tar.gz"
test -s "$backup/database.dump"
test -s "$backup/images.tar.gz"
# The snapshot is complete; validate its archives after restoring availability.
step "Restart previous app" 45s "${compose[@]}" start app </dev/null
stopped=0
step "Validate database backup" 60s "${docker_cmd[@]}" exec -i "$db_container" timeout --kill-after=5s 50s pg_restore --list < "$backup/database.dump" > "$backup/database-contents.txt"
step "Validate image backup" 60s tar -tzf "$backup/images.tar.gz" >/dev/null
printf 'validated\n' > "$backup/backup-complete.txt"

# Backups stay private under umask 077; Git-created source files need normal modes.
( umask 022; step "Update source" 90s git pull --ff-only origin "$branch" )
[[ "$(git rev-parse HEAD)" == "$expected" ]] || { echo "Unexpected source revision after pull."; exit 1; }
cmp -- deploy/Caddyfile "$backup/Caddyfile" || { echo "Caddy configuration changed unexpectedly."; exit 1; }
"${compose[@]}" build app
# Confirm the new native image library works on Linux before replacing production.
image="$("${docker_cmd[@]}" image inspect --format '{{.Id}}' quantumleap-app:latest)"
"${docker_cmd[@]}" run --rm --network none --entrypoint node "$image" --input-type=module -e \
  'import sharp from "sharp"; const png=await sharp({create:{width:4,height:4,channels:3,background:"white"}}).png().toBuffer(); if(!png.length)process.exit(1); console.log("SHARP_LINUX_OK");'

replaced=1
"${compose[@]}" up -d --no-deps --no-build app
healthy=0
for attempt in $(seq 1 60); do
  container="$("${compose[@]}" ps -q app)"
  state="$("${docker_cmd[@]}" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
  if [[ "$state" == healthy ]]; then healthy=1; break; fi
  if [[ "$state" == unhealthy || "$state" == exited ]]; then break; fi
  sleep 2
done
(( healthy )) || { echo "New app did not become healthy."; exit 1; }
step "Check app health, authentication and feature" 45s "${compose[@]}" exec -T --interactive=false app node --input-type=module -e \
  'import fs from "node:fs"; const health=await fetch("http://127.0.0.1:3001/api/health",{signal:AbortSignal.timeout(10000)}); if(!health.ok)process.exit(1); const protectedApi=await fetch("http://127.0.0.1:3001/api/replication/connectivity",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}",signal:AbortSignal.timeout(10000)}); if(protectedApi.status!==401)process.exit(1); const js=fs.readdirSync("dist/assets").filter(n=>n.endsWith(".js")).map(n=>fs.readFileSync("dist/assets/"+n,"utf8")).join(""); if(!js.includes("图像复刻"))process.exit(1); console.log("APP_HEALTH_AUTH_AND_FEATURE_OK");' </dev/null
curl --fail --silent --show-error --max-time 20 "$public_origin/api/health" > "$backup/public-health.json"
public_status="$(curl --silent --show-error --max-time 20 -o /dev/null -w '%{http_code}' "$public_origin")"
[[ "$public_status" == 200 ]] || { echo "Public page returned HTTP $public_status"; exit 1; }
step "Check Replicate network" 30s "${compose[@]}" exec -T --interactive=false app node --input-type=module -e \
  'const r=await fetch("https://api.replicate.com/v1/models/openai/o4-mini",{signal:AbortSignal.timeout(20000)}); if(![200,401,403].includes(r.status))throw new Error("Unexpected Replicate status: "+r.status); console.log("REPLICATE_NETWORK_OK HTTP "+r.status+" (network only; user Token is checked in the page)");' </dev/null
replaced=0
printf '%s\n' "$expected" > "$backup/deployed-commit.txt"
"${compose[@]}" ps
echo "DEPLOYMENT_OK $expected $public_origin"
echo "Backup and rollback files: $backup"
