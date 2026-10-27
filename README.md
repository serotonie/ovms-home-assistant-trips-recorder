# OVMS Home Assistant Trips Recorder

Record your vehicle's trips automatically and browse their routes, dates, and
distances in Home Assistant's **Trips** sidebar panel. Trips are stored locally
and remain available after a restart.

This integration extends the
[OVMS Home Assistant integration](https://github.com/enoch85/ovms-home-assistant):
it uses the vehicle data already available in Home Assistant, without a separate
MQTT connection. Installation is managed through HACS.

**Already installed?** Start with the user guide below.
**Setting it up?** Go to [Administration](#2-administration).
**Contributing?** Go to [Development](#3-development).

## Contents

- [1. User guide](#1-user-guide)
  - [1.1. View trips](#11-view-trips)
  - [1.2. Filter and load results](#12-filter-and-load-results)
  - [1.3. Assign drivers and categories](#13-assign-drivers-and-categories)
  - [1.4. Merge trips](#14-merge-trips)
- [2. Administration](#2-administration)
  - [2.1. Install with HACS](#21-install-with-hacs)
  - [2.2. Configure drivers](#22-configure-drivers)
  - [2.3. Configure categories](#23-configure-categories)
  - [2.4. Delete trips](#24-delete-trips)
  - [2.5. Storage and troubleshooting](#25-storage-and-troubleshooting)
- [3. Development](#3-development)
  - [3.1. Architecture and source layout](#31-architecture-and-source-layout)
  - [3.2. Local development environment](#32-local-development-environment)
  - [3.3. REST API reference](#33-rest-api-reference)
  - [3.4. Tests](#34-tests)
- [4. Project information](#4-project-information)
  - [4.1. Credits](#41-credits)
  - [4.2. License and dependencies](#42-license-and-dependencies)

## 1. User guide

This section is for everyday Home Assistant users. If the **Trips** panel is not
available yet, ask an administrator to follow the [installation guide](#21-install-with-hacs).

### 1.1. View trips

Open **Trips** from the Home Assistant sidebar to browse recorded trips and
their routes. Recording is automatic; you do not need to start it from the panel.

While a trip is in progress, its card displays a localized status badge next to
the vehicle name and its map route is semi-transparent. Both update live as new
trip data arrives. When the trip ends, the badge disappears and the route becomes
fully opaque.

### 1.2. Filter and load results

The sidebar loads the newest trips in batches of **10**. Changing a filter
restarts at the newest matching trips.

Scrolling near the bottom automatically loads the next batch. **Load more**
is also available for keyboard navigation or browsers without infinite-scroll
support. The counter shows loaded / matching trips until all matches are loaded.
Loading failures keep existing results and offer **Retry** instead of repeatedly
retrying automatically. Live trip updates refresh the trips already on screen.

The **Driver** and **Category** dropdowns combine with the date and vehicle
filters. Choose a person to see their assigned trips, or a category to see trips
with that label (including trips with multiple categories). The
dropdowns follow their respective integration visibility settings. An already
selected filter stays visible if the setting is subsequently hidden, so it can
be cleared. **Reset** clears all filters.

Choices include current people/categories and assignments from the entire trip
history, not only the loaded batch, so deleted people and removed categories
remain searchable. Driver names are displayed when the person still exists.

### 1.3. Assign drivers and categories

Driver and category controls are optional and **disabled by default**. Ask an
administrator to enable them in the integration settings, not in the Trips panel.

When enabled, any signed-in user can:

- select a driver on an active or completed trip card;
- check or uncheck one or more categories from the available list.

Changes are saved immediately. Drivers are Home Assistant **person entities**,
not login accounts; categories are labels such as `Work`, `Personal`, or `Commute`.
The panel provides English and French labels, with English fallback for other
languages.

New trips can receive a default driver and categories configured by an
administrator. **Driver not set** means no valid driver has been assigned.
A deleted person remains identifiable by their entity ID and can be replaced.
A **removed category** can be kept or removed from an existing trip, but cannot
be newly assigned to another trip.

Clearing a trip's categories survives a restart, although a later administrator
change to category settings may fill in defaults again.

### 1.4. Merge trips

Administrators can merge a completed trip with the next completed, non-overlapping
trip for the same vehicle. When driver controls are enabled, a driver linked to a
Home Assistant user can also merge trips assigned to their person entity.

Use the merge action on an eligible trip card, review the combined route,
times, and distance in the preview dialog, then confirm. The merged trip keeps
the first trip's start details, uses the second trip's stop details, combines
waypoints and categories, sums distances, and retains the first available driver
assignment.

## 2. Administration

This section is for Home Assistant administrators installing the integration,
managing defaults, or deleting recorded data. Everyday users do not need Docker,
developer tools, or API access.

### 2.1. Install with HACS

**Prerequisites:** HACS and at least one configured vehicle in the
[OVMS Home Assistant integration](https://github.com/enoch85/ovms-home-assistant).
Verify that the parent integration is receiving vehicle data before using the
recorder; it manages the MQTT connection and broker credentials.

1. In HACS, add `https://github.com/serotonie/ovms-home-assistant-trips-recorder`
   as a custom repository of type **Integration**.
2. Install **OVMS Trips Recorder**.
3. Restart Home Assistant.
4. Go to **Settings > Devices & Services > Add Integration** and add
   **OVMS Trips Recorder**.
5. Open **Trips** from the Home Assistant sidebar.

Adding another vehicle in the parent OVMS integration is detected automatically,
without restarting Home Assistant. Configured vehicles appear in the panel's
vehicle filter even before their first recorded trip.

### 2.2. Configure drivers

Drivers are Home Assistant **person entities**, not login accounts. Create them
under **Settings > People**. Driver controls are **disabled by default**.
Administrators can enable **Show driver controls** under **Settings > Devices &
Services > OVMS Trips Recorder > Configure**. The switch is not in the Trips
panel. Changes apply immediately to open panels without restarting Home Assistant.
Upgrading from v2.6.0 preserves the previously saved switch value.
When enabled, any authenticated user can change a trip's driver, including for
ongoing trips.

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
deleted. Configure a valid default to backfill unassigned trips, or assign them
manually. Person entity IDs and defaults persist across restarts; clearing trips
preserves defaults.

**Access note:** hiding driver controls is a UI preference, not an API permission
restriction. Authenticated driver API reads and writes remain available.

### 2.3. Configure categories

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
preserves the catalog, defaults, and visibility option. As with drivers, hiding
controls does not restrict authenticated category API reads and writes.

### 2.4. Delete trips

Administrators can permanently delete active or completed trips from the Trips
panel. Each trip card displays a delete action to administrators and asks for
confirmation before removing the trip. Non-administrators cannot delete trips,
including through the API.

### 2.5. Storage and troubleshooting

Trips are stored locally in Home Assistant and survive restarts. Driver and
category settings are also persistent; clearing trips does not reset their
defaults or visibility settings.

**Privacy:** all integration data APIs require Home Assistant authentication,
including the sidebar's trip list with location and assignment data. The Trips
panel uses the current Home Assistant session. Hiding panel controls does not
restrict API access for authenticated users.

| Symptom | What to check |
| --- | --- |
| Trips panel is missing | Confirm that **OVMS Trips Recorder** was added under **Settings > Devices & Services**, not only downloaded in HACS. |
| A vehicle or its trips are missing | Confirm that the vehicle has its own parent OVMS integration entry and that its entities receive data. Only vehicles declared there are recorded. |
| Driver or category controls are missing | Enable the corresponding option in the integration's **Configure** dialog. These switches are not in the Trips panel. |
| Map tiles are missing | Maps load as they approach the viewport and send the Home Assistant origin as the cross-origin `Referer`. For a `403` or “General block”, inspect the tile request in browser network tools (status, `Referer`, and cache headers) and compare usage with the [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/). A block message does not identify its cause; do not spoof request identity or bypass restrictions. Choose a tile provider suited to your usage if needed. |
| A trip has coordinates but no address | Reverse geocoding may have failed. Trips and waypoints are still saved; GPS coordinates are preserved. |
| More results fail to load | Use **Retry** in the panel; already loaded trips are kept. |

## 3. Development

This section is for contributors working on the integration or clients of its
API. The local Docker environment is for development, not a requirement for
installing the integration in an existing Home Assistant instance.

To contribute, set up the local environment below, make your changes, add or
update the relevant regression tests, and run the test suites before opening a
pull request. For frontend changes, edit `src/` rather than the generated
`custom_components/ovms_trips_recorder/panel.js`; run `npm ci` and
`npm run build` from the repository root and include the rebuilt bundle.

### 3.1. Architecture and source layout

The recorder listens to state changes from entities created by the parent OVMS
integration. It uses their topic attributes and states to detect trip start and
stop events and collect position, time, odometer, and distance metrics. It does
not open its own MQTT connection. Persistence uses
`homeassistant.helpers.storage.Store`.

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

### 3.2. Local development environment

An isolated Home Assistant + Mosquitto environment is provided by
[`docker-compose.dev.yml`](docker-compose.dev.yml). It mounts the local
component and allows you to simulate an OVMS trip without using your usual Home
Assistant installation.

#### Prerequisites

- Docker and Docker Compose;
- network access to clone the OVMS integration;
- network access for Nominatim reverse geocoding.

#### Using the VS Code Dev Container

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

#### Starting the environment

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

##### Home Assistant dev login

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

Configure the parent **OVMS** integration with these development broker settings:

- broker: `mosquitto`;
- port: `1883`;
- username / password: leave both empty (the dev Mosquitto broker allows
  anonymous connections);
- protocol: `mqtt`;
- prefix: `ovms`;
- structure: `ovms/{mqtt_username}/{vehicle_id}`;
- topic user: `demo`;
- vehicle: `car-1`.

Then add **OVMS Trips Recorder** from **Settings > Devices & Services > Add
Integration**. The **Trips** panel should appear in the sidebar.

#### Simulating a trip

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

#### Topic structures

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

#### Logs and resetting the environment

To follow the Home Assistant logs:

```sh
docker compose -f docker-compose.dev.yml logs -f homeassistant
```

To stop and completely reset the environment:

```sh
docker compose -f docker-compose.dev.yml down -v
rm -rf dev/ha-config/.storage
```

### 3.3. REST API reference

All endpoints below require Home Assistant authentication, including
`GET /api/ovms_trips_recorder/trips`. Anonymous requests or invalid access tokens
receive HTTP 401. The Trips panel uses the current Home Assistant session.
External clients must use the `Authorization` header with the `Bearer` scheme
and a Home Assistant access token. Use a long-lived access token for `HA_TOKEN`
and keep it out of source control.
Driver/category visibility settings do not restrict their authenticated APIs;
deletion is administrator-only, and merging has the additional rules below.

Trip objects include a persistent `id`, a `driver` person entity ID (`null` when
unassigned), and a `categories` list (empty when unassigned), as well as the
recorded metrics and waypoints. Older trips receive IDs on load.

#### Vehicle trips by datetime interval

Retrieve trips for one vehicle overlapping a date/time range:

```sh
curl --get \
  'http://localhost:8123/api/ovms_trips_recorder/vehicles/car-1/trips' \
  --header "Authorization: Bearer $HA_TOKEN" \
  --data-urlencode 'from=2026-10-01T00:00:00+02:00' \
  --data-urlencode 'to=2026-10-16T23:59:59+02:00'
```

URL-encode the vehicle ID when necessary. Both `from` and `to` are required
ISO 8601 datetimes with a timezone (`Z` or an explicit UTC offset). The interval is inclusive:
a trip matches when it starts at or before `to` and ends at or after `from`.
Trips in progress have an open-ended interval; trips without a known start time
are excluded. Legacy stored timestamps without a timezone are interpreted as UTC.

The JSON response contains `vehicle`, `from`, `to`, `trips`, and `count`.
`trips` contains the complete stored trip objects, including their waypoints,
in storage order. Unknown vehicles or ranges without matches return an empty
list with `count: 0`. Invalid or missing bounds, or `from` later than `to`,
return HTTP 400; unavailable trip storage returns HTTP 503. Malformed stored
timestamps are logged and the affected trips are skipped.

#### Sidebar results and pagination

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

#### Driver and category filters

Both trip read endpoints accept optional `driver` and `category` query parameters:

- `/api/ovms_trips_recorder/trips?driver=person.alice&category=Work&limit=10`
- `/api/ovms_trips_recorder/vehicles/car/trips?from=2026-10-01T00:00:00Z&to=2026-10-31T23:59:59Z&driver=person.alice&category=Work`

Parameters are single, exact, case-sensitive values; URL-encode names containing
spaces or special characters. Empty values disable a filter. All supplied
filters are combined with AND, and unknown values return no matches. Filtering
is applied before counts and pagination. Trips without assignments do not match
a non-empty driver/category filter. Omitting parameters preserves existing
behavior; the vehicle endpoint retains its required datetime interval.
API filtering works regardless of panel visibility settings. The panel trips
response also includes unfiltered `driver_ids` and `category_names` lists for
history-wide filter choices.

#### Driver assignments

- `GET /api/ovms_trips_recorder/drivers` returns `drivers` (`id`, `name`),
  `defaults` (vehicle ID to person entity ID), `vehicles`, and `enabled`
  (whether the panel shows driver controls), plus `user_driver_id` for the
  authenticated user's linked person entity (or `null` when none is linked).
- `PUT /api/ovms_trips_recorder/drivers/trip/{trip_id}` changes a trip's driver.
  It accepts `{"driver": "person.example"}`.

Invalid people or bodies return 400, unknown targets return 404, and unavailable
storage returns 503. Panel visibility and default drivers are managed only
through the integration's options flow; the former `/drivers/settings/enabled`
and `/drivers/vehicle/{vehicle_id}` write endpoints are no longer available.

#### Category assignments

- `GET /api/ovms_trips_recorder/categories` returns `enabled`,
  `categories` (the available names), and `defaults` (vehicle IDs to category lists).
- `PUT /api/ovms_trips_recorder/categories/trip/{trip_id}` accepts
  `{"categories": ["Work", "Commute"]}` or `{"categories": []}`.

Invalid lists or newly invented categories return 400, unknown trips return 404,
and unavailable storage returns 503. Definitions cannot be changed by this API.

#### Deletion and merging

- `DELETE /api/ovms_trips_recorder/trips/{trip_id}` deletes the matching trip.
  It returns 403 for non-administrators, 404 for an unknown trip, and 503 when
  trip storage is unavailable.
- `GET /api/ovms_trips_recorder/trips/{trip_id}/merge-preview` returns the
  proposed combined trip.
- `POST /api/ovms_trips_recorder/trips/{trip_id}/merge` accepts
  `{"next_trip_id": "..."}` and rechecks that the trips are still mergeable.

Both merge endpoints require an administrator or the assigned driver when driver
controls are enabled. Missing trips return 404, unauthorized users return 403,
invalid or stale merges return 409, and unavailable storage returns 503.
The merged trip retains the first trip's ID; see
[Merge trips](#14-merge-trips) for the combination rules.

### 3.4. Tests

Regression tests cover the sidebar panel and trip recording from OVMS entities.

From the repository root, run:

```sh
python3 -m pip install -r requirements.txt pytest
pytest -q tests/test_trip_store.py tests/test_panel_api.py
npm ci
npm test
```

This executes the Python entity-listener regression tests and the Node.js panel
test suite in the [`tests/`](tests/) directory.

#### End-to-end test

The GitHub Actions workflow also starts Home Assistant, Mosquitto, the parent
OVMS integration, and this integration in Docker. It provisions four OVMS
entries, simulates one trip for each topic structure, and verifies that all four
trips are returned by the panel API. To run this check locally:

```sh
OVMS_PATH=../ovms-home-assistant tests/integration/run.sh
```

## 4. Project information

### 4.1. Credits

Many thanks to [enoch85](https://github.com/enoch85) for the original
[OVMS Home Assistant integration](https://github.com/enoch85/ovms-home-assistant),
which this component extends.

This component was developed with the assistance of [GitHub
Copilot](https://github.com/features/copilot).

### 4.2. License and dependencies

This project is distributed under the [MIT License](LICENSE). Its Python
dependencies retain their respective licenses:

| Dependency | License | Source |
| --- | --- | --- |
| [geopy](https://github.com/geopy/geopy) | MIT | [License](https://github.com/geopy/geopy/blob/master/LICENSE) |
| [geographiclib](https://github.com/geographiclib/geographiclib-python) | MIT | [License](https://github.com/geographiclib/geographiclib-python/blob/main/LICENSE) |
