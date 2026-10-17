"""Config flow for Trips Recorder."""

from __future__ import annotations

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers.selector import (
    EntitySelector,
    ObjectSelector,
    SelectSelector,
    TextSelector,
)

from .const import (
    CONF_CATEGORIES,
    CONF_CATEGORY_CONTROLS_ENABLED,
    CONF_CATEGORY_DEFAULTS,
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
        user_id = self.context.get("user_id")
        user = await self.hass.auth.async_get_user(user_id) if user_id else None
        if user is None or not user.is_admin:
            return self.async_abort(reason="not_admin")

        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        return self.async_create_entry(title="OVMS Trips Recorder", data={})

    async def async_step_import(self, user_input=None):
        """Import from YAML config."""
        if self._async_current_entries():
            return self.async_abort(reason="already_configured")

        return self.async_create_entry(title="OVMS Trips Recorder", data={})


class TripsRecorderOptionsFlow(config_entries.OptionsFlow):
    """Configure driver and category controls and defaults (admin-only HA options)."""

    async def async_step_init(self, user_input=None):
        """Show visibility and per-vehicle defaults together."""
        store = self.hass.data[DOMAIN][DATA_TRIP_STORE]
        defaults = self.config_entry.options.get(
            CONF_DRIVER_DEFAULTS, store.get_driver_defaults()
        )
        vehicles = sorted(set(await store.async_get_vehicle_ids()) | defaults.keys())
        categories = self.config_entry.options.get(CONF_CATEGORIES, [])
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
            categories = user_input.get(CONF_CATEGORIES, [])
            try:
                store.validate_categories(categories)
            except ValueError:
                errors[CONF_CATEGORIES] = "invalid_categories"
            if not errors:
                self._options = {
                    **self.config_entry.options,
                    **user_input,
                    CONF_DRIVER_DEFAULTS: selected,
                    CONF_CATEGORIES: categories,
                    CONF_CATEGORY_CONTROLS_ENABLED: user_input.get(
                        CONF_CATEGORY_CONTROLS_ENABLED, False
                    ),
                }
                return await self.async_step_category_defaults()
        schema = {
            vol.Required(
                CONF_DRIVER_CONTROLS_ENABLED,
                default=self.config_entry.options.get(
                    CONF_DRIVER_CONTROLS_ENABLED, False
                ),
            ): bool,
            vol.Required(
                CONF_CATEGORY_CONTROLS_ENABLED,
                default=self.config_entry.options.get(
                    CONF_CATEGORY_CONTROLS_ENABLED, False
                ),
            ): bool,
            vol.Optional(
                CONF_CATEGORIES,
                description={"suggested_value": categories},
            ): TextSelector({"multiple": True}),
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

    async def async_step_category_defaults(self, user_input=None):
        """Choose defaults from the submitted catalog before saving all options."""
        store = self.hass.data[DOMAIN][DATA_TRIP_STORE]
        categories = self._options[CONF_CATEGORIES]
        previous = self.config_entry.options.get(CONF_CATEGORY_DEFAULTS, {})
        vehicles = sorted(set(await store.async_get_vehicle_ids()) | previous.keys())
        if not categories or not vehicles:
            self._options[CONF_CATEGORY_DEFAULTS] = {}
            return self.async_create_entry(title="", data=self._options)
        errors = {}
        if user_input is not None:
            defaults = user_input.get(CONF_CATEGORY_DEFAULTS, {})
            try:
                for vehicle, selected in defaults.items():
                    store.validate_categories(selected)
                    if vehicle not in vehicles or not set(selected) <= set(categories):
                        raise ValueError
            except ValueError:
                errors[CONF_CATEGORY_DEFAULTS] = "invalid_category_defaults"
            else:
                self._options[CONF_CATEGORY_DEFAULTS] = defaults
                return self.async_create_entry(title="", data=self._options)
        suggested = {
            vehicle: [category for category in selected if category in categories]
            for vehicle, selected in previous.items()
            if vehicle in vehicles
        }
        return self.async_show_form(
            step_id="category_defaults",
            data_schema=vol.Schema({
                vol.Optional(
                    CONF_CATEGORY_DEFAULTS,
                    description={"suggested_value": suggested},
                ): ObjectSelector({
                    "fields": {
                        vehicle: {
                            "label": vehicle,
                            "selector": SelectSelector({
                                "options": categories,
                                "multiple": True,
                                "mode": "dropdown",
                            }),
                        }
                        for vehicle in vehicles
                    },
                }),
            }),
            errors=errors,
        )
