"""Tests for integration options and migration of the former panel setting."""

from __future__ import annotations

import asyncio
import importlib.util
import json
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
    class EntitySelector:
        def __init__(self, config):
            self.config = config

        def __call__(self, value):
            if not isinstance(value, str) or not value.startswith("person."):
                raise vol.Invalid("Expected person entity")
            return value

    class ObjectSelector:
        def __init__(self, config):
            self.config = config

        def __call__(self, value):
            return vol.Schema({
                vol.Optional(key): field["selector"]
                for key, field in self.config["fields"].items()
            })(value)

    class TextSelector:
        def __init__(self, config):
            self.config = config

        def __call__(self, value):
            return vol.Schema([str])(value)

    class SelectSelector(TextSelector):
        def __call__(self, value):
            return vol.Schema([vol.In(self.config["options"])])(value)

    module("homeassistant.helpers", __path__=[])
    module(
        "homeassistant.helpers.selector",
        EntitySelector=EntitySelector, ObjectSelector=ObjectSelector,
        TextSelector=TextSelector, SelectSelector=SelectSelector,
    )

    package_name = "trips_options_test"
    store = types.SimpleNamespace(
        driver_controls_enabled=False, async_load=AsyncMock(),
        async_start=AsyncMock(),
        get_driver_defaults=Mock(return_value={}),
        async_get_vehicle_ids=AsyncMock(return_value=[]),
        get_drivers=Mock(return_value=[
            {"id": "person.alice", "name": "Alice"},
            {"id": "person.bob", "name": "Bob"},
        ]),
        get_category_settings=Mock(return_value={"enabled": False, "categories": [], "defaults": {}}),
    )

    async def set_enabled(enabled):
        store.driver_controls_enabled = enabled

    store.async_set_driver_controls_enabled = AsyncMock(side_effect=set_enabled)
    async def set_defaults(defaults):
        store.get_driver_defaults.return_value = defaults

    store.async_set_driver_defaults = AsyncMock(side_effect=set_defaults)
    def validate_categories(categories):
        if (
            not isinstance(categories, list)
            or any(not isinstance(item, str) or not item.strip() or item != item.strip() for item in categories)
            or len(set(categories)) != len(categories)
        ):
            raise ValueError

    store.validate_categories = validate_categories

    async def set_categories(enabled, categories, defaults):
        store.get_category_settings.return_value = {
            "enabled": enabled, "categories": categories, "defaults": defaults,
        }

    store.async_set_category_settings = AsyncMock(side_effect=set_categories)
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
    hass.data = {package.DOMAIN: {package.DATA_TRIP_STORE: store}}
    return package, flow, hass, entry, store


@pytest.mark.parametrize("options,expected", [({}, False), ({OPTION: True}, True), ({OPTION: False}, False)])
def test_options_form_uses_saved_value_and_defaults_to_disabled(integration, options, expected):
    _, flow_module, hass, entry, _ = integration
    entry.options = options
    flow = flow_module.TripsRecorderConfigFlow.async_get_options_flow(entry)
    assert isinstance(flow, flow_module.TripsRecorderOptionsFlow)
    flow.config_entry = entry
    flow.hass = hass
    result = asyncio.run(flow.async_step_init())
    assert result["type"] == "form"
    assert result["step_id"] == "init"
    assert result["data_schema"]({}) == {OPTION: expected, "category_controls_enabled": False}
    with pytest.raises(vol.Invalid):
        result["data_schema"]({OPTION: "false"})


@pytest.mark.parametrize("enabled", [True, False])
def test_options_submit_preserves_other_options(integration, enabled):
    _, flow_module, hass, entry, _ = integration
    entry.options = {"other": "preserved"}
    flow = flow_module.TripsRecorderOptionsFlow()
    flow.config_entry = entry
    flow.hass = hass
    result = asyncio.run(flow.async_step_init({OPTION: enabled}))
    assert result == {
        "type": "create_entry", "title": "",
        "data": {
            "other": "preserved", OPTION: enabled, "driver_defaults": {},
            "category_controls_enabled": False, "categories": [], "category_defaults": {},
        },
    }


@pytest.mark.parametrize("legacy", [True, False])
def test_setup_migrates_panel_setting_and_registers_options_listener(integration, legacy):
    package, _, hass, entry, store = integration
    hass.data = {}
    store.driver_controls_enabled = legacy
    entry.options = {"other": "preserved"}
    assert asyncio.run(package.async_setup_entry(hass, entry)) is True
    assert entry.options == {"other": "preserved", OPTION: legacy, "driver_defaults": {}}
    assert store.driver_controls_enabled is legacy
    entry.add_update_listener.assert_called_once_with(package._async_update_options)
    entry.async_on_unload.assert_called_once_with("unsub")


@pytest.mark.parametrize("enabled", [True, False])
def test_options_override_legacy_setting_and_apply_live(integration, enabled):
    package, _, hass, entry, store = integration
    hass.data = {}
    entry.options = {OPTION: enabled, "driver_defaults": {}}
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


def test_default_selectors_are_in_same_form_even_with_hidden_controls(integration):
    _, flow_module, hass, entry, store = integration
    store.async_get_vehicle_ids.return_value = ["car", "other"]
    entry.options = {OPTION: False, "driver_defaults": {"car": "person.alice"}}
    flow = flow_module.TripsRecorderOptionsFlow()
    flow.config_entry, flow.hass = entry, hass
    result = asyncio.run(flow.async_step_init())
    schema = result["data_schema"]
    key = next(key for key in schema.schema if key.schema == "driver_defaults")
    assert key.description == {"suggested_value": {"car": "person.alice"}}
    selector = schema.schema[key]
    assert set(selector.config["fields"]) == {"car", "other"}
    assert selector.config["fields"]["car"]["label"] == "car"
    assert selector.config["fields"]["car"]["selector"].config == {"domain": "person"}
    assert schema({OPTION: False, "driver_defaults": {"car": "person.bob"}}) == {
        OPTION: False, "driver_defaults": {"car": "person.bob"}, "category_controls_enabled": False,
    }
    with pytest.raises(vol.Invalid):
        schema({"driver_defaults": {"car": "sensor.invalid"}})


def test_default_options_save_validate_and_clear(integration):
    _, flow_module, hass, entry, store = integration
    store.async_get_vehicle_ids.return_value = ["car", "other"]
    entry.options = {OPTION: False, "driver_defaults": {"car": "person.alice"}}
    flow = flow_module.TripsRecorderOptionsFlow()
    flow.config_entry, flow.hass = entry, hass
    for selection in ({"car": "person.bob", "other": "person.alice"}, {}):
        result = asyncio.run(flow.async_step_init({OPTION: False, "driver_defaults": selection}))
        assert result["data"]["driver_defaults"] == selection
    for selection in ({"car": "person.deleted"}, {"unknown": "person.alice"}):
        result = asyncio.run(flow.async_step_init({OPTION: False, "driver_defaults": selection}))
        assert result["errors"] == {"driver_defaults": "invalid_driver"}


def test_migrates_default_drivers_and_applies_updates_live(integration):
    package, _, hass, entry, store = integration
    hass.data = {}
    store.get_driver_defaults.return_value = {"car": "person.alice"}
    entry.options = {OPTION: False}
    asyncio.run(package.async_setup_entry(hass, entry))
    assert entry.options == {OPTION: False, "driver_defaults": {"car": "person.alice"}}
    entry.options = {OPTION: False, "driver_defaults": {"car": "person.bob"}}
    asyncio.run(package._async_update_options(hass, entry))
    store.async_set_driver_defaults.assert_awaited_once_with({"car": "person.bob"})
    assert store.driver_controls_enabled is False


def test_deleted_defaults_are_preserved_and_can_be_replaced(integration):
    _, flow_module, hass, entry, store = integration
    entry.options = {OPTION: False, "driver_defaults": {"old-car": "person.deleted"}}
    flow = flow_module.TripsRecorderOptionsFlow()
    flow.config_entry, flow.hass = entry, hass
    for selected in ({"old-car": "person.deleted"}, {"old-car": "person.alice"}, {}):
        result = asyncio.run(flow.async_step_init({OPTION: True, "driver_defaults": selected}))
        assert result["data"]["driver_defaults"] == selected


def test_options_translation_errors_use_home_assistant_schema():
    for path in [COMPONENT / "strings.json", *sorted((COMPONENT / "translations").glob("*.json"))]:
        options = json.loads(path.read_text())["options"]
        assert "invalid_driver" in options["error"]
        assert "driver_defaults" in options["step"]["init"]["data"]
        assert "error" not in options["step"]["init"]
        assert "invalid_categories" in options["error"]
        assert "category_defaults" in options["step"]


def test_category_catalog_and_visibility_are_admin_options_with_multiselect_defaults(integration):
    _, flow_module, hass, entry, store = integration
    store.async_get_vehicle_ids.return_value = ["car", "other"]
    entry.options = {"category_defaults": {"car": ["Work", "Removed"]}}
    flow = flow_module.TripsRecorderOptionsFlow()
    flow.config_entry, flow.hass = entry, hass
    first = asyncio.run(flow.async_step_init())
    assert "categories" in {key.schema for key in first["data_schema"].schema}
    second = asyncio.run(flow.async_step_init({
        OPTION: False, "categories": ["Work", "Personal"], "category_controls_enabled": True,
    }))
    assert second["step_id"] == "category_defaults"
    key = next(iter(second["data_schema"].schema))
    assert key.description == {"suggested_value": {"car": ["Work"]}}
    selector = second["data_schema"].schema[key]
    assert selector.config["fields"]["car"]["selector"].config == {
        "options": ["Work", "Personal"], "multiple": True, "mode": "dropdown",
    }
    result = asyncio.run(flow.async_step_category_defaults({
        "category_defaults": {"car": ["Work", "Personal"]},
    }))
    assert result["data"]["category_defaults"] == {"car": ["Work", "Personal"]}
    assert result["data"]["categories"] == ["Work", "Personal"]
    assert result["data"]["category_controls_enabled"] is True


@pytest.mark.parametrize("categories", [[""], [" Work"], ["Work", "Work"], [1], "Work"])
def test_options_reject_invalid_category_catalog(integration, categories):
    _, flow_module, hass, entry, _ = integration
    flow = flow_module.TripsRecorderOptionsFlow()
    flow.config_entry, flow.hass = entry, hass
    result = asyncio.run(flow.async_step_init({OPTION: False, "categories": categories}))
    assert result["errors"]["categories"] == "invalid_categories"


def test_category_defaults_validation_clearing_and_empty_catalog(integration):
    _, flow_module, hass, entry, store = integration
    store.async_get_vehicle_ids.return_value = ["car"]
    flow = flow_module.TripsRecorderOptionsFlow()
    flow.config_entry, flow.hass = entry, hass
    asyncio.run(flow.async_step_init({"categories": ["Work"]}))
    for defaults in ({"car": ["Unknown"]}, {"unknown": ["Work"]}, {"car": ["Work", "Work"]}):
        result = asyncio.run(flow.async_step_category_defaults({"category_defaults": defaults}))
        assert result["errors"] == {"category_defaults": "invalid_category_defaults"}
    result = asyncio.run(flow.async_step_category_defaults({}))
    assert result["data"]["category_defaults"] == {}
    result = asyncio.run(flow.async_step_init({"categories": []}))
    assert result["type"] == "create_entry"
    assert result["data"]["category_defaults"] == {}


def test_category_options_apply_live_and_do_not_reapply_on_unrelated_changes(integration):
    package, _, hass, entry, store = integration
    entry.options = {
        "categories": ["Work"], "category_controls_enabled": False,
        "category_defaults": {"car": ["Work"]},
    }
    asyncio.run(package._async_update_options(hass, entry))
    store.async_set_category_settings.assert_awaited_once_with(False, ["Work"], {"car": ["Work"]})
    asyncio.run(package._async_update_options(hass, entry))
    assert store.async_set_category_settings.await_count == 1
