# OVMS Home Assistant Trips Recorder

OVMS Home Assistant Trips Recorder is a Home Assistant component for recording trips and displaying them in a sidebar panel.

It uses the OVMS Home Assistant integration to retrieve the vehicle and broker
configuration and records trips from entities created by the OVMS integration.
The parent integration handles the MQTT connection. It is available here:

https://github.com/enoch85/ovms-home-assistant

Component repository:
https://github.com/serotonie/ovms-home-assistant-trips-recorder

## Goals

- rely only on OVMS data already published in Home Assistant
- store trips in Home Assistant local storage
- provide a sidebar panel for viewing a vehicle's trips
- remain compatible with a HACS installation

## Trip status

While a trip is in progress, its card displays a localized status badge next to
the vehicle name and its map route is semi-transparent. Both update live as new
trip data arrives. When the trip ends, the badge disappears and the route becomes
fully opaque without recreating the map.

## Results pagination

The sidebar loads the newest trips in batches of **10**. Changing a filter
restarts at the newest matching trips.

Scrolling near the bottom automatically loads the next batch. **Load more**
is also available for keyboard navigation or browsers without infinite-scroll
support. The counter shows loaded / matching trips until all matches are loaded.
Loading failures keep existing results and offer **Retry** instead of repeatedly
retrying automatically. Live trip updates refresh the already-loaded window,
without loading the entire history or recreating unchanged map containers.

The **Driver** and **Category** dropdowns combine with the date and vehicle
filters. Driver matches an exact person entity ID; category matches trips
containing that category (including trips with multiple categories). The
dropdowns follow their respective integration visibility settings. An already
selected filter stays visible if the setting is subsequently hidden, so it can
be cleared. **Reset** clears all filters.

Choices include current people/categories and assignments from the entire trip
history, not only the loaded batch, so deleted people and removed categories
remain searchable. Driver names are displayed when the person still exists.

Both trip read endpoints accept optional `driver` and `category` query parameters:

- `/api/ovms_trips_recorder/trips?driver=person.alice&category=Work&limit=10`
- `/api/ovms_trips_recorder/vehicles/car/trips?from=2026-10-01T00:00:00Z&to=2026-10-31T23:59:59Z&driver=person.alice&category=Work`

Parameters are single, exact, case-sensitive values; URL-encode names containing
spaces or special characters. Empty values disable a filter. All supplied
filters are combined with AND, and unknown values return no matches. Filtering
is applied before counts and pagination. Trips without assignments do not match
a non-empty driver/category filter. Omitting parameters preserves existing
behavior; the vehicle endpoint retains its required datetime interval and
authentication. API filtering works regardless of panel visibility settings.
The panel trips response also includes unfiltered `driver_ids` and
`category_names` lists for history-wide filter choices.

## Trip drivers

Drivers are Home Assistant **person entities**, not login accounts. Create them
under **Settings > People**. Driver controls are **disabled by default**.
Administrators can enable **Show driver controls** under **Settings > Devices &
Services > OVMS Trips Recorder > Configure**. The switch is not in the Trips
panel. Changes apply immediately to open panels without restarting Home Assistant.
Upgrading from v2.6.0 preserves the previously saved switch value.
When enabled, each trip card displays its driver and lets any
authenticated user select a different person; changes are saved immediately,
including for ongoing trips.

Disabling the switch hides trip driver selectors and
missing-driver warnings for everyone. It does **not** stop automatic assignment:
new trips still use configured defaults, and all saved assignments and defaults
are retained. The switch is persistent across restarts and clearing trips.

In the same integration **Configure** dialog, administrators can use
**Default drivers per vehicle** to select a person for each configured or
previously recorded vehicle, even when panel driver controls are hidden.
Existing defaults are preserved when upgrading. Clear a vehicle's selection
to remove its default without altering assigned trips. Setting
a default also assigns it to that vehicle's existing and ongoing trips without a
driver. Changing a default never overwrites an already assigned driver.

Recording continues if no default has been configured or its person has been
deleted: affected new trips show **Driver not set** until assigned manually or
backfilled by configuring a valid default. Deleted people on already assigned
trips remain identifiable by their entity ID and can be replaced in the selector.
Person entity IDs and defaults persist across restarts; clearing trips preserves
defaults. English and French driver labels are provided, with English fallback
for other panel languages.

Trip JSON now includes a persistent `id` and a `driver` person entity ID
(`null` when not yet assigned). Older trips receive IDs on load. Existing trip
read APIs include these fields. Driver choices and writes require authentication:

- `GET /api/ovms_trips_recorder/drivers` returns `drivers` (`id`, `name`),
  `defaults` (vehicle ID to person entity ID), `vehicles`, and `enabled`
  (whether the panel shows driver controls).
- `PUT /api/ovms_trips_recorder/drivers/trip/{trip_id}` changes a trip's driver.

Trip driver writes accept `{"driver": "person.example"}`. Invalid people or bodies
return 400, unknown targets return 404, and unavailable storage returns 503.
Panel visibility and default drivers are managed only through the integration's
options flow; the former `/drivers/settings/enabled` and
`/drivers/vehicle/{vehicle_id}` write endpoints are no longer available.
This is a UI preference;
authenticated driver API reads/writes remain available while controls are hidden.

## Trip categories

Categories are optional and independent of drivers. Administrators configure
them under **Settings > Devices & Services > OVMS Trips Recorder > Configure**:

1. Enable **Show category controls** (disabled by default) and define the
   **Available categories**, such as `Work`, `Personal`, and `Commute`. Names are
   case-sensitive, unique, non-empty, and must not have surrounding spaces.
2. Continue to **Default categories per vehicle** and select zero, one, or many
   categories for each configured or previously recorded vehicle. This step
   appears when there are categories and vehicles. Save to apply both pages
   together; leaving the dialog without saving does not change the settings.

Only administrators can define the category list, visibility, and defaults through
Home Assistant's integration options. Any authenticated user can check or uncheck
one or more existing categories on active or completed trip cards. Edits save
immediately. No category-definition controls exist in the panel or its REST API.

Defaults apply to new trips and backfill existing/ongoing trips without categories
when category settings change. Categorized trips are never overwritten.
Hiding controls does not stop assignment. Clearing a trip's categories is allowed
and survives a restart; a later settings change may backfill that trip again.
Clearing defaults does not remove categories already assigned to trips.

Removing a category from the available list removes it from the choices/defaults
on the next options page, but retains it on previously categorized trips with a
**removed category** label. Users can retain or remove it there, but cannot newly
assign it to another trip. Renaming a category is removal plus addition; existing
assignments keep the old name. Re-adding the same name makes it available again.

Category settings and assignments persist across restarts; clearing trips
preserves the catalog, defaults, and visibility option. Existing trip JSON now
includes a `categories` list (empty when unassigned), and all trip read APIs
include it. Driver and category labels have English/French translations and
English fallback for other panel languages.

- `GET /api/ovms_trips_recorder/categories` (authenticated) returns `enabled`,
  `categories` (the available names), and `defaults` (vehicle IDs to category lists).
- `PUT /api/ovms_trips_recorder/categories/trip/{trip_id}` (authenticated)
  accepts `{"categories": ["Work", "Commute"]}` or `{"categories": []}`.
  Invalid lists or newly invented categories return 400, unknown trips return 404,
  and unavailable storage returns 503. Definitions cannot be changed by this API.

## Deleting trips

Administrators can permanently delete active or completed trips from the Trips
panel. Each trip card displays a delete action to administrators and asks for
confirmation before removing the trip. The API endpoint is also restricted to
administrators:

- `DELETE /api/ovms_trips_recorder/trips/{trip_id}` deletes the matching trip.
  It returns 403 for non-administrators, 404 for an unknown trip, and 503 when
  trip storage is unavailable.

## Merging trips

Administrators can merge a completed trip with the next completed, non-overlapping
trip for the same vehicle. The panel displays a preview of the combined route,
times, and distance in a dialog before the merge is confirmed. The merged trip
keeps the first trip's ID and start details, uses the second trip's stop details,
combines waypoints, and sums distances. Categories are combined and the first
available driver assignment is retained.

The administrator-only API offers a preview and a merge action:

- `GET /api/ovms_trips_recorder/trips/{trip_id}/merge-preview` returns the
  proposed combined trip.
- `POST /api/ovms_trips_recorder/trips/{trip_id}/merge` accepts
  `{"next_trip_id": "..."}` and rechecks that the trips are still mergeable.

Both endpoints require an administrator. Missing trips return 404, invalid or
stale merges return 409, and unavailable storage returns 503.

## Structure

```text
src/
  frontend-version.js
  panel-view.js
  panel.js
  translations.js
custom_components/
  ovms_trips_recorder/
    __init__.py
    const.py
    manifest.json
    panel.py
    panel.js
    trip_store.py
```

The frontend source is split by responsibility: `panel.js` manages the
Home Assistant component and trip state, `panel-view.js` renders the panel,
`translations.js` contains localized labels, and `frontend-version.js` handles
cache invalidation when the frontend version changes. Vite bundles these
modules and Leaflet into the single `custom_components/ovms_trips_recorder/panel.js`
file served by Home Assistant.

## HACS Installation

1. Add this repository as a custom HACS repository.
2. Install "OVMS Trips Recorder".
3. Also install and configure the OVMS Home Assistant integration.
4. Restart Home Assistant.
5. In Home Assistant, go to **Settings → Devices & Services → Add
   Integration**, then add **OVMS Trips Recorder**.
6. The sidebar panel will then be available from the dashboard sidebar.

## Development Environment

An isolated Home Assistant + Mosquitto environment is provided by
[`docker-compose.dev.yml`](docker-compose.dev.yml). It mounts the local
component and allows you to simulate an OVMS trip without using your usual Home
Assistant installation.

### Prerequisites

- Docker and Docker Compose;
- network access to clone the OVMS integration;
- network access for Nominatim reverse geocoding.

### Using the VS Code Dev Container

The repository also provides a configuration compatible with the VS Code **Dev
Containers** extension.

The development container uses the Python 3.13 / Debian Trixie image (image major
3) and the Node feature v2 with Node.js 24. After updating the container
configuration, run **Dev Containers: Rebuild Container** to apply the updates.

1. Install the `Dev Containers` extension;
2. open this repository in VS Code;
3. run the `Dev Containers: Reopen in Container` command;
4. wait for the container to finish building.

The `.devcontainer` configuration then automates:

- attaching VS Code to the Docker Compose `dev` service;
- cloning the OVMS integration into `dev/ovms-home-assistant`;
- installing `mosquitto-clients` and the Python dependencies;
- starting Home Assistant and Mosquitto as adjacent services.

Home Assistant is available at <http://localhost:8123>. Ports `8123` and `1883`
are automatically forwarded by VS Code.

The expected directory structure is:

```text
ovms-home-assistant-trips-recorder/
  dev/ovms-home-assistant/
    custom_components/ovms/
  docker-compose.dev.yml
```

### Starting the Environment

From the repository root:

```sh
git clone https://github.com/enoch85/ovms-home-assistant.git dev/ovms-home-assistant
docker compose -f docker-compose.dev.yml up -d
```

This step is performed automatically when the repository is opened in the VS
Code Dev Container.

The Home Assistant instance is then available at <http://localhost:8123>. Create
the administrator user using the credentials in the local `.env` file (see
below), then add the **OVMS** integration with the following settings:

#### Home Assistant dev login

The Home Assistant container does not support configuring its administrator
account in `configuration.yaml`. Keep the dev login in a local, Git-ignored
`.env` file so you can look it up later:

```sh
cp .env.example .env
```

Set `HA_DEV_USERNAME` and `HA_DEV_PASSWORD` in `.env`, then use those values
when creating the administrator during Home Assistant's first-run onboarding.
For an existing instance, the password can be reset to the value in `.env` by
running:

```sh
./dev/reset_ha_dev_password.sh
```

The script changes the password for `HA_DEV_USERNAME` and restarts the
Home Assistant container. If you do not remember the username, list configured
users first:

```sh
docker compose -f docker-compose.dev.yml exec homeassistant \
  hass --script auth --config /config list
```

Copy the matching username into `.env` before running the reset script. This
is a development-only convenience; do not reuse these credentials elsewhere.

> **Note**: in the dev environment, add the **OVMS Trips Recorder**
> integration from the UI after startup.

- broker: `mosquitto`;
- port: `1883`;
- username / password: leave both empty (the dev Mosquitto broker allows
  anonymous connections);
- protocol: `mqtt`;
- prefix: `ovms`;
- structure: `ovms/{mqtt_username}/{vehicle_id}`;
- topic user: `demo`;
- vehicle: `car-1`.

The **Trips Recorder** integration should then appear in the sidebar.

### Simulating a Trip

After configuring the OVMS entry:

```sh
./dev/simulate_trip.sh
```

The script publishes a random number of plausible trips (between three and
seven by default), with several interpolated GPS positions, odometer and
distance values, and start/stop events. The trips should appear in the
**Trips** panel. Set `OVMS_TRIP_COUNT` to force a specific number while
testing, for example `OVMS_TRIP_COUNT=2 ./dev/simulate_trip.sh`.
The simulator waits 25 seconds between trips so Home Assistant can finish
reverse geocoding; adjust this with `OVMS_TRIP_PAUSE` if needed.

### Topic Structures

The simulator uses the same topic structure as the parent OVMS entry. Configure
the parent entry in its UI, then pass that selected structure to the simulator
through `OVMS_TOPIC_STRUCTURE`:

| OVMS structure | Simulator command |
| --- | --- |
| `{prefix}/{mqtt_username}/{vehicle_id}` | `./dev/simulate_trip.sh` |
| `{prefix}/client/{vehicle_id}` | `OVMS_TOPIC_STRUCTURE='{prefix}/client/{vehicle_id}' ./dev/simulate_trip.sh` |
| `{prefix}/{vehicle_id}` | `OVMS_TOPIC_STRUCTURE='{prefix}/{vehicle_id}' ./dev/simulate_trip.sh` |
| `custom` | Select `custom` in OVMS, enter a template such as `garage/{vehicle_id}/telemetry`, then run `OVMS_TOPIC_STRUCTURE='garage/{vehicle_id}/telemetry' ./dev/simulate_trip.sh` |

The supported placeholders for a custom template are `{prefix}`,
`{mqtt_username}`, and `{vehicle_id}`. `OVMS_TOPIC_STRUCTURE` must contain the
template itself; do not set it to the literal value `custom`.

To simulate several vehicles, provide a comma-separated list of vehicle IDs:

```sh
OVMS_VEHICLE_IDS=car-1,car-2,car-3 ./dev/simulate_trip.sh
```

Each vehicle must also have its own OVMS integration entry in Home Assistant,
with the matching vehicle ID and the same broker, topic prefix, and topic user.
The Trips Recorder only accepts vehicles declared by those parent OVMS entries.
Repeated IDs are ignored by the simulator.
Changes to OVMS entries are detected automatically at runtime, so adding a
vehicle in the parent integration no longer requires restarting Home Assistant.
Configured vehicles are available in the panel filter immediately, even before
their first recorded trip.

To follow the Home Assistant logs:

```sh
docker compose -f docker-compose.dev.yml logs -f homeassistant
```

To stop and completely reset the environment:

```sh
docker compose -f docker-compose.dev.yml down -v
rm -rf dev/ha-config/.storage
```

Trips and waypoints remain stored even if geocoding fails. In that case, the
addresses are missing, but the GPS coordinates are preserved.

## REST API

Retrieve trips for one vehicle overlapping a date/time range:

```sh
curl --get \
  'http://localhost:8123/api/ovms_trips_recorder/vehicles/car-1/trips' \
  --header "Authorization: Bearer $HA_TOKEN" \
  --data-urlencode 'from=2026-10-01T00:00:00+02:00' \
  --data-urlencode 'to=2026-10-16T23:59:59+02:00'
```

Use a Home Assistant long-lived access token for `HA_TOKEN`. URL-encode the
vehicle ID when necessary. Both `from` and `to` are required ISO 8601 datetimes
with a timezone (`Z` or an explicit UTC offset). The interval is inclusive:
a trip matches when it starts at or before `to` and ends at or after `from`.
Trips in progress have an open-ended interval; trips without a known start time
are excluded. Legacy stored timestamps without a timezone are interpreted as UTC.

The JSON response contains `vehicle`, `from`, `to`, `trips`, and `count`.
`trips` contains the complete stored trip objects, including their waypoints,
in storage order. Unknown vehicles or ranges without matches return an empty
list with `count: 0`. Invalid or missing bounds, or `from` later than `to`,
return HTTP 400; unavailable trip storage returns HTTP 503. Malformed stored
timestamps are logged and the affected trips are skipped.

### Sidebar results API

`GET /api/ovms_trips_recorder/trips` accepts optional pagination parameters:

| Parameter | Meaning |
| --- | --- |
| `limit` | Batch size, 1–100 (default 10 when pagination is requested). |
| `offset` | Number of matching trips to skip (default 0). |
| `vehicle` | Exact vehicle ID; omitted for all vehicles. |
| `from`, `to` | Inclusive trip departure dates (`YYYY-MM-DD`), both optional. |
| `timezone` | IANA timezone for departure-date filters (default `UTC`). |

Supplying `limit` or `offset` enables pagination. Filtering happens before
pagination; results are newest-first, including ongoing trips. Dates use the
requested timezone; the panel supplies Home Assistant's configured timezone,
falling back to the browser timezone. Trips without a start timestamp remain
available without date filters and sort last.

The response retains `title`, `version`, `vehicles`, `trips`, and `count`.
`count` is the **total matching** count, not the batch length. Paginated
responses also include `limit`, `offset`, `has_more`, and `next_offset`
(`null` at the end). `vehicles` includes all configured/observed vehicles,
independently of filters. Invalid parameters return HTTP 400.

Without pagination parameters the endpoint still returns the complete list,
in storage order when unfiltered, for existing clients. The vehicle interval
endpoint above is unchanged. The `ovms_trips_recorder_updated` event now signals
invalidation only, without broadcasting the full trip history; clients should
refetch the results they need.

## Tests

Regression tests cover the sidebar panel and trip recording from OVMS entities.

From the repository root, run:

```sh
python3 -m pip install -r requirements.txt pytest
pytest -q tests/test_trip_store.py tests/test_panel_api.py
npm test
```

This executes the Python entity-listener regression tests and the Node.js panel
test suite in the [`tests/`](tests/) directory.

### End-to-End Test

The GitHub Actions workflow also starts Home Assistant, Mosquitto, the parent
OVMS integration, and this integration in Docker. It provisions four OVMS
entries, simulates one trip for each topic structure, and verifies that all four
trips are returned by the panel API. To run this check locally:

```sh
OVMS_PATH=../ovms-home-assistant tests/integration/run.sh
```

## OVMS Entity Dependency

The recorder listens to state changes from entities created by the parent OVMS
integration. It uses their topic attributes and states to detect trip start and
stop events and collect position, time, odometer, and distance metrics. The
recorder does not open a separate MQTT connection or need broker credentials;
the parent integration remains responsible for receiving OVMS MQTT data. Install
and configure at least one OVMS entry before using this component.

## Storage

Local storage is built on `homeassistant.helpers.storage.Store`, ensuring that
trips remain available after Home Assistant restarts.

## Notes

This component is designed as an extension of the OVMS integration, not as a
competing integration.

## Credits

Many thanks to [enoch85](https://github.com/enoch85) for the original
[OVMS Home Assistant integration](https://github.com/enoch85/ovms-home-assistant),
which this component extends.

This component was developed with the assistance of [GitHub
Copilot](https://github.com/features/copilot).

## Third-Party Licenses

This project is distributed under the [MIT License](LICENSE). Its Python
dependencies retain their respective licenses:

| Dependency | License | Source |
| --- | --- | --- |
| [geopy](https://github.com/geopy/geopy) | MIT | [License](https://github.com/geopy/geopy/blob/master/LICENSE) |
| [geographiclib](https://github.com/geographiclib/geographiclib-python) | MIT | [License](https://github.com/geographiclib/geographiclib-python/blob/main/LICENSE) |
