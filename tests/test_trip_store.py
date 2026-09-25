"""Regression tests for OVMS MQTT discovery in the trip store."""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import types
from pathlib import Path


def _install_home_assistant_stubs() -> None:
    """Provide the small Home Assistant surface required to import TripStore."""
    homeassistant = types.ModuleType("homeassistant")
    config_entries = types.ModuleType("homeassistant.config_entries")
    config_entries.ConfigEntry = object
    config_entries.ConfigEntryChange = object
    config_entries.SIGNAL_CONFIG_ENTRY_CHANGED = "config_entry_changed"

    core = types.ModuleType("homeassistant.core")
    core.HomeAssistant = object

    dispatcher = types.ModuleType("homeassistant.helpers.dispatcher")
    dispatcher.async_dispatcher_connect = lambda *args: None

    storage = types.ModuleType("homeassistant.helpers.storage")

    class Store:
        def __init__(self, *args) -> None:
            pass

    storage.Store = Store
    helpers = types.ModuleType("homeassistant.helpers")

    sys.modules.update(
        {
            "homeassistant": homeassistant,
            "homeassistant.config_entries": config_entries,
            "homeassistant.core": core,
            "homeassistant.helpers": helpers,
            "homeassistant.helpers.dispatcher": dispatcher,
            "homeassistant.helpers.storage": storage,
        }
    )


_install_home_assistant_stubs()
ROOT = Path(__file__).parents[1]
PACKAGE_NAME = "trips_recorder_test"
package = types.ModuleType(PACKAGE_NAME)
package.__path__ = [str(ROOT / "custom_components" / "trips_recorder")]
sys.modules[PACKAGE_NAME] = package
spec = importlib.util.spec_from_file_location(
    f"{PACKAGE_NAME}.trip_store",
    ROOT / "custom_components" / "trips_recorder" / "trip_store.py",
)
trip_store = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = trip_store
assert spec.loader is not None
spec.loader.exec_module(trip_store)
TripStore = trip_store.TripStore


def test_mqtt_topic_filter_supports_all_ovms_topic_structures() -> None:
    """Every topic structure accepted by OVMS must be subscribed to here."""
    base_config = {
        "topic_prefix": "ovms",
        "mqtt_username": "driver",
        "vehicle_id": "DEMO",
    }

    expected_topics = {
        "{prefix}/{mqtt_username}/{vehicle_id}": "ovms/driver/DEMO/#",
        "{prefix}/client/{vehicle_id}": "ovms/client/DEMO/#",
        "{prefix}/{vehicle_id}": "ovms/DEMO/#",
        "garage/{vehicle_id}/telemetry": "garage/DEMO/telemetry/#",
    }

    for topic_structure, expected_topic in expected_topics.items():
        config = {**base_config, "topic_structure": topic_structure}
        assert TripStore._mqtt_topic_filter(config) == expected_topic


def test_mqtt_config_signature_changes_with_topic_structure() -> None:
    """Changing the OVMS topic layout must reconnect the MQTT subscriber."""
    config = {
        "host": "broker.example.test",
        "port": 1883,
        "vehicle_id": "DEMO",
        "topic_structure": "{prefix}/{vehicle_id}",
    }
    changed_config = {
        **config,
        "topic_structure": "{prefix}/client/{vehicle_id}",
    }

    assert TripStore._mqtt_config_signature(config) != TripStore._mqtt_config_signature(
        changed_config
    )


def test_configured_vehicles_are_listed_without_received_trips() -> None:
    """The panel filter must show OVMS vehicles before their first trip."""
    store = TripStore.__new__(TripStore)
    store._allowed_vehicle_ids = {"DEMO", "SECOND"}
    store._data = {"trips": [], "active": {}}

    assert asyncio.run(store.async_get_vehicle_ids()) == ["DEMO", "SECOND"]


def test_configured_vehicles_are_listed_when_mqtt_connection_fails() -> None:
    """A broker failure must not hide configured vehicles from the panel."""
    entry = types.SimpleNamespace(
        entry_id="entry-1",
        data={"vehicle_id": "DEMO", "host": "broker", "port": 1883},
        options={},
    )
    store = TripStore.__new__(TripStore)
    store._hass = types.SimpleNamespace(
        data={"ovms": {}},
        config_entries=types.SimpleNamespace(
            async_entries=lambda domain: [entry]),
    )
    store._mqtt_clients = {}
    store._entry_signatures = {}
    store._allowed_vehicle_ids = set()

    async def fail_to_start(*args) -> None:
        raise OSError("broker unavailable")

    store._async_start_mqtt_client = fail_to_start

    asyncio.run(store._async_sync_ovms_entries())

    assert store._allowed_vehicle_ids == {"DEMO"}


def test_custom_topic_uses_the_configured_vehicle_id() -> None:
    """A custom suffix after the vehicle ID must not change the trip vehicle."""
    store = TripStore.__new__(TripStore)
    store._allowed_vehicle_ids = {"DEMO"}
    started_vehicle_ids: list[str] = []

    async def start_trip(vehicle_id: str) -> None:
        started_vehicle_ids.append(vehicle_id)

    store._async_start_trip = start_trip
    message = types.SimpleNamespace(
        topic="garage/DEMO/telemetry/event/vehicle/on",
        payload=b"vehicle.on",
    )

    asyncio.run(store._async_mqtt_message(message, vehicle_id="DEMO"))

    assert started_vehicle_ids == ["DEMO"]


def test_concurrent_stop_events_save_a_trip_only_once() -> None:
    """Repeated stop events during geocoding must not duplicate a trip."""
    store = TripStore.__new__(TripStore)
    trip = {"vehicle": "DEMO", "waypoints": []}
    store._vehicles = {
        "DEMO": {
            "trip": trip,
            "timestamp": "2026-09-25T11:37:29+00:00",
            "latitude": 46.644623,
            "longitude": 6.404009,
            "distance": 0.576,
        }
    }
    store._data = {"trips": [], "active": {"DEMO": trip}}
    store._stopping_vehicle_ids = set()
    store._timeout_tasks = {}
    store._geocode_trip_calls = 0

    async def geocode_trip(_trip) -> None:
        store._geocode_trip_calls += 1
        await asyncio.sleep(0)

    async def save() -> None:
        await asyncio.sleep(0)

    store._async_geocode_trip = geocode_trip
    store.async_save = save
    store._cancel_timeout = lambda _vehicle_id: None

    async def stop_twice() -> None:
        await asyncio.gather(
            store._async_stop_trip("DEMO"),
            store._async_stop_trip("DEMO"),
        )

    asyncio.run(stop_twice())

    assert store._geocode_trip_calls == 1
    assert store._data["trips"] == [trip]
