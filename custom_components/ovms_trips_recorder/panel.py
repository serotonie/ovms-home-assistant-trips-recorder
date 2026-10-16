"""Panel for displaying recorded trips."""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import DATA_TRIP_STORE, DOMAIN, PANEL_PATH, PANEL_TITLE

_LOGGER = logging.getLogger(__name__)


def get_integration_version() -> str:
    """Return the integration version from manifest.json."""
    manifest = Path(__file__).with_name("manifest.json")
    return json.loads(manifest.read_text(encoding="utf-8")).get("version", "")


class TripsRecorderApiView(HomeAssistantView):
    """Expose recorded trips as JSON for the side panel."""

    requires_auth = False
    url = f"/api/{PANEL_PATH}/trips"
    name = f"api:{DOMAIN}:trips"

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def get(self, request):
        """Return the current list of trips."""
        query = request.query if request is not None else {}
        paginated = "limit" in query or "offset" in query
        if paginated:
            try:
                limit = int(query.get("limit", "10"))
                offset = int(query.get("offset", "0"))
                if not 1 <= limit <= 100 or offset < 0:
                    raise ValueError
            except ValueError:
                return self.json_message(
                    "'limit' must be between 1 and 100; 'offset' must be non-negative.",
                    status_code=400,
                )
        bounds = {}
        for parameter in ("from", "to"):
            value = query.get(parameter)
            if value:
                try:
                    bounds[parameter] = date.fromisoformat(value)
                except ValueError:
                    return self.json_message(
                        f"'{parameter}' must be an ISO 8601 date.", status_code=400
                    )
        if bounds.get("from", date.min) > bounds.get("to", date.max):
            return self.json_message(
                "'from' must be earlier than or equal to 'to'.", status_code=400
            )
        try:
            trip_timezone = ZoneInfo(query.get("timezone", "UTC"))
        except (ZoneInfoNotFoundError, ValueError):
            return self.json_message(
                "'timezone' must be an IANA timezone.", status_code=400
            )

        store = self._hass.data.get(DOMAIN, {}).get(DATA_TRIP_STORE)
        trips = await store.async_get_trips() if store else []
        vehicles = await store.async_get_vehicle_ids() if store else []
        if paginated or bounds or query.get("vehicle"):
            selected = []
            for index, trip in enumerate(trips):
                if query.get("vehicle") and trip.get("vehicle") != query["vehicle"]:
                    continue
                start = None
                if trip.get("start_time"):
                    try:
                        start = datetime.fromisoformat(trip["start_time"])
                        if start.tzinfo is None:
                            start = start.replace(tzinfo=timezone.utc)
                    except (TypeError, ValueError):
                        _LOGGER.warning("Trip has an invalid start timestamp")
                if bounds:
                    if start is None:
                        continue
                    trip_date = start.astimezone(trip_timezone).date()
                    if not (
                        bounds.get("from", date.min)
                        <= trip_date
                        <= bounds.get("to", date.max)
                    ):
                        continue
                selected.append(
                    (start.timestamp() if start else float("-inf"), index, trip)
                )
            # Storage order breaks timestamp ties deterministically.
            trips = [
                trip for _, _, trip in
                sorted(selected, key=lambda item: item[:2], reverse=True)
            ]
        count = len(trips)
        pagination = {}
        if paginated:
            trips = trips[offset:offset + limit]
            next_offset = offset + len(trips)
            pagination = {
                "limit": limit,
                "offset": offset,
                "has_more": next_offset < count,
                "next_offset": next_offset if next_offset < count else None,
            }
        return self.json(
            {
                "title": PANEL_TITLE,
                "trips": trips,
                "vehicles": vehicles,
                "count": count,
                "version": get_integration_version(),
                **pagination,
            }
        )


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


class VehicleTripsApiView(HomeAssistantView):
    """Expose trips overlapping a requested interval for one vehicle."""

    requires_auth = True
    url = f"/api/{PANEL_PATH}/vehicles/{{vehicle_id}}/trips"
    name = f"api:{DOMAIN}:vehicle_trips"

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def get(self, request: web.Request, vehicle_id: str) -> web.Response:
        """Return trips overlapping the inclusive, timezone-aware interval."""
        bounds = []
        for parameter in ("from", "to"):
            value = request.query.get(parameter)
            try:
                bound = datetime.fromisoformat(value) if value else None
            except ValueError:
                bound = None
            if bound is None or bound.tzinfo is None:
                return self.json_message(
                    f"'{parameter}' must be an ISO 8601 datetime with a timezone.",
                    status_code=400,
                )
            bounds.append(bound)
        start, end = bounds
        if start > end:
            return self.json_message(
                "'from' must be earlier than or equal to 'to'.", status_code=400
            )

        store = self._hass.data.get(DOMAIN, {}).get(DATA_TRIP_STORE)
        if store is None:
            return self.json_message("Trip storage is unavailable.", status_code=503)

        trips = []
        for trip in await store.async_get_trips():
            if trip.get("vehicle") != vehicle_id or not trip.get("start_time"):
                continue
            try:
                trip_start = datetime.fromisoformat(trip["start_time"])
                trip_end = (
                    datetime.fromisoformat(trip["stop_time"])
                    if trip.get("stop_time") is not None
                    else None
                )
            except (TypeError, ValueError):
                _LOGGER.warning(
                    "Skipping trip with invalid timestamps for vehicle %s", vehicle_id
                )
                continue
            # Legacy stored timestamps without a timezone represent UTC.
            if trip_start.tzinfo is None:
                trip_start = trip_start.replace(tzinfo=timezone.utc)
            if trip_end is not None and trip_end.tzinfo is None:
                trip_end = trip_end.replace(tzinfo=timezone.utc)
            if trip_start <= end and (trip_end is None or trip_end >= start):
                trips.append(trip)
        return self.json(
            {
                "vehicle": vehicle_id,
                "from": start.isoformat(),
                "to": end.isoformat(),
                "trips": trips,
                "count": len(trips),
            }
        )


async def async_setup_panel(hass: HomeAssistant) -> None:
    """Register the panel routes consumed by Home Assistant."""
    hass.http.register_view(TripsRecorderApiView(hass))
    hass.http.register_view(TripsRecorderModuleView())
    hass.http.register_view(VehicleTripsApiView(hass))
