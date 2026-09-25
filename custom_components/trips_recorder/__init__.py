"""Trips Recorder Home Assistant integration."""

from __future__ import annotations

import logging

from homeassistant.components import panel_custom
from homeassistant.config_entries import SOURCE_IMPORT
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED, Platform
from homeassistant.core import HomeAssistant

from .const import (
    DATA_SETUP_COMPLETE,
    DATA_TRIP_STORE,
    DOMAIN,
    PANEL_ICON,
    PANEL_PATH,
    PANEL_TITLE,
)
from .panel import async_setup_panel
from .trip_store import TripStore

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.SENSOR]


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the integration from YAML."""
    if DOMAIN in config and not hass.config_entries.async_entries(DOMAIN):
        hass.async_create_task(
            hass.config_entries.flow.async_init(
                DOMAIN, context={"source": SOURCE_IMPORT}, data={}
            )
        )
    return True


async def _async_setup_integration(
    hass: HomeAssistant, config_entry=None
) -> bool:
    """Set up integration internals and register the side panel."""
    hass.data.setdefault(DOMAIN, {})
    if hass.data[DOMAIN].get(DATA_SETUP_COMPLETE):
        return True

    if DATA_TRIP_STORE not in hass.data[DOMAIN]:
        store = TripStore(hass)
        await store.async_load()
        hass.data[DOMAIN][DATA_TRIP_STORE] = store

        if hass.is_running:
            await store.async_start()
        else:
            async def start_store(_event) -> None:
                await store.async_start()

            hass.bus.async_listen_once(
                EVENT_HOMEASSISTANT_STARTED, start_store)

    await async_setup_panel(hass)

    if config_entry is not None:
        await hass.config_entries.async_forward_entry_setups(config_entry, PLATFORMS)

    await panel_custom.async_register_panel(
        hass=hass,
        frontend_url_path=PANEL_PATH,
        webcomponent_name="trips-recorder-panel",
        module_url=f"/api/{PANEL_PATH}/panel.js",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        embed_iframe=False,
        require_admin=False,
    )

    hass.data[DOMAIN][DATA_SETUP_COMPLETE] = True
    return True


async def async_setup_entry(hass: HomeAssistant, entry) -> bool:
    """Set up the integration from a config entry if needed."""
    return await _async_setup_integration(hass, entry)


async def async_unload_entry(hass: HomeAssistant, entry) -> bool:
    """Unload the integration."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    await panel_custom.async_remove_panel(hass, PANEL_PATH)

    domain_data = hass.data.get(DOMAIN, {})
    store = domain_data.get(DATA_TRIP_STORE)
    if store:
        await store.async_stop()
    domain_data.pop(DATA_TRIP_STORE, None)
    domain_data.pop(DATA_SETUP_COMPLETE, None)
    return unload_ok
