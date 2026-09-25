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
  rm -rf "$RUNTIME_DIR"
  exit "$status"
}
trap cleanup EXIT INT TERM

cp -R "$ROOT/tests/integration/ha-config/." "$RUNTIME_DIR"
export HA_CONFIG_PATH="$RUNTIME_DIR"

docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d

attempt=1
while [ "$attempt" -le 60 ]; do
  if curl --fail --silent --show-error http://localhost:8123/api/trips_recorder/trips >/dev/null 2>&1; then
    break
  fi
  sleep 2
  attempt=$((attempt + 1))
done

if [ "$attempt" -gt 60 ]; then
  echo "Home Assistant did not expose the Trips Recorder API" >&2
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
  if curl --fail --silent --show-error http://localhost:8123/api/trips_recorder/trips |
    python3 -c 'import json, sys; data = json.load(sys.stdin); expected = {"e2e-default", "e2e-client", "e2e-simple", "e2e-custom"}; sys.exit(not (expected <= set(data["vehicles"]) and expected <= {trip["vehicle"] for trip in data["trips"]}))'; then
    exit 0
  fi
  sleep 2
  attempt=$((attempt + 1))
done

echo "All four simulated trips were not returned by the Trips Recorder API" >&2
exit 1