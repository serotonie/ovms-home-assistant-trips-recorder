#!/usr/bin/env sh
set -eu

PREFIX="${OVMS_TOPIC_PREFIX:-ovms}"
USERNAME="${OVMS_TOPIC_USERNAME:-demo}"
VEHICLE_IDS="${OVMS_VEHICLE_IDS:-${OVMS_VEHICLE_ID:-car-1}}"
TOPIC_STRUCTURE="${OVMS_TOPIC_STRUCTURE:-\{prefix\}/\{mqtt_username\}/\{vehicle_id\}}"

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[\\/&|]/\\&/g'
}

topic_base() {
  structure="$TOPIC_STRUCTURE"
  prefix=$(escape_sed_replacement "$PREFIX")
  username=$(escape_sed_replacement "$USERNAME")
  vehicle_id=$(escape_sed_replacement "$1")
  base=$(printf '%s' "$structure" | sed \
    -e "s|{prefix}|$prefix|g" \
    -e "s|{mqtt_username}|$username|g" \
    -e "s|{vehicle_id}|$vehicle_id|g")
  case "$base" in
    *'{'*|*'}'*)
      echo "Invalid OVMS_TOPIC_STRUCTURE: $TOPIC_STRUCTURE" >&2
      exit 2
      ;;
  esac
  printf '%s\n' "$base"
}

if [ "$TOPIC_STRUCTURE" = "custom" ]; then
  echo "OVMS_TOPIC_STRUCTURE must be the custom template, not 'custom'" >&2
  exit 2
fi

publish() {
  topic="$1"
  payload="$2"
  mosquitto_pub -h "${MQTT_HOST:-mosquitto}" -p "${MQTT_PORT:-1883}" \
    -t "$topic" -m "$payload"
}

metric() {
  publish "${BASE}/metric/$1" "$2"
}

random_int() {
  min="$1"
  max="$2"
  value=$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')
  echo $((min + value % (max - min + 1)))
}

random_float() {
  min="$1"
  max="$2"
  value=$(random_int 0 100000)
  awk -v min="$min" -v max="$max" -v value="$value" \
    'BEGIN { printf "%.6f\n", min + (max - min) * value / 100000 }'
}

format_time() {
  date -u -d "@$1" '+%Y-%m-%d %H:%M:%S UTC'
}

TRIP_PAUSE="${OVMS_TRIP_PAUSE:-25}"
TRIP_COUNT_OVERRIDE="${OVMS_TRIP_COUNT:-}"
WAYPOINT_PAUSE_OVERRIDE="${OVMS_WAYPOINT_PAUSE:-}"
SEEN_VEHICLE_IDS=""

for VEHICLE_ID in $(printf '%s' "$VEHICLE_IDS" | tr ',' ' '); do
  case " $SEEN_VEHICLE_IDS " in
    *" $VEHICLE_ID "*)
      echo "Skipping duplicate vehicle ID: ${VEHICLE_ID}"
      continue
      ;;
  esac
  SEEN_VEHICLE_IDS="$SEEN_VEHICLE_IDS $VEHICLE_ID"
  BASE=$(topic_base "$VEHICLE_ID")
  if [ -n "$TRIP_COUNT_OVERRIDE" ]; then
    TRIP_COUNT="$TRIP_COUNT_OVERRIDE"
  else
    TRIP_COUNT=$(random_int 3 7)
  fi
  CURRENT_TIME=$(date -u +%s)
  CURRENT_TIME=$((CURRENT_TIME - $(random_int 1 30) * 86400))
  CURRENT_TIME=$((CURRENT_TIME + $(random_int 6 21) * 3600 + $(random_int 0 59) * 60))
  ODOMETER=12000

  echo "Starting ${TRIP_COUNT} simulated trips for ${VEHICLE_ID} on ${BASE}"

  trip=1
  while [ "$trip" -le "$TRIP_COUNT" ]; do
    START_LAT=$(random_float 48.80 48.90)
    START_LON=$(random_float 2.25 2.45)
    END_LAT=$(random_float 48.75 48.95)
    END_LON=$(random_float 2.15 2.55)
    DISTANCE=$(random_int 3 35)
    POINTS=$(random_int 3 6)
    ELAPSED=0

    echo "Starting simulated trip ${trip}/${TRIP_COUNT} (${DISTANCE} km)"
    publish "${BASE}/event/vehicle/on" "vehicle.on"

    point=0
    while [ "$point" -le "$POINTS" ]; do
      LATITUDE=$(awk -v start="$START_LAT" -v end="$END_LAT" -v point="$point" \
        -v points="$POINTS" 'BEGIN { printf "%.6f\n", start + (end - start) * point / points }')
      LONGITUDE=$(awk -v start="$START_LON" -v end="$END_LON" -v point="$point" \
        -v points="$POINTS" 'BEGIN { printf "%.6f\n", start + (end - start) * point / points }')
      TRIP_DISTANCE=$(awk -v distance="$DISTANCE" -v point="$point" -v points="$POINTS" \
        'BEGIN { printf "%.1f\n", distance * point / points }')
      TRIP_ODOMETER=$(awk -v odometer="$ODOMETER" -v distance="$DISTANCE" \
        -v point="$point" -v points="$POINTS" 'BEGIN {
          printf "%.1f\n", odometer + distance * point / points
        }')
      POINT_TIME=$((CURRENT_TIME + ELAPSED))

      metric "v/p/latitude" "$LATITUDE"
      metric "v/p/longitude" "$LONGITUDE"
      metric "v/p/gpshdop" "$(random_float 0.6 1.4)"
      metric "v/p/odometer" "$TRIP_ODOMETER"
      metric "v/p/trip" "$TRIP_DISTANCE"
      metric "m/time/utc" "$(format_time "$POINT_TIME")"
      if [ "$point" -lt "$POINTS" ]; then
        ELAPSED=$((ELAPSED + $(random_int 3 12) * 60))
        if [ -n "$WAYPOINT_PAUSE_OVERRIDE" ]; then
          WAYPOINT_PAUSE="$WAYPOINT_PAUSE_OVERRIDE"
        else
          WAYPOINT_PAUSE=$(random_int 2 8)
        fi
        echo "Waiting ${WAYPOINT_PAUSE}s before waypoint $((point + 1))/${POINTS}"
        sleep "$WAYPOINT_PAUSE"
      fi
      point=$((point + 1))
    done

    publish "${BASE}/event/vehicle/off" "vehicle.off"
    ODOMETER=$(awk -v odometer="$ODOMETER" -v distance="$DISTANCE" \
      'BEGIN { printf "%.1f\n", odometer + distance }')
    CURRENT_TIME=$((CURRENT_TIME + ELAPSED + $(random_int 12 72) * 3600))
    echo "Trip ${trip} completed"
    if [ "$trip" -lt "$TRIP_COUNT" ]; then
      echo "Waiting ${TRIP_PAUSE}s for trip finalization"
      sleep "$TRIP_PAUSE"
    fi
    trip=$((trip + 1))
  done
done

echo "All simulated trips completed"
