"""Tests for the panel and vehicle trips API endpoints."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[1]
COMPONENT = ROOT / "custom_components" / "ovms_trips_recorder"


def _install_stubs() -> None:
    """Provide the small aiohttp/Home Assistant surface required by panel.py."""
    aiohttp = types.ModuleType("aiohttp")
    aiohttp.web = types.ModuleType("aiohttp.web")

    class Response:
        def __init__(self, text="", content_type=None) -> None:
            self.text = text
            self.content_type = content_type

    aiohttp.web.Response = Response

    ha_components = types.ModuleType("homeassistant.components")
    ha_http = types.ModuleType("homeassistant.components.http")

    class HomeAssistantView:
        def json(self, data):
            return data

        def json_message(self, message, status_code=200):
            return {"message": message, "status_code": status_code}

    ha_http.HomeAssistantView = HomeAssistantView
    ha_core = types.ModuleType("homeassistant.core")
    ha_core.HomeAssistant = object

    sys.modules.setdefault("homeassistant", types.ModuleType("homeassistant"))
    sys.modules.update(
        {
            "aiohttp": aiohttp,
            "aiohttp.web": aiohttp.web,
            "homeassistant.components": ha_components,
            "homeassistant.components.http": ha_http,
        }
    )
    sys.modules.setdefault("homeassistant.core", ha_core)


_install_stubs()
PACKAGE_NAME = "ovms_trips_recorder_panel_test"
package = types.ModuleType(PACKAGE_NAME)
package.__path__ = [str(COMPONENT)]
sys.modules[PACKAGE_NAME] = package
for name in ("const", "panel"):
    spec = importlib.util.spec_from_file_location(
        f"{PACKAGE_NAME}.{name}", COMPONENT / f"{name}.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
const = sys.modules[f"{PACKAGE_NAME}.const"]
panel = sys.modules[f"{PACKAGE_NAME}.panel"]


class FakeStore:
    def __init__(self, trips=None) -> None:
        self.trips = trips if trips is not None else [{"id": 1}]

    async def async_get_trips(self):
        return self.trips

    async def async_get_vehicle_ids(self):
        return ["car"]


class FakeHass:
    def __init__(self, store) -> None:
        self.data = {const.DOMAIN: {const.DATA_TRIP_STORE: store}} if store else {}


def _manifest_version() -> str:
    return json.loads((COMPONENT / "manifest.json").read_text())["version"]


def test_get_integration_version_reads_manifest() -> None:
    assert panel.get_integration_version() == _manifest_version()


def test_trips_endpoint_returns_version_and_trips() -> None:
    view = panel.TripsRecorderApiView(FakeHass(FakeStore()))
    data = asyncio.run(view.get(None))

    assert data["version"] == _manifest_version()
    assert data["trips"] == [{"id": 1}]
    assert data["vehicles"] == ["car"]
    assert data["count"] == 1


def test_trips_endpoint_returns_version_without_store() -> None:
    view = panel.TripsRecorderApiView(FakeHass(None))
    data = asyncio.run(view.get(None))

    assert data["version"] == _manifest_version()
    assert data["trips"] == []
    assert data["count"] == 0


def _vehicle_request(trips, query=None):
    view = panel.VehicleTripsApiView(FakeHass(FakeStore(trips)))
    request = types.SimpleNamespace(
        query=query if query is not None else {
            "from": "2026-10-16T10:00:00Z",
            "to": "2026-10-16T12:00:00Z",
        }
    )
    return asyncio.run(view.get(request, "car"))


@pytest.mark.parametrize(
    ("start", "stop", "matches"),
    [
        ("09:00", "09:59", False),
        ("09:00", "10:00", True),
        ("09:00", "11:00", True),
        ("09:00", "13:00", True),
        ("10:30", "11:30", True),
        ("11:00", "13:00", True),
        ("12:00", "13:00", True),
        ("12:01", "13:00", False),
        ("09:00", None, True),
        ("12:01", None, False),
        (None, None, False),
    ],
)
def test_vehicle_trips_overlap(start, stop, matches) -> None:
    trip = {
        "vehicle": "car",
        "start_time": f"2026-10-16T{start}:00Z" if start else None,
        "stop_time": f"2026-10-16T{stop}:00Z" if stop else None,
        "waypoints": [{"latitude": 46, "longitude": 6}],
    }
    other_vehicle = {**trip, "vehicle": "other"}

    data = _vehicle_request([trip, other_vehicle])

    assert data == {
        "vehicle": "car",
        "from": "2026-10-16T10:00:00+00:00",
        "to": "2026-10-16T12:00:00+00:00",
        "trips": [trip] if matches else [],
        "count": int(matches),
    }


@pytest.mark.parametrize(
    "query",
    [
        {},
        {"from": "2026-10-16T10:00:00Z"},
        {"to": "2026-10-16T12:00:00Z"},
        {"from": "", "to": "2026-10-16T12:00:00Z"},
        {"from": "invalid", "to": "2026-10-16T12:00:00Z"},
        {"from": "2026-10-16", "to": "2026-10-16T12:00:00Z"},
        {"from": "2026-10-16T10:00:00", "to": "2026-10-16T12:00:00Z"},
        {"from": "2026-10-16T10:00:00Z", "to": "invalid"},
        {"from": "2026-10-16T13:00:00Z", "to": "2026-10-16T12:00:00Z"},
    ],
)
def test_vehicle_trips_reject_invalid_intervals(query) -> None:
    data = _vehicle_request([], query)

    assert data["status_code"] == 400
    assert data["message"]


def test_vehicle_trips_compares_timezones_and_accepts_equal_bounds() -> None:
    trip = {
        "vehicle": "car",
        "start_time": "2026-10-16T12:00:00+02:00",
        "stop_time": "2026-10-16T12:30:00+02:00",
    }
    data = _vehicle_request(
        [trip],
        {"from": "2026-10-16T10:00:00Z", "to": "2026-10-16T06:00:00-04:00"},
    )

    assert data["trips"] == [trip]


def test_vehicle_trips_handles_legacy_utc_timestamps() -> None:
    trip = {
        "vehicle": "car",
        "start_time": "2026-10-16T10:00:00",
        "stop_time": "2026-10-16T11:00:00",
    }

    assert _vehicle_request([trip])["trips"] == [trip]


@pytest.mark.parametrize("field", ["start_time", "stop_time"])
def test_vehicle_trips_logs_invalid_stored_timestamps(field, caplog) -> None:
    trip = {
        "vehicle": "car",
        "start_time": "2026-10-16T10:00:00Z",
        "stop_time": "2026-10-16T11:00:00Z",
        field: "invalid",
    }

    assert _vehicle_request([trip])["trips"] == []
    assert "invalid timestamps" in caplog.text


def test_vehicle_trips_returns_empty_list_for_unknown_vehicle() -> None:
    assert _vehicle_request([])["trips"] == []
    assert _vehicle_request([])["count"] == 0


def test_vehicle_trips_reports_unavailable_storage() -> None:
    view = panel.VehicleTripsApiView(FakeHass(None))
    request = types.SimpleNamespace(
        query={"from": "2026-10-16T10:00:00Z", "to": "2026-10-16T12:00:00Z"}
    )

    assert asyncio.run(view.get(request, "car"))["status_code"] == 503


def test_vehicle_trips_route_is_registered_and_requires_authentication() -> None:
    hass = FakeHass(None)
    views = []
    hass.http = types.SimpleNamespace(register_view=views.append)

    asyncio.run(panel.async_setup_panel(hass))

    view = next(view for view in views if isinstance(view, panel.VehicleTripsApiView))
    assert view.url == "/api/ovms_trips_recorder/vehicles/{vehicle_id}/trips"
    assert view.requires_auth is True
