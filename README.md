# OVMS Home Assistant Trips Recorder

OVMS Home Assistant Trips Recorder is a Home Assistant component for recording trips and displaying them in a sidebar panel.

It uses the OVMS Home Assistant integration to retrieve the vehicle and broker
configuration, then opens a dedicated MQTT connection to record trips. The OVMS
integration is available here:

https://github.com/enoch85/ovms-home-assistant

Component repository:
https://github.com/serotonie/ovms-home-assistant-trips-recorder

## Goals

- rely only on OVMS data already published in Home Assistant
- store trips in Home Assistant local storage
- provide a sidebar panel for viewing a vehicle's trips
- remain compatible with a HACS installation

## Structure

```text
custom_components/
  trips_recorder/
    __init__.py
    const.py
    manifest.json
    panel.py
    trip_store.py
```

## HACS Installation

1. Add this repository as a custom HACS repository.
2. Install "Trips Recorder".
3. Also install the OVMS Home Assistant integration for MQTT management.
4. Add a `trips_recorder:` entry to `configuration.yaml` (this integration has
   no config flow, so it will not load without this key, even after being
   installed through HACS).
5. Restart Home Assistant.
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
Containers** extension:

1. Install the `Dev Containers` extension;
2. open this repository in VS Code;
3. run the `Dev Containers: Reopen in Container` command;
4. wait for the container to finish building.

The `.devcontainer` configuration then automates:

- attaching VS Code to the Docker Compose `dev` service;
- cloning the OVMS integration into `../ovms-home-assistant`;
- installing `mosquitto-clients` and the Python dependencies;
- starting Home Assistant and Mosquitto as adjacent services.

Home Assistant is available at <http://localhost:8123>. Ports `8123` and `1883`
are automatically forwarded by VS Code.

The expected directory structure is:

```text
workspace/
  ovms-home-assistant/
    custom_components/ovms/
  ovms-home-assistant-trips-recorder/
    docker-compose.dev.yml
```

### Starting the Environment

From the repository root:

```sh
git clone https://github.com/enoch85/ovms-home-assistant.git ../ovms-home-assistant
docker compose -f docker-compose.dev.yml up -d
```

This step is performed automatically when the repository is opened in the VS
Code Dev Container.

The Home Assistant instance is then available at <http://localhost:8123>. Create
the administrator user, then add the **OVMS** integration with the following
settings:

> **Note**: the dev [`configuration.yaml`](dev/ha-config/configuration.yaml)
> already includes the `trips_recorder:` entry required to load this
> integration, since it has no config flow.

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

## Tests

Regression tests are provided for the sidebar panel logic in
[`custom_components/trips_recorder/panel.js`](custom_components/trips_recorder/panel.js).

From the repository root, run:

```sh
npm test
```

This executes the Node.js test suite in the [`tests/`](tests/) directory.

## MQTT Dependency

The component automatically retrieves the configuration of the OVMS entries
already installed in Home Assistant and opens a dedicated MQTT connection for
each OVMS broker. It therefore does not assume that the MQTT broker configured
in Home Assistant is the same one used by OVMS.

It uses OVMS topics to:
- detect `vehicle/on` and `vehicle/off` events
- record position, time, odometer, and distance metrics
- store trips at the appropriate time
- expose trip history in the sidebar panel

The broker settings (`host`, `port`, credentials, TLS, and topic prefix) are
read from the OVMS integration configuration. You must therefore install and
configure at least one OVMS entry before using this component.

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
| [paho-mqtt](https://github.com/eclipse-paho/paho.mqtt.python) | EPL-2.0 or BSD-3-Clause | [License](https://github.com/eclipse-paho/paho.mqtt.python/blob/master/LICENSE.txt) |
