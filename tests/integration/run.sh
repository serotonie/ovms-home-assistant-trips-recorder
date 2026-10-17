#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
COMPOSE_FILE="$ROOT/tests/integration/docker-compose.yml"
RUNTIME_DIR=$(mktemp -d)
PROJECT_NAME="trips-recorder-e2e-$$"

if [ -z "${OVMS_PATH:-}" ]; then
  echo "OVMS_PATH must point to a checkout of ovms-home-assistant" >&2
  exit 2
fi

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" logs || true
  fi
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down --volumes --remove-orphans || true
  if ! rm -rf "$RUNTIME_DIR"; then
    if command -v sudo >/dev/null 2>&1; then
      sudo rm -rf "$RUNTIME_DIR"
    else
      echo "Unable to remove Docker-owned temporary files: $RUNTIME_DIR" >&2
    fi
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

cp -R "$ROOT/tests/integration/ha-config/." "$RUNTIME_DIR"
export HA_CONFIG_PATH="$RUNTIME_DIR"

docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d

attempt=1
while [ "$attempt" -le 60 ]; do
  if [ "$(curl --silent --output /dev/null --write-out '%{http_code}' \
    http://localhost:8123/api/ovms_trips_recorder/trips)" = 401 ]; then
    break
  fi
  sleep 2
  attempt=$((attempt + 1))
done

if [ "$attempt" -gt 60 ]; then
  echo "Home Assistant did not expose the Trips Recorder API" >&2
  exit 1
fi

# Create a disposable Home Assistant owner and exchange its onboarding code.
credential=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
auth_code=$(curl --fail --silent --show-error \
  -H 'Content-Type: application/json' \
  -d "{\"client_id\":\"http://localhost:8123/\",\"name\":\"API test\",\"username\":\"api-test\",\"password\":\"$credential\",\"language\":\"en\"}" \
  http://localhost:8123/api/onboarding/users |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["auth_code"])')
token=$(curl --fail --silent --show-error \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode 'client_id=http://localhost:8123/' \
  --data-urlencode "code=$auth_code" \
  http://localhost:8123/auth/token |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["access_token"])')

auth_scheme='Bearer'
# Each data route must reject anonymous requests before executing its handler.
# Authenticated writes use a missing trip so no recorded data is changed.
for definition in \
  'GET|trips|200|{}' \
  'GET|vehicles/unknown/trips?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z|200|{}' \
  'GET|drivers|200|{}' \
  'PUT|drivers/trip/missing|400|{}' \
  'GET|categories|200|{}' \
  'PUT|categories/trip/missing|404|{"categories":[]}' \
  'DELETE|trips/missing|404|{}' \
  'GET|trips/missing/merge-preview|404|{}' \
  'POST|trips/missing/merge|404|{"next_trip_id":"also-missing"}'; do
  method=${definition%%|*}
  rest=${definition#*|}
  path=${rest%%|*}
  rest=${rest#*|}
  expected=${rest%%|*}
  body=${rest#*|}
  url="http://localhost:8123/api/ovms_trips_recorder/$path"
  status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    -X "$method" -H 'Content-Type: application/json' -d "$body" "$url")
  if [ "$status" != 401 ]; then
    echo "$method $path: expected anonymous 401, received $status" >&2
    exit 1
  fi
  status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    -X "$method" -H 'Content-Type: application/json' -H "Authorization: $auth_scheme $token" \
    -d "$body" "$url")
  if [ "$status" != "$expected" ]; then
    echo "$method $path: expected authenticated $expected, received $status" >&2
    exit 1
  fi
done

status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  -H "Authorization: $auth_scheme invalid-test-token" \
  http://localhost:8123/api/ovms_trips_recorder/trips)
if [ "$status" != 401 ]; then
  echo "Invalid token: expected 401, received $status" >&2
  exit 1
fi

# Allow the parent and recorder MQTT clients to subscribe before publishing.
sleep 5

for definition in \
  'e2e-default|{prefix}/{mqtt_username}/{vehicle_id}' \
  'e2e-client|{prefix}/client/{vehicle_id}' \
  'e2e-simple|{prefix}/{vehicle_id}' \
  'e2e-custom|garage/{vehicle_id}/telemetry'; do
  vehicle_id=${definition%%|*}
  topic_structure=${definition#*|}
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" run --rm \
    -e OVMS_VEHICLE_ID="$vehicle_id" \
    -e OVMS_TOPIC_STRUCTURE="$topic_structure" \
    -e OVMS_TRIP_COUNT=1 \
    -e OVMS_TRIP_PAUSE=0 \
    -e OVMS_WAYPOINT_PAUSE=0 \
    simulator /test/simulate_trip.sh
done

attempt=1
while [ "$attempt" -le 30 ]; do
  if curl --fail --silent --show-error -H "Authorization: $auth_scheme $token" \
    http://localhost:8123/api/ovms_trips_recorder/trips |
    python3 -c 'import json, sys; data = json.load(sys.stdin); expected = {"e2e-default", "e2e-client", "e2e-simple", "e2e-custom"}; sys.exit(not (expected <= set(data["vehicles"]) and expected <= {trip["vehicle"] for trip in data["trips"]}))'; then
    exit 0
  fi
  sleep 2
  attempt=$((attempt + 1))
done

echo "All four simulated trips were not returned by the Trips Recorder API" >&2
exit 1