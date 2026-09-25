"""Config flow for Trips Recorder."""

from __future__ import annotations

from homeassistant import config_entries

from .const import DOMAIN


class TripsRecorderConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Trips Recorder."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        """Handle the initial step."""
        return self._create_or_abort("single_instance_allowed")

    async def async_step_import(self, user_input=None):
        """Import from YAML config."""
        return self._create_or_abort("already_configured")

    def _create_or_abort(self, abort_reason: str):
        """Create the unique config entry or abort."""
        if self._async_current_entries():
            return self.async_abort(reason=abort_reason)

        return self.async_create_entry(title="Trips Recorder", data={})
