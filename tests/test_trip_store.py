"""Regression tests for OVMS entity listening in the trip store."""

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
    core.Event = object
    core.callback = lambda func: func
    const = types.ModuleType("homeassistant.const")
    const.EVENT_STATE_CHANGED = "state_changed"

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
            "homeassistant.const": const,
            "homeassistant.core": core,
            "homeassistant.helpers": helpers,
            "homeassistant.helpers.dispatcher": dispatcher,
            "homeassistant.helpers.storage": storage,
        }
    )


_install_home_assistant_stubs()
ROOT = Path(__file__).parents[1]
PACKAGE_NAME = "ovms_trips_recorder_test"
package = types.ModuleType(PACKAGE_NAME)
package.__path__ = [str(ROOT / "custom_components" / "ovms_trips_recorder")]
sys.modules[PACKAGE_NAME] = package
spec = importlib.util.spec_from_file_location(
    f"{PACKAGE_NAME}.trip_store",
    ROOT / "custom_components" / "ovms_trips_recorder" / "trip_store.py",
)
trip_store = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = trip_store
assert spec.loader is not None
spec.loader.exec_module(trip_store)
TripStore = trip_store.TripStore


def test_ovms_entries_map_directly_to_vehicle_ids() -> None:
    """Vehicle lookup uses the parent integration's config entries."""
    entries = [
        types.SimpleNamespace(
            entry_id="entry-1", data={"vehicle_id": "DEMO"}, options={}
        ),
        types.SimpleNamespace(
            entry_id="entry-2", data={}, options={"vehicle_id": "SECOND"}
        ),
    ]
    store = TripStore.__new__(TripStore)
    store._hass = types.SimpleNamespace(
        config_entries=types.SimpleNamespace(async_entries=lambda _domain: entries)
    )

    asyncio.run(store._async_sync_ovms_entries())

    assert store._entry_vehicle_ids == {"entry-1": "DEMO", "entry-2": "SECOND"}
    assert store._allowed_vehicle_ids == {"DEMO", "SECOND"}


def test_configured_vehicles_are_listed_without_received_trips() -> None:
    """The panel filter must show OVMS vehicles before their first trip."""
    store = TripStore.__new__(TripStore)
    store._allowed_vehicle_ids = {"DEMO", "SECOND"}
    store._data = {"trips": [], "active": {}}

    assert asyncio.run(store.async_get_vehicle_ids()) == ["DEMO", "SECOND"]


def test_vehicle_on_and_off_entity_topics_start_and_stop_trips() -> None:
    """Parent OVMS event entities drive trip lifecycle."""
    store = TripStore.__new__(TripStore)
    seen = []

    async def start(vehicle_id: str) -> None:
        seen.append(("start", vehicle_id))

    async def stop(vehicle_id: str) -> None:
        seen.append(("stop", vehicle_id))

    store._async_start_trip = start
    store._async_stop_trip = stop
    asyncio.run(
        store._async_process_ovms_state(
            "DEMO",
            "ovms/demo/car-1/event/vehicle/on",
            types.SimpleNamespace(state="vehicle.on", attributes={}),
        )
    )
    asyncio.run(
        store._async_process_ovms_state(
            "DEMO",
            "ovms/demo/car-1/event/vehicle/off",
            types.SimpleNamespace(state="vehicle.off", attributes={}),
        )
    )

    assert seen == [("start", "DEMO"), ("stop", "DEMO")]


def test_initial_event_state_does_not_start_a_phantom_trip() -> None:
    """Restored event states seed no new trip after restart."""
    store = TripStore.__new__(TripStore)
    started = []

    async def start_trip(vehicle_id: str) -> None:
        started.append(vehicle_id)

    store._async_start_trip = start_trip
    asyncio.run(
        store._async_process_ovms_state(
            "DEMO",
            "ovms/demo/car-1/event/vehicle/on",
            types.SimpleNamespace(state="vehicle.on", attributes={}),
            initial=True,
        )
    )

    assert started == []


def test_metric_entities_pass_topic_and_state_to_trip_store() -> None:
    """The parent entity's topic identifies the metric to record."""
    store = TripStore.__new__(TripStore)
    updates = []

    async def update_metric(vehicle_id: str, metric: str, value: str) -> None:
        updates.append((vehicle_id, metric, value))

    store._async_update_metric = update_metric
    asyncio.run(
        store._async_process_ovms_state(
            "DEMO",
            "ovms/demo/car-1/metric/v/p/latitude",
            types.SimpleNamespace(state="46.644623", attributes={}),
        )
    )

    assert updates == [("DEMO", "v/p/latitude", "46.644623")]


def test_metric_state_on_entity_also_starts_trip() -> None:
    """The parent integration's v/e/on metric remains a lifecycle fallback."""
    store = TripStore.__new__(TripStore)
    started = []

    async def start_trip(vehicle_id: str) -> None:
        started.append(vehicle_id)

    store._async_start_trip = start_trip
    asyncio.run(
        store._async_process_ovms_state(
            "DEMO",
            "ovms/demo/car-1/metric/v/e/on",
            types.SimpleNamespace(state="yes", attributes={}),
        )
    )

    assert started == ["DEMO"]


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
