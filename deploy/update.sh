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
on_exit() {
  local code=$?
  trap - EXIT
  if (( stopped )); then "${compose[@]}" start app >/dev/null || true; fi
  if (( code != 0 && replaced )); then
    echo "Update failed; restoring the saved application image."
    "${docker_cmd[@]}" compose --env-file .env.tencent -f compose.yaml -f "$backup/rollback.compose.yaml" up -d --no-deps --no-build app || true
    echo "Rollback image: $rollback_tag"
  fi
  if (( code != 0 )); then echo "Deployment not confirmed. Recovery files: $backup"; fi
  exit "$code"
}
trap on_exit EXIT

echo "Saving a consistent database and image backup."
stopped=1
"${compose[@]}" stop app
"${compose[@]}" exec -T db pg_dump -U quantumleap -d quantumleap -Fc > "$backup/database.dump"
"${compose[@]}" run --rm --no-deps -T --entrypoint tar app -C /app/data -czf - . > "$backup/images.tar.gz"
test -s "$backup/database.dump"
test -s "$backup/images.tar.gz"
"${compose[@]}" exec -T db pg_restore --list < "$backup/database.dump" > "$backup/database-contents.txt"
tar -tzf "$backup/images.tar.gz" >/dev/null
"${compose[@]}" start app
stopped=0

git pull --ff-only origin "$branch"
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
"${compose[@]}" exec -T app node --input-type=module -e \
  'import fs from "node:fs"; const health=await fetch("http://127.0.0.1:3001/api/health"); if(!health.ok)process.exit(1); const protectedApi=await fetch("http://127.0.0.1:3001/api/replication/connectivity",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}); if(protectedApi.status!==401)process.exit(1); const js=fs.readdirSync("dist/assets").filter(n=>n.endsWith(".js")).map(n=>fs.readFileSync("dist/assets/"+n,"utf8")).join(""); if(!js.includes("图像复刻"))process.exit(1); console.log("APP_HEALTH_AUTH_AND_FEATURE_OK");'
curl --fail --silent --show-error --max-time 20 "$public_origin/api/health" > "$backup/public-health.json"
public_status="$(curl --silent --show-error --max-time 20 -o /dev/null -w '%{http_code}' "$public_origin")"
[[ "$public_status" == 200 ]] || { echo "Public page returned HTTP $public_status"; exit 1; }
"${compose[@]}" exec -T app node --input-type=module -e \
  'const r=await fetch("https://api.replicate.com/v1/models/openai/o4-mini",{signal:AbortSignal.timeout(20000)}); if(![200,401,403].includes(r.status))throw new Error("Unexpected Replicate status: "+r.status); console.log("REPLICATE_NETWORK_OK HTTP "+r.status+" (network only; user Token is checked in the page)");'
replaced=0
printf '%s\n' "$expected" > "$backup/deployed-commit.txt"
"${compose[@]}" ps
echo "DEPLOYMENT_OK $expected $public_origin"
echo "Backup and rollback files: $backup"
