"""Tests for the panel API endpoint exposing the integration version."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import types
from pathlib import Path

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
    async def async_get_trips(self):
        return [{"id": 1}]

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
