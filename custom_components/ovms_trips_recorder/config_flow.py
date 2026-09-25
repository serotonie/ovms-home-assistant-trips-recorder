"""Config flow for Trips Recorder."""

from __future__ import annotations

from homeassistant import config_entries

from .const import DOMAIN


class TripsRecorderConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Trips Recorder."""

    VERSION = 1

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
