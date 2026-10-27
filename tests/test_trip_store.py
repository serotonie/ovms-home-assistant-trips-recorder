"""Regression tests for OVMS entity listening in the trip store."""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import types
from pathlib import Path

import pytest


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


def test_save_notifies_without_broadcasting_all_trips() -> None:
    store = TripStore.__new__(TripStore)
    store._data = {"trips": [{"waypoints": [1, 2, 3]}], "active": {}}
    saved = []
    events = []

    async def save(data):
        saved.append(data)

    store._store = types.SimpleNamespace(async_save=save)
    store._hass = types.SimpleNamespace(
        bus=types.SimpleNamespace(async_fire=lambda *args: events.append(args))
    )
    asyncio.run(store.async_save())
    assert saved == [store._data]
    assert events == [(trip_store.TRIP_UPDATED_EVENT,)]


def test_failed_nominatim_request_still_obeys_rate_limit(monkeypatch) -> None:
    class FailingGeocoder:
        def __init__(self, *, user_agent):
            assert user_agent == "ovms-trips-recorder"

        def reverse(self, *_args, **_kwargs):
            raise RuntimeError("service unavailable")

    async def run_in_executor(job):
        return job()

    monkeypatch.setattr(trip_store, "Nominatim", FailingGeocoder)
    monkeypatch.setattr(trip_store.time, "monotonic", lambda: 100.0)
    store = TripStore.__new__(TripStore)
    store._geocode_cache = {}
    store._geocode_lock = asyncio.Lock()
    store._last_geocode_at = 0.0
    store._hass = types.SimpleNamespace(async_add_executor_job=run_in_executor)

    assert asyncio.run(store._async_geocode(46.5, 6.5)) == {}
    assert store._last_geocode_at == 100.0


def test_delete_trip_removes_completed_and_active_trips_and_persists() -> None:
    completed = {"id": "completed"}
    active = {"id": "active"}
    store = TripStore.__new__(TripStore)
    store._data = {"trips": [completed], "active": {"car": active}}
    store._vehicles = {"car": {"trip": active}}
    store._timeout_tasks = {}
    saves = []
    cancelled = []

    async def save() -> None:
        saves.append(True)

    store.async_save = save
    store._cancel_timeout = cancelled.append

    async def delete_trips() -> None:
        await store.async_delete_trip("completed")
        await store.async_delete_trip("active")

    asyncio.run(delete_trips())

    assert store._data == {"trips": [], "active": {}}
    assert store._vehicles["car"]["trip"] is None
    assert cancelled == ["car"]
    assert len(saves) == 2


def test_merge_trip_preview_and_merge_preserve_route_and_remove_following_trip() -> None:
    first = {
        "id": "first", "vehicle": "car", "start_time": "2026-01-01T10:00:00Z",
        "stop_time": "2026-01-01T11:00:00Z", "distance": 10,
        "waypoints": [{"timestamp": "10:00"}], "categories": ["Work"],
        "stop_road": "First street",
    }
    following = {
        "id": "following", "vehicle": "car", "start_time": "2026-01-01T12:00:00Z",
        "stop_time": "2026-01-01T13:00:00Z", "distance": 5,
        "waypoints": [{"timestamp": "12:00"}], "categories": ["Personal"],
        "driver": "person.alice", "stop_road": "Second street",
    }
    other_vehicle = {
        "id": "other", "vehicle": "van", "start_time": "2026-01-01T11:30:00Z",
        "stop_time": "2026-01-01T11:45:00Z",
    }
    store = TripStore.__new__(TripStore)
    store._data = {"trips": [first, other_vehicle, following], "active": {}}
    saves = []

    async def save():
        saves.append(True)

    store.async_save = save

    async def merge():
        assert await store.async_get_trip_merge_candidates() == {"first": "following"}
        preview = await store.async_get_trip_merge_preview("first")
        assert preview["trip"]["distance"] == 15
        assert preview["trip"]["stop_road"] == "Second street"
        assert preview["trip"]["waypoints"] == [
            {"timestamp": "10:00"}, {"timestamp": "12:00"},
        ]
        assert preview["trip"]["categories"] == ["Work", "Personal"]
        assert preview["trip"]["driver"] == "person.alice"
        result = await store.async_merge_trips("first", "following")
        assert result["trip"]["stop_time"] == "2026-01-01T13:00:00Z"

    asyncio.run(merge())
    assert [trip["id"] for trip in store._data["trips"]] == ["first", "other"]
    assert first["distance"] == 15
    assert len(saves) == 1


@pytest.mark.parametrize("following_start", [
    "2026-01-01T10:30:00Z",
    "invalid",
])
def test_merge_preview_rejects_overlapping_or_invalid_next_trip(following_start) -> None:
    store = TripStore.__new__(TripStore)
    store._data = {"trips": [
        {"id": "first", "vehicle": "car", "start_time": "2026-01-01T10:00:00Z",
         "stop_time": "2026-01-01T11:00:00Z"},
        {"id": "following", "vehicle": "car", "start_time": following_start,
         "stop_time": "2026-01-01T12:00:00Z"},
    ]}
    with pytest.raises(ValueError):
        asyncio.run(store.async_get_trip_merge_preview("first"))


def test_merge_rejects_stale_next_trip_and_missing_trip() -> None:
    store = TripStore.__new__(TripStore)
    store._data = {"trips": [
        {"id": "first", "vehicle": "car", "start_time": "2026-01-01T10:00:00Z",
         "stop_time": "2026-01-01T11:00:00Z"},
        {"id": "following", "vehicle": "car", "start_time": "2026-01-01T12:00:00Z",
         "stop_time": "2026-01-01T13:00:00Z"},
    ]}
    with pytest.raises(ValueError):
        asyncio.run(store.async_merge_trips("first", "different"))
    with pytest.raises(KeyError):
        asyncio.run(store.async_get_trip_merge_preview("missing"))
    assert len(store._data["trips"]) == 2


def test_only_linked_trip_driver_can_merge_when_driver_controls_are_enabled() -> None:
    alice = types.SimpleNamespace(
        entity_id="person.alice", attributes={"user_id": "user-alice"}
    )
    bob = types.SimpleNamespace(
        entity_id="person.bob", attributes={"user_id": "user-bob"}
    )
    store = TripStore.__new__(TripStore)
    store._hass = types.SimpleNamespace(
        states=types.SimpleNamespace(async_all=lambda domain: [alice, bob])
    )
    store._data = {
        "driver_controls_enabled": True,
        "trips": [{"id": "trip-1", "driver": "person.alice"}],
    }

    assert store.get_driver_id_for_user("user-alice") == "person.alice"
    assert store.get_driver_id_for_user("unknown") is None
    assert asyncio.run(store.async_user_owns_trip("trip-1", "user-alice"))
    assert not asyncio.run(store.async_user_owns_trip("trip-1", "user-bob"))
    store._data["driver_controls_enabled"] = False
    assert not asyncio.run(store.async_user_owns_trip("trip-1", "user-alice"))


def test_delete_trip_during_stop_does_not_restore_deleted_trip() -> None:
    trip = {"id": "active", "waypoints": []}
    state = {
        "trip": trip,
        "timestamp": "2026-09-25T11:37:29+00:00",
        "latitude": 46.6,
        "longitude": 6.4,
        "distance": 1,
    }
    store = TripStore.__new__(TripStore)
    store._vehicles = {"car": state}
    store._data = {"trips": [], "active": {"car": trip}}
    store._stopping_vehicle_ids = set()
    store._timeout_tasks = {}
    geocoding = asyncio.Event()
    continue_geocoding = asyncio.Event()

    async def geocode_trip(_trip) -> None:
        geocoding.set()
        await continue_geocoding.wait()

    async def save() -> None:
        pass

    store._async_geocode_trip = geocode_trip
    store.async_save = save
    store._cancel_timeout = lambda _vehicle_id: None

    async def stop_and_delete() -> None:
        stopping = asyncio.create_task(store._async_stop_trip("car"))
        await geocoding.wait()
        await store.async_delete_trip("active")
        continue_geocoding.set()
        await stopping

    asyncio.run(stop_and_delete())

    assert store._data == {"trips": [], "active": {}}
    assert state["trip"] is None


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


def test_waypoint_waits_for_updated_coordinates_timestamp_and_distance() -> None:
    """A waypoint uses four metrics updated since the previous waypoint."""
    store = TripStore.__new__(TripStore)
    trip = {
        "vehicle": "DEMO",
        "start_time": None,
        "start_point_lat": -1,
        "start_point_long": -1,
        "waypoints": [],
    }
    store._vehicles = {
        "DEMO": {
            "trip": trip,
            "latitude": 46.0,
            "longitude": 6.0,
            "gpshdop": -1,
            "odometer": -1,
            "distance": 0,
            "timestamp": None,
            "updated_metrics": set(),
        }
    }
    store._data = {"trips": [], "active": {"DEMO": trip}}

    async def save() -> None:
        pass

    store.async_save = save
    store._schedule_timeout = lambda _vehicle_id: None

    async def update_metrics() -> None:
        await store._async_update_metric("DEMO", "v/p/latitude", "46.1")
        assert trip["waypoints"] == []
        await store._async_update_metric(
            "DEMO", "v/p/utc", "2026-10-16T12:00:00+00:00"
        )
        await store._async_update_metric("DEMO", "v/p/distance", "1.5")
        assert trip["waypoints"] == []
        await store._async_update_metric("DEMO", "v/p/longitude", "6.1")
        assert trip["waypoints"][-1]["position_lat"] == 46.1
        assert trip["waypoints"][-1]["position_long"] == 6.1
        assert trip["waypoints"][-1]["timestamp"] == "2026-10-16T12:00:00+00:00"
        assert trip["waypoints"][-1]["distance"] == 1.5

        await store._async_update_metric("DEMO", "v/p/longitude", "6.2")
        await store._async_update_metric("DEMO", "v/p/distance", "2.5")
        await store._async_update_metric(
            "DEMO", "v/p/utc", "2026-10-16T12:01:00+00:00"
        )
        assert len(trip["waypoints"]) == 1
        await store._async_update_metric("DEMO", "v/p/latitude", "46.2")
        assert len(trip["waypoints"]) == 2
        assert trip["waypoints"][-1]["position_lat"] == 46.2
        assert trip["waypoints"][-1]["position_long"] == 6.2
        assert trip["waypoints"][-1]["timestamp"] == "2026-10-16T12:01:00+00:00"
        assert trip["waypoints"][-1]["distance"] == 2.5

    asyncio.run(update_metrics())


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


def driver_store(data=None):
    """Create a real store with in-memory persistence and person states."""
    saved = []
    people = [
        types.SimpleNamespace(entity_id="person.alice", name="Alice"),
        types.SimpleNamespace(entity_id="person.bob", name="Bob"),
    ]
    hass = types.SimpleNamespace(
        states=types.SimpleNamespace(async_all=lambda domain: people if domain == "person" else []),
        bus=types.SimpleNamespace(async_fire=lambda *args: None),
    )
    store = TripStore(hass)
    store._allowed_vehicle_ids = {"car", "other"}
    store._schedule_timeout = lambda vehicle: None

    async def load():
        return data

    async def save(value):
        import copy

        saved.append(copy.deepcopy(value))

    store._store = types.SimpleNamespace(async_load=load, async_save=save)
    return store, saved, people


def test_migration_assigns_stable_ids_and_preserves_drivers_and_waypoints() -> None:
    legacy = {"vehicle": "car", "waypoints": [{"position_lat": 46}]}
    assigned = {"vehicle": "car", "id": "existing", "driver": "person.bob"}
    active = {"vehicle": "other", "waypoints": []}
    data = {
        "trips": [legacy, assigned], "active": {"other": active},
        "driver_defaults": {"car": "person.alice", "other": "person.bob"},
    }
    store, saved, _ = driver_store(data)

    asyncio.run(store.async_load())
    assert legacy["driver"] == "person.alice"
    assert active["driver"] == "person.bob"
    assert store._vehicles["other"]["trip"] is active
    assert assigned["driver"] == "person.bob"
    assert assigned["id"] == "existing"
    assert legacy["waypoints"] == [{"position_lat": 46}]
    assert len({legacy["id"], active["id"], assigned["id"]}) == 3

    restored, _, _ = driver_store(saved[-1])
    asyncio.run(restored.async_load())
    assert [trip["id"] for trip in asyncio.run(restored.async_get_trips())] == [
        legacy["id"], "existing", active["id"],
    ]


def test_defaults_backfill_only_matching_unassigned_trips() -> None:
    store, saved, _ = driver_store()
    store._data = {
        "trips": [
            {"vehicle": "car", "driver": None},
            {"vehicle": "car", "driver": "person.bob"},
            {"vehicle": "other", "driver": None},
        ],
        "active": {"car": {"vehicle": "car"}},
    }
    asyncio.run(store.async_set_driver_default("car", "person.alice"))
    assert store.get_driver_defaults() == {"car": "person.alice"}
    assert [trip.get("driver") for trip in asyncio.run(store.async_get_trips())] == [
        "person.alice", "person.bob", None, "person.alice",
    ]
    asyncio.run(store.async_set_driver_default("car", "person.bob"))
    assert store._data["trips"][0]["driver"] == "person.alice"
    assert saved[-1]["driver_defaults"] == {"car": "person.bob"}


def test_new_trip_uses_vehicle_default_and_keeps_edited_driver_at_stop() -> None:
    store, saved, _ = driver_store()
    store._data = {"trips": [], "active": {}, "driver_defaults": {"car": "person.alice"}}

    async def geocode(trip):
        pass

    store._async_geocode_trip = geocode

    async def record():
        await store._async_start_trip("car")
        trip = store._data["active"]["car"]
        assert trip["driver"] == "person.alice"
        trip_id = trip["id"]
        await store.async_set_trip_driver(trip_id, "person.bob")
        await store._async_stop_trip("car")
        assert store._data["trips"][0]["id"] == trip_id
        assert store._data["trips"][0]["driver"] == "person.bob"
        await store.async_set_trip_driver(trip_id, "person.alice")

    asyncio.run(record())
    assert saved[-1]["trips"][0]["driver"] == "person.alice"


def test_missing_or_deleted_defaults_record_with_explicit_warning(caplog) -> None:
    for defaults in ({}, {"car": "person.deleted"}):
        store, _, _ = driver_store()
        store._data = {
            "trips": [], "active": {}, "driver_defaults": defaults,
            "driver_controls_enabled": True,
        }
        asyncio.run(store._async_start_trip("car"))
        assert store._data["active"]["car"]["driver"] is None
        assert store._data["active"]["car"]["id"]
    assert "No valid default driver configured for vehicle car" in caplog.text


def test_invalid_driver_or_unknown_target_does_not_change_storage() -> None:
    import pytest

    store, saved, _ = driver_store()
    with pytest.raises(ValueError):
        asyncio.run(store.async_set_driver_default("car", "sensor.alice"))
    with pytest.raises(KeyError):
        asyncio.run(store.async_set_driver_default("missing", "person.alice"))
    with pytest.raises(KeyError):
        asyncio.run(store.async_set_trip_driver("missing", "person.alice"))
    assert saved == []


def test_added_trips_use_defaults_and_clear_preserves_defaults() -> None:
    store, saved, people = driver_store()
    asyncio.run(store.async_set_driver_default("car", "person.alice"))
    trip = {"vehicle": "car"}
    asyncio.run(store.async_add_trip(trip))
    assert trip["driver"] == "person.alice"
    assert trip["id"]
    people[0].name = "Alice renamed"
    assert store.get_drivers()[0]["name"] == "Alice renamed"
    asyncio.run(store.async_clear())
    assert asyncio.run(store.async_get_trips()) == []
    assert saved[-1]["driver_defaults"] == {"car": "person.alice"}


def test_driver_visibility_is_opt_in_persistent_and_does_not_stop_assignment() -> None:
    store, saved, _ = driver_store()
    assert store.driver_controls_enabled is False
    asyncio.run(store.async_set_driver_default("car", "person.alice"))
    asyncio.run(store.async_set_driver_controls_enabled(True))
    assert store.driver_controls_enabled is True
    asyncio.run(store.async_set_driver_controls_enabled(False))
    asyncio.run(store._async_start_trip("car"))
    assert store._data["active"]["car"]["driver"] == "person.alice"
    restored, _, _ = driver_store(saved[-1])
    asyncio.run(restored.async_load())
    assert restored.driver_controls_enabled is False
    assert restored._data["active"]["car"]["driver"] == "person.alice"
    asyncio.run(restored.async_set_driver_controls_enabled(True))
    asyncio.run(restored.async_clear())
    assert restored.driver_controls_enabled is True
    assert restored.get_driver_defaults() == {"car": "person.alice"}


def test_bulk_defaults_backfill_without_overwriting_and_support_removal() -> None:
    store, saved, _ = driver_store()
    store._data = {
        "trips": [
            {"vehicle": "car", "driver": None},
            {"vehicle": "car", "driver": "person.bob"},
            {"vehicle": "other", "driver": None},
        ],
        "active": {"other": {"vehicle": "other", "driver": None}},
    }
    asyncio.run(store.async_set_driver_defaults({"car": "person.alice", "other": "person.bob"}))
    assert [trip["driver"] for trip in asyncio.run(store.async_get_trips())] == [
        "person.alice", "person.bob", "person.bob", "person.bob",
    ]
    asyncio.run(store.async_set_driver_defaults({}))
    assert store.get_driver_defaults() == {}
    assert store._data["trips"][0]["driver"] == "person.alice"
    assert saved[-1]["driver_defaults"] == {}
    assert store.driver_controls_enabled is False


def test_bulk_defaults_preserve_deleted_people_and_validate_before_mutating() -> None:
    import pytest

    store, saved, _ = driver_store()
    store._data["driver_defaults"] = {"car": "person.deleted"}
    asyncio.run(store.async_set_driver_defaults({"car": "person.deleted"}))
    assert store.get_driver_defaults() == {"car": "person.deleted"}
    with pytest.raises(ValueError):
        asyncio.run(store.async_set_driver_defaults({"car": "person.alice", "other": "sensor.invalid"}))
    assert store.get_driver_defaults() == {"car": "person.deleted"}
    assert len(saved) == 1


def test_category_defaults_backfill_migrate_and_persist_without_changing_assigned_trips() -> None:
    data = {
        "trips": [{"vehicle": "car"}, {"vehicle": "car", "categories": ["Personal"]}],
        "active": {"other": {"vehicle": "other", "waypoints": []}},
    }
    store, saved, _ = driver_store(data)
    asyncio.run(store.async_load())
    assert store._data["trips"][0]["categories"] == []
    assert store.get_category_settings() == {"enabled": False, "categories": [], "defaults": {}}
    asyncio.run(store.async_set_category_settings(
        False, ["Work", "Personal"], {"car": ["Work"], "other": ["Work", "Personal"]},
    ))
    trips = asyncio.run(store.async_get_trips())
    assert [trip["categories"] for trip in trips] == [["Work"], ["Personal"], ["Work", "Personal"]]
    asyncio.run(store._async_start_trip("car"))
    assert store._data["active"]["car"]["categories"] == ["Work"]
    restored, _, _ = driver_store(saved[-1])
    asyncio.run(restored.async_load())
    assert restored.get_category_settings() == store.get_category_settings()
    assert [trip["categories"] for trip in asyncio.run(restored.async_get_trips())] == [
        ["Work"], ["Personal"], ["Work", "Personal"], ["Work"],
    ]
    settings = restored.get_category_settings()
    settings["categories"].clear()
    settings["defaults"]["car"].clear()
    assert restored.get_category_settings()["defaults"]["car"] == ["Work"]
    asyncio.run(restored.async_clear())
    assert restored.get_category_settings() == store.get_category_settings()


def test_category_editing_retired_categories_and_clear_survive_restart() -> None:
    import pytest

    store, saved, _ = driver_store()
    asyncio.run(store.async_set_category_settings(True, ["Work", "Personal"], {"car": ["Work"]}))
    trip = asyncio.run(store.async_add_trip({"vehicle": "car"}))
    second = asyncio.run(store.async_add_trip({"vehicle": "other"}))
    asyncio.run(store.async_set_trip_categories(trip["id"], ["Work", "Personal"]))
    asyncio.run(store.async_set_category_settings(True, ["Personal"], {}))
    assert trip["categories"] == ["Work", "Personal"]
    asyncio.run(store.async_set_trip_categories(trip["id"], ["Work"]))
    with pytest.raises(ValueError):
        asyncio.run(store.async_set_trip_categories(second["id"], ["Work"]))
    asyncio.run(store.async_set_trip_categories(trip["id"], []))
    with pytest.raises(ValueError):
        asyncio.run(store.async_set_trip_categories(trip["id"], ["Work"]))
    restored, _, _ = driver_store(saved[-1])
    asyncio.run(restored.async_load())
    assert restored._data["trips"][0]["categories"] == []
    with pytest.raises(KeyError):
        asyncio.run(store.async_set_trip_categories("missing", ["Personal"]))


def test_category_updates_preserve_active_trip_categories_when_it_finishes() -> None:
    store, _, _ = driver_store()
    asyncio.run(store.async_set_category_settings(True, ["Work", "Personal"], {}))

    async def geocode(trip):
        pass

    store._async_geocode_trip = geocode
    asyncio.run(store._async_start_trip("car"))
    trip = store._data["active"]["car"]
    asyncio.run(store.async_set_trip_categories(trip["id"], ["Work", "Personal"]))
    asyncio.run(store._async_stop_trip("car"))
    assert store._data["trips"][0]["categories"] == ["Work", "Personal"]


def test_category_validation_rejects_invalid_definitions_assignments_and_defaults_atomically() -> None:
    import pytest

    store, saved, _ = driver_store()
    trip = asyncio.run(store.async_add_trip({"vehicle": "car"}))
    asyncio.run(store.async_set_category_settings(False, ["Work"], {}))
    before = len(saved)
    for invalid in (None, "Work", {}, [1], [None], [""], [" Work"], ["Work "], ["Work", "Work"]):
        with pytest.raises(ValueError):
            asyncio.run(store.async_set_trip_categories(trip["id"], invalid))
        with pytest.raises(ValueError):
            asyncio.run(store.async_set_category_settings(False, invalid, {}))
    with pytest.raises(ValueError):
        asyncio.run(store.async_set_category_settings(False, ["Personal"], {"car": ["Work"]}))
    assert len(saved) == before
    assert store.get_category_settings()["categories"] == ["Work"]
    assert trip["categories"] == []
