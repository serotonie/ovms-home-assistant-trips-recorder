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


def _matches_trip_filters(trip: dict, query) -> bool:
    """Combine exact driver and category-membership filters."""
    return (
        (not query.get("driver") or trip.get("driver") == query["driver"])
        and (
            not query.get("category")
            or query["category"] in (trip.get("categories") or [])
        )
    )


async def _can_merge_trip(request, store, trip_id: str) -> bool:
    """Allow administrators or the assigned driver when driver controls are enabled."""
    user = request.get("hass_user")
    if getattr(user, "is_admin", False):
        return True
    return await store.async_user_owns_trip(trip_id, getattr(user, "id", None))


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
        driver_ids = sorted({trip["driver"] for trip in trips if trip.get("driver")})
        category_names = sorted({
            category for trip in trips for category in (trip.get("categories") or [])
        })
        if paginated or bounds or any(query.get(key) for key in ("vehicle", "driver", "category")):
            selected = []
            for index, trip in enumerate(trips):
                if query.get("vehicle") and trip.get("vehicle") != query["vehicle"]:
                    continue
                if not _matches_trip_filters(trip, query):
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
        merge_candidates = (
            await store.async_get_trip_merge_candidates() if store else {}
        )
        trips = [
            {**trip, "merge_next_id": merge_candidates[trip["id"]]}
            if trip.get("id") in merge_candidates else trip
            for trip in trips
        ]
        return self.json(
            {
                "title": PANEL_TITLE,
                "trips": trips,
                "vehicles": vehicles,
                "driver_ids": driver_ids,
                "category_names": category_names,
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
            if not _matches_trip_filters(trip, request.query):
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


class DriversApiView(HomeAssistantView):
    """Expose person choices and per-vehicle defaults to authenticated clients."""

    requires_auth = True
    url = f"/api/{PANEL_PATH}/drivers"
    name = f"api:{DOMAIN}:drivers"

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def get(self, request):
        store = self._hass.data.get(DOMAIN, {}).get(DATA_TRIP_STORE)
        if store is None:
            return self.json_message("Trip storage is unavailable.", status_code=503)
        user = request.get("hass_user") if request is not None else None
        return self.json({
            "enabled": store.driver_controls_enabled,
            "drivers": store.get_drivers(),
            "defaults": store.get_driver_defaults(),
            "vehicles": await store.async_get_vehicle_ids(),
            "user_driver_id": store.get_driver_id_for_user(
                getattr(user, "id", None)
            ),
        })


class DriverUpdateApiView(HomeAssistantView):
    """Update trip drivers or vehicle defaults with validated person IDs."""

    requires_auth = True
    url = f"/api/{PANEL_PATH}/drivers/{{kind}}/{{target}}"
    name = f"api:{DOMAIN}:driver_update"

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def put(self, request, kind: str, target: str):
        if kind != "trip":
            return self.json_message("Unknown driver target.", status_code=404)
        store = self._hass.data.get(DOMAIN, {}).get(DATA_TRIP_STORE)
        if store is None:
            return self.json_message("Trip storage is unavailable.", status_code=503)
        try:
            data = await request.json()
        except (ValueError, UnicodeDecodeError):
            return self.json_message("Invalid JSON body.", status_code=400)
        if not isinstance(data, dict) or not isinstance(data.get("driver"), str):
            return self.json_message("'driver' must be a person entity ID.", status_code=400)
        try:
            await store.async_set_trip_driver(target, data["driver"])
        except ValueError as error:
            return self.json_message(str(error), status_code=400)
        except KeyError:
            return self.json_message("Vehicle or trip not found.", status_code=404)
        return self.json({"driver": data["driver"]})


class CategoriesApiView(HomeAssistantView):
    """Read admin-defined choices; category definitions have no REST write route."""

    requires_auth = True
    url = f"/api/{PANEL_PATH}/categories"
    name = f"api:{DOMAIN}:categories"

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def get(self, request):
        store = self._hass.data.get(DOMAIN, {}).get(DATA_TRIP_STORE)
        if store is None:
            return self.json_message("Trip storage is unavailable.", status_code=503)
        return self.json(store.get_category_settings())


class TripCategoriesApiView(HomeAssistantView):
    """Allow authenticated users to select categories, not define them."""

    requires_auth = True
    url = f"/api/{PANEL_PATH}/categories/trip/{{trip_id}}"
    name = f"api:{DOMAIN}:trip_categories"

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def put(self, request, trip_id: str):
        store = self._hass.data.get(DOMAIN, {}).get(DATA_TRIP_STORE)
        if store is None:
            return self.json_message("Trip storage is unavailable.", status_code=503)
        try:
            data = await request.json()
        except (ValueError, UnicodeDecodeError):
            return self.json_message("Invalid JSON body.", status_code=400)
        if not isinstance(data, dict) or "categories" not in data:
            return self.json_message("'categories' must be a list of category names.", status_code=400)
        try:
            await store.async_set_trip_categories(trip_id, data["categories"])
        except ValueError as error:
            return self.json_message(str(error), status_code=400)
        except KeyError:
            return self.json_message("Trip not found.", status_code=404)
        return self.json({"categories": data["categories"]})


class TripDeleteApiView(HomeAssistantView):
    """Allow administrators to delete a trip."""

    requires_auth = True
    url = f"/api/{PANEL_PATH}/trips/{{trip_id}}"
    name = f"api:{DOMAIN}:trip_delete"

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def delete(self, request: web.Request, trip_id: str):
        if not getattr(request.get("hass_user"), "is_admin", False):
            return self.json_message("Administrator access required.", status_code=403)
        store = self._hass.data.get(DOMAIN, {}).get(DATA_TRIP_STORE)
        if store is None:
            return self.json_message("Trip storage is unavailable.", status_code=503)
        try:
            await store.async_delete_trip(trip_id)
        except KeyError:
            return self.json_message("Trip not found.", status_code=404)
        return self.json({"deleted": True})


class TripMergePreviewApiView(HomeAssistantView):
    """Preview an administrator-requested merge with the next vehicle trip."""

    requires_auth = True
    url = f"/api/{PANEL_PATH}/trips/{{trip_id}}/merge-preview"
    name = f"api:{DOMAIN}:trip_merge_preview"

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def get(self, request: web.Request, trip_id: str):
        store = self._hass.data.get(DOMAIN, {}).get(DATA_TRIP_STORE)
        if store is None:
            return self.json_message("Trip storage is unavailable.", status_code=503)
        if not await _can_merge_trip(request, store, trip_id):
            return self.json_message("Trip driver or administrator access required.", status_code=403)
        try:
            return self.json(await store.async_get_trip_merge_preview(trip_id))
        except KeyError:
            return self.json_message("Trip not found.", status_code=404)
        except ValueError as error:
            return self.json_message(str(error), status_code=409)


class TripMergeApiView(HomeAssistantView):
    """Merge two consecutive trips as an administrator."""

    requires_auth = True
    url = f"/api/{PANEL_PATH}/trips/{{trip_id}}/merge"
    name = f"api:{DOMAIN}:trip_merge"

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def post(self, request: web.Request, trip_id: str):
        store = self._hass.data.get(DOMAIN, {}).get(DATA_TRIP_STORE)
        if store is None:
            return self.json_message("Trip storage is unavailable.", status_code=503)
        if not await _can_merge_trip(request, store, trip_id):
            return self.json_message("Trip driver or administrator access required.", status_code=403)
        try:
            data = await request.json()
        except (ValueError, UnicodeDecodeError):
            return self.json_message("Invalid JSON body.", status_code=400)
        if not isinstance(data, dict) or not isinstance(data.get("next_trip_id"), str):
            return self.json_message("'next_trip_id' must be a trip ID.", status_code=400)
        try:
            result = await store.async_merge_trips(trip_id, data["next_trip_id"])
        except KeyError:
            return self.json_message("Trip not found.", status_code=404)
        except ValueError as error:
            return self.json_message(str(error), status_code=409)
        return self.json(result)


async def async_setup_panel(hass: HomeAssistant) -> None:
    """Register the panel routes consumed by Home Assistant."""
    hass.http.register_view(TripsRecorderApiView(hass))
    hass.http.register_view(DriversApiView(hass))
    hass.http.register_view(DriverUpdateApiView(hass))
    hass.http.register_view(CategoriesApiView(hass))
    hass.http.register_view(TripCategoriesApiView(hass))
    hass.http.register_view(TripDeleteApiView(hass))
    hass.http.register_view(TripMergePreviewApiView(hass))
    hass.http.register_view(TripMergeApiView(hass))
    hass.http.register_view(TripsRecorderModuleView())
    hass.http.register_view(VehicleTripsApiView(hass))
