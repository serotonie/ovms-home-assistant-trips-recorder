"""Config flow for Trips Recorder."""

from __future__ import annotations

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers.selector import EntitySelector, ObjectSelector

from .const import (
    CONF_DRIVER_CONTROLS_ENABLED,
    CONF_DRIVER_DEFAULTS,
    DATA_TRIP_STORE,
    DOMAIN,
)


class TripsRecorderConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Trips Recorder."""

    VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        """Expose integration settings in Home Assistant's Configure dialog."""
        return TripsRecorderOptionsFlow()

    async def async_step_user(self, user_input=None):
        """Handle the initial step."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        return self.async_create_entry(title="OVMS Trips Recorder", data={})

    async def async_step_import(self, user_input=None):
        """Import from YAML config."""
        if self._async_current_entries():
            return self.async_abort(reason="already_configured")

        return self.async_create_entry(title="OVMS Trips Recorder", data={})


class TripsRecorderOptionsFlow(config_entries.OptionsFlow):
    """Configure optional driver controls."""

    async def async_step_init(self, user_input=None):
        """Show visibility and per-vehicle defaults together."""
        store = self.hass.data[DOMAIN][DATA_TRIP_STORE]
        defaults = self.config_entry.options.get(
            CONF_DRIVER_DEFAULTS, store.get_driver_defaults()
        )
        vehicles = sorted(set(await store.async_get_vehicle_ids()) | defaults.keys())
        errors = {}
        if user_input is not None:
            selected = user_input.get(CONF_DRIVER_DEFAULTS, {})
            people = {person["id"] for person in store.get_drivers()}
            if any(
                vehicle not in vehicles
                or (driver not in people and defaults.get(vehicle) != driver)
                for vehicle, driver in selected.items()
            ):
                errors[CONF_DRIVER_DEFAULTS] = "invalid_driver"
            else:
                return self.async_create_entry(
                    title="",
                    data={
                        **self.config_entry.options,
                        **user_input,
                        CONF_DRIVER_DEFAULTS: selected,
                    },
                )
        schema = {
            vol.Required(
                CONF_DRIVER_CONTROLS_ENABLED,
                default=self.config_entry.options.get(
                    CONF_DRIVER_CONTROLS_ENABLED, False
                ),
            ): bool,
        }
        if vehicles:
            schema[vol.Optional(
                CONF_DRIVER_DEFAULTS,
                description={"suggested_value": defaults},
            )] = ObjectSelector({
                "fields": {
                    vehicle: {
                        "label": vehicle,
                        "selector": EntitySelector({"domain": "person"}),
                    }
                    for vehicle in vehicles
                },
            })
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(schema),
            errors=errors,
        )
