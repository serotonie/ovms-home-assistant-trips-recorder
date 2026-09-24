"""Panel for displaying recorded trips."""

from __future__ import annotations

from pathlib import Path

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import DATA_TRIP_STORE, DOMAIN, PANEL_PATH, PANEL_TITLE


class TripsRecorderApiView(HomeAssistantView):
    """Expose recorded trips as JSON for the side panel."""

    requires_auth = False
    url = f"/api/{PANEL_PATH}/trips"
    name = f"api:{DOMAIN}:trips"

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def get(self, request):
        """Return the current list of trips."""
        store = self._hass.data.get(DOMAIN, {}).get(DATA_TRIP_STORE)
        trips = await store.async_get_trips() if store else []
        return self.json({"title": PANEL_TITLE, "trips": trips, "count": len(trips)})


class TripsRecorderModuleView(HomeAssistantView):
    """Serve the native Home Assistant panel module."""

    requires_auth = False
    url = f"/api/{PANEL_PATH}/panel.js"
    name = f"api:{DOMAIN}:panel_js"

    async def get(self, request):
        """Return the JavaScript module used by the native panel."""
        module = Path(__file__).with_name(
            "panel.js").read_text(encoding="utf-8")
        return web.Response(text=module, content_type="application/javascript")


async def async_setup_panel(hass: HomeAssistant) -> None:
    """Register the panel routes consumed by Home Assistant."""
    hass.http.register_view(TripsRecorderApiView(hass))
    hass.http.register_view(TripsRecorderModuleView())
