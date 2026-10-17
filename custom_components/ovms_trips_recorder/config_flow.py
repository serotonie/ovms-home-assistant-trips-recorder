"""Config flow for Trips Recorder."""

from __future__ import annotations

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback

from .const import CONF_DRIVER_CONTROLS_ENABLED, DOMAIN


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
        """Show and save the driver-controls visibility preference."""
        if user_input is not None:
            return self.async_create_entry(
                title="", data={**self.config_entry.options, **user_input}
            )
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema({
                vol.Required(
                    CONF_DRIVER_CONTROLS_ENABLED,
                    default=self.config_entry.options.get(
                        CONF_DRIVER_CONTROLS_ENABLED, False
                    ),
                ): bool,
            }),
        )
