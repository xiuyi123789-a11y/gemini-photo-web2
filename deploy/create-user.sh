#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
username="${1:-}"
if [[ ! "$username" =~ ^[a-z0-9_-]{3,40}$ ]]; then
    echo 'Usage: bash deploy/create-user.sh <username: 3-40 lowercase letters/digits/_/->' >&2
    exit 1
fi
if [[ ! -t 0 || ! -t 1 ]]; then
    echo 'Run this helper in an interactive terminal.' >&2
    exit 1
fi
if [[ ! -f .env.tencent ]]; then
    echo 'Missing .env.tencent; configure the deployment first.' >&2
    exit 1
fi
docker_command=(docker)
if ! docker info >/dev/null 2>&1; then
    # Check the actual Docker command, respecting existing sudo policy.
    # Never prompt for sudo inside the application's password input or pipe.
    if sudo -n docker info >/dev/null 2>&1; then
        docker_command=(sudo -n docker)
    else
        echo 'Cannot access Docker with current permissions.' >&2
        echo 'Run sudo docker info in this terminal to inspect the error.' >&2
        echo 'If sudo asks for a password, it needs the Ubuntu SERVER password, not the studio password.' >&2
        echo 'After successful server authentication, run this helper again. Do not share either password.' >&2
        exit 1
    fi
fi
trap 'unset password confirmation' EXIT
while true; do
    IFS= read -r -s -p 'Password (12-256 characters, hidden): ' password
    printf '\nReceived %d characters (password hidden).\n' "${#password}"
    if (( ${#password} < 12 || ${#password} > 256 )); then
        echo 'Length must be 12-256 characters. Try again.'
        continue
    fi
    IFS= read -r -s -p 'Confirm password (hidden): ' confirmation
    printf '\n'
    if [[ "$password" != "$confirmation" ]]; then
        echo 'Passwords do not match. Try again.'
        continue
    fi
    break
done
# Password travels through stdin, never command arguments, environment variables or files.
printf '%s' "$password" | "${docker_command[@]}" compose --env-file .env.tencent exec -T app node server/create-user.js "$username" --password-stdin
