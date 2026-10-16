#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE="$ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'Missing %s. Copy .env.example to .env and set the dev login first.\n' "$ENV_FILE" >&2
  exit 1
fi

read_env_value() {
  local key=$1
  local value

  if ! value=$(awk -F= -v key="$key" '
    /^[[:space:]]*#/ || NF == 0 { next }
    $1 == key {
      count++
      sub(/^[^=]*=/, "")
      value = $0
    }
    END {
      if (count != 1) {
        exit 1
      }
      print value
    }
  ' "$ENV_FILE"); then
    printf 'Expected exactly one %s entry in %s.\n' "$key" "$ENV_FILE" >&2
    exit 1
  fi

  if [[ -z "$value" ]]; then
    printf 'Set %s in %s before resetting the password.\n' "$key" "$ENV_FILE" >&2
    exit 1
  fi

  printf '%s' "$value"
}

username=$(read_env_value HA_DEV_USERNAME)
password=$(read_env_value HA_DEV_PASSWORD)

if ! result=$(docker compose --project-directory "$ROOT" -f "$ROOT/docker-compose.dev.yml" \
  exec -T homeassistant hass --script auth --config /config \
  change_password "$username" "$password" 2>&1); then
  printf '%s\n' "$result" >&2
  exit 1
fi

if [[ "$result" != *"Password changed"* ]]; then
  printf 'Home Assistant did not confirm a password change:\n%s\n' "$result" >&2
  exit 1
fi

docker compose --project-directory "$ROOT" -f "$ROOT/docker-compose.dev.yml" \
  restart homeassistant

printf 'Password reset for %s; Home Assistant has been restarted.\n' "$username"
