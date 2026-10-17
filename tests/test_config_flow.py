"""Tests for integration options and migration of the former panel setting."""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest
import voluptuous as vol

COMPONENT = Path(__file__).parents[1] / "custom_components" / "ovms_trips_recorder"
OPTION = "driver_controls_enabled"


@pytest.fixture
def integration(monkeypatch):
    """Load the integration using a minimal, isolated Home Assistant surface."""
    class Flow:
        def __init_subclass__(cls, **kwargs):
            super().__init_subclass__()

        def async_create_entry(self, **kwargs):
            return {"type": "create_entry", **kwargs}

        def async_show_form(self, **kwargs):
            return {"type": "form", **kwargs}

    def module(name, **attrs):
        result = types.ModuleType(name)
        result.__dict__.update(attrs)
        monkeypatch.setitem(sys.modules, name, result)
        return result

    entries = module(
        "homeassistant.config_entries", ConfigFlow=Flow, OptionsFlow=Flow,
        SOURCE_IMPORT="import",
    )
    panel_custom = types.SimpleNamespace(
        async_register_panel=AsyncMock(), async_remove_panel=AsyncMock(),
    )
    module("homeassistant", config_entries=entries)
    module("homeassistant.components", panel_custom=panel_custom)
    module(
        "homeassistant.const", EVENT_HOMEASSISTANT_STARTED="started",
        Platform=types.SimpleNamespace(SENSOR="sensor"),
    )
    module("homeassistant.core", HomeAssistant=object, callback=lambda func: func)

    package_name = "trips_options_test"
    store = types.SimpleNamespace(
        driver_controls_enabled=False, async_load=AsyncMock(),
        async_start=AsyncMock(),
    )

    async def set_enabled(enabled):
        store.driver_controls_enabled = enabled

    store.async_set_driver_controls_enabled = AsyncMock(side_effect=set_enabled)
    module(f"{package_name}.trip_store", TripStore=Mock(return_value=store))
    module(
        f"{package_name}.panel", async_setup_panel=AsyncMock(),
        get_integration_version=lambda: "test",
    )
    spec = importlib.util.spec_from_file_location(
        package_name, COMPONENT / "__init__.py",
        submodule_search_locations=[str(COMPONENT)],
    )
    package = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, package_name, package)
    spec.loader.exec_module(package)
    flow_spec = importlib.util.spec_from_file_location(
        f"{package_name}.config_flow", COMPONENT / "config_flow.py",
    )
    flow = importlib.util.module_from_spec(flow_spec)
    monkeypatch.setitem(sys.modules, flow_spec.name, flow)
    flow_spec.loader.exec_module(flow)

    entry = types.SimpleNamespace(
        options={}, async_on_unload=Mock(), add_update_listener=Mock(return_value="unsub"),
    )

    def update_entry(entry, *, options):
        entry.options = options

    hass = types.SimpleNamespace(
        data={}, is_running=True,
        config_entries=types.SimpleNamespace(
            async_update_entry=Mock(side_effect=update_entry),
            async_forward_entry_setups=AsyncMock(),
        ),
    )
    return package, flow, hass, entry, store


@pytest.mark.parametrize("options,expected", [({}, False), ({OPTION: True}, True), ({OPTION: False}, False)])
def test_options_form_uses_saved_value_and_defaults_to_disabled(integration, options, expected):
    _, flow_module, _, entry, _ = integration
    entry.options = options
    flow = flow_module.TripsRecorderConfigFlow.async_get_options_flow(entry)
    assert isinstance(flow, flow_module.TripsRecorderOptionsFlow)
    flow.config_entry = entry
    result = asyncio.run(flow.async_step_init())
    assert result["type"] == "form"
    assert result["step_id"] == "init"
    assert result["data_schema"]({}) == {OPTION: expected}
    with pytest.raises(vol.Invalid):
        result["data_schema"]({OPTION: "false"})


@pytest.mark.parametrize("enabled", [True, False])
def test_options_submit_preserves_other_options(integration, enabled):
    _, flow_module, _, entry, _ = integration
    entry.options = {"other": "preserved"}
    flow = flow_module.TripsRecorderOptionsFlow()
    flow.config_entry = entry
    result = asyncio.run(flow.async_step_init({OPTION: enabled}))
    assert result == {
        "type": "create_entry", "title": "",
        "data": {"other": "preserved", OPTION: enabled},
    }


@pytest.mark.parametrize("legacy", [True, False])
def test_setup_migrates_panel_setting_and_registers_options_listener(integration, legacy):
    package, _, hass, entry, store = integration
    store.driver_controls_enabled = legacy
    entry.options = {"other": "preserved"}
    assert asyncio.run(package.async_setup_entry(hass, entry)) is True
    assert entry.options == {"other": "preserved", OPTION: legacy}
    assert store.driver_controls_enabled is legacy
    entry.add_update_listener.assert_called_once_with(package._async_update_options)
    entry.async_on_unload.assert_called_once_with("unsub")


@pytest.mark.parametrize("enabled", [True, False])
def test_options_override_legacy_setting_and_apply_live(integration, enabled):
    package, _, hass, entry, store = integration
    entry.options = {OPTION: enabled}
    store.driver_controls_enabled = not enabled
    asyncio.run(package.async_setup_entry(hass, entry))
    hass.config_entries.async_update_entry.assert_not_called()
    store.async_set_driver_controls_enabled.assert_awaited_once_with(enabled)
    entry.options = {OPTION: not enabled}
    asyncio.run(package._async_update_options(hass, entry))
    assert store.driver_controls_enabled is not enabled
    assert store.async_set_driver_controls_enabled.await_count == 2
    asyncio.run(package._async_update_options(hass, entry))
    assert store.async_set_driver_controls_enabled.await_count == 2


def test_yaml_import_remains_on_config_flow(integration):
    _, flow_module, _, _, _ = integration
    flow = flow_module.TripsRecorderConfigFlow()
    flow._async_current_entries = lambda: []
    assert asyncio.run(flow.async_step_import())["type"] == "create_entry"
