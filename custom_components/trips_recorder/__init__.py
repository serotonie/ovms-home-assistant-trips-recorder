"""Trips Recorder Home Assistant integration."""

from __future__ import annotations

import logging

from homeassistant.components import panel_custom
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import HomeAssistant

from .const import (
    DATA_TRIP_STORE,
    DOMAIN,
    PANEL_ICON,
    PANEL_PATH,
    PANEL_TITLE,
)
from .panel import async_setup_panel
from .trip_store import TripStore

_LOGGER = logging.getLogger(__name__)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the integration and register the side panel."""
    hass.data.setdefault(DOMAIN, {})
    if DATA_TRIP_STORE not in hass.data[DOMAIN]:
        store = TripStore(hass)
        await store.async_load()
        hass.data[DOMAIN][DATA_TRIP_STORE] = store

        if hass.is_running:
            await store.async_start()
        else:
            async def start_store(_event) -> None:
                await store.async_start()

            hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, start_store)

    await async_setup_panel(hass)

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

    return True


async def async_setup_entry(hass: HomeAssistant, entry) -> bool:
    """Set up the integration from a config entry if needed."""
    return await async_setup(hass, {})


async def async_unload_entry(hass: HomeAssistant, entry) -> bool:
    """Unload the integration."""
    store = hass.data.get(DOMAIN, {}).get(DATA_TRIP_STORE)
    if store:
        await store.async_stop()
    return True
