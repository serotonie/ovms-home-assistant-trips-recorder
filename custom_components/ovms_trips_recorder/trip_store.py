"""Storage layer for saved trips."""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from functools import partial
from typing import Any, Callable

from geopy.geocoders import Nominatim
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigEntryChange,
    SIGNAL_CONFIG_ENTRY_CHANGED,
)
from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.storage import Store

from .const import OVMS_DOMAIN, STORAGE_KEY, TRIP_UPDATED_EVENT, WAYPOINT_TIMEOUT

_LOGGER = logging.getLogger(__name__)


class TripStore:
    """Persist trip data in Home Assistant storage."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store = Store(hass, 1, STORAGE_KEY)
        self._data: dict[str, Any] = {"trips": [], "active": {}}
        self._vehicles: dict[str, dict[str, Any]] = {}
        self._timeout_tasks: dict[str, asyncio.Task[None]] = {}
        self._stopping_vehicle_ids: set[str] = set()
        self._allowed_vehicle_ids: set[str] = set()
        self._entry_vehicle_ids: dict[str, str] = {}
        self._geocode_cache: dict[str, dict[str, str]] = {}
        self._geocode_lock = asyncio.Lock()
        self._last_geocode_at = 0.0
        self._ovms_entry_unsub: Callable[[], None] | None = None
        self._state_unsub: Callable[[], None] | None = None
        self._started = False

    async def async_load(self) -> None:
        """Load stored trip data."""
        stored = await self._store.async_load()
        if isinstance(stored, dict):
            self._data = stored
        self._data.setdefault("trips", [])
        self._data.setdefault("active", {})
        self._data.setdefault("geocode_cache", {})
        self._geocode_cache = self._data["geocode_cache"]
        self._vehicles = {
            vehicle_id: self._new_vehicle_state(trip)
            for vehicle_id, trip in self._data["active"].items()
        }

    async def async_start(self) -> None:
        """Listen to entities provided by the OVMS integration."""
        if self._started:
            return
        self._started = True
        await self._async_sync_ovms_entries()
        self._ovms_entry_unsub = async_dispatcher_connect(
            self._hass,
            SIGNAL_CONFIG_ENTRY_CHANGED,
            self._async_ovms_entry_changed,
        )
        self._state_unsub = self._hass.bus.async_listen(
            EVENT_STATE_CHANGED, self._async_state_changed
        )
        await self._async_restore_vehicle_metrics()
        for vehicle_id in self._vehicles:
            self._schedule_timeout(vehicle_id)

    async def async_stop(self) -> None:
        """Stop listening to OVMS entities and cancel timeout tasks."""
        self._started = False
        if self._ovms_entry_unsub is not None:
            self._ovms_entry_unsub()
            self._ovms_entry_unsub = None
        if self._state_unsub is not None:
            self._state_unsub()
            self._state_unsub = None
        self._allowed_vehicle_ids.clear()
        self._entry_vehicle_ids.clear()
        for task in self._timeout_tasks.values():
            task.cancel()
        self._timeout_tasks.clear()
        self._stopping_vehicle_ids.clear()

    async def _async_sync_ovms_entries(self) -> None:
        """Keep configured vehicle IDs aligned with OVMS entries."""
        entry_vehicle_ids: dict[str, str] = {}
        wanted_vehicle_ids: set[str] = set()
        for entry in self._hass.config_entries.async_entries(OVMS_DOMAIN):
            config = {**entry.data, **entry.options}
            vehicle_id = str(config.get("vehicle_id", "")).strip()
            if vehicle_id:
                wanted_vehicle_ids.add(vehicle_id)
                entry_vehicle_ids[entry.entry_id] = vehicle_id
        self._allowed_vehicle_ids = wanted_vehicle_ids
        self._entry_vehicle_ids = entry_vehicle_ids

    async def _async_restore_vehicle_metrics(self) -> None:
        """Seed metric values from already available OVMS entities."""
        from homeassistant.helpers import entity_registry as er

        registry = er.async_get(self._hass)
        for entry_id, vehicle_id in self._entry_vehicle_ids.items():
            for entity in er.async_entries_for_config_entry(registry, entry_id):
                state = self._hass.states.get(entity.entity_id)
                if state is not None:
                    await self._async_process_ovms_state(
                        vehicle_id,
                        state.attributes.get("topic", ""),
                        state,
                        initial=True,
                    )

    @callback
    def _async_state_changed(self, event: Event) -> None:
        """Process state changes from entities owned by the OVMS integration."""
        if self._started:
            self._hass.async_create_task(self._async_process_state_change(event))

    async def _async_process_state_change(self, event: Event) -> None:
        """Resolve a changed entity to its OVMS vehicle and process its value."""
        from homeassistant.helpers import entity_registry as er

        new_state = event.data.get("new_state")
        if new_state is None:
            return
        registry_entry = er.async_get(self._hass).async_get(new_state.entity_id)
        if (
            registry_entry is None
            or registry_entry.platform != OVMS_DOMAIN
            or registry_entry.config_entry_id not in self._entry_vehicle_ids
        ):
            return
        await self._async_process_ovms_state(
            self._entry_vehicle_ids[registry_entry.config_entry_id],
            new_state.attributes.get("topic", ""),
            new_state,
        )

    async def _async_process_ovms_state(
        self,
        vehicle_id: str,
        topic: str,
        state: Any,
        *,
        initial: bool = False,
    ) -> None:
        """Use the OVMS entity topic and state to update a trip."""
        if not topic or state.state in {"unknown", "unavailable"}:
            return
        entity_parts = state.attributes.get("parts")
        parts = (
            [str(part) for part in entity_parts]
            if isinstance(entity_parts, list)
            else topic.strip("/").split("/")
        )
        value = str(state.state).strip()

        if "event" in parts:
            event_parts = parts[parts.index("event") + 1 :]
            if initial:
                return
            event_name = "/".join(event_parts)
            if event_name == "vehicle/on":
                await self._async_start_trip(vehicle_id)
            elif event_name == "vehicle/off":
                await self._async_stop_trip(vehicle_id)
            return

        if "metric" not in parts:
            return
        metric = "/".join(parts[parts.index("metric") + 1 :])
        if metric in {"v/e/on", "v.e.on"}:
            if initial:
                return
            if value.lower() in {"yes", "on", "1", "true"}:
                await self._async_start_trip(vehicle_id)
            elif value.lower() in {"no", "off", "0", "false"}:
                await self._async_stop_trip(vehicle_id)
            return
        if initial and self._vehicles.get(vehicle_id, {}).get("trip") is not None:
            return
        if metric.endswith(("/utc", ".utc")):
            timestamp = state.attributes.get("timestamp_object")
            if timestamp is not None:
                value = (
                    timestamp.isoformat()
                    if hasattr(timestamp, "isoformat")
                    else str(timestamp)
                )
        await self._async_update_metric(vehicle_id, metric, value)

    def _async_ovms_entry_changed(
        self, change: ConfigEntryChange, entry: ConfigEntry
    ) -> None:
        """Synchronize vehicle mappings when an OVMS config entry changes."""
        if self._started and entry.domain == OVMS_DOMAIN:
            self._hass.async_create_task(self._async_sync_ovms_entries())

    async def async_save(self) -> None:
        """Persist trip data."""
        await self._store.async_save(self._data)
        self._hass.bus.async_fire(
            TRIP_UPDATED_EVENT,
            {
                "trips": list(self._data.get("trips", []))
                + list(self._data.get("active", {}).values())
            },
        )

    async def async_get_trips(self) -> list[dict[str, Any]]:
        """Return all stored trips."""
        trips = list(self._data.get("trips", []))
        active_trips = self._data.get("active", {}).values()
        return trips + list(active_trips)

    async def async_get_vehicle_ids(self) -> list[str]:
        """Return configured and observed vehicle IDs for filter controls."""
        observed_vehicle_ids = {
            str(trip.get("vehicle", "")).strip()
            for trip in await self.async_get_trips()
            if trip.get("vehicle")
        }
        return sorted(self._allowed_vehicle_ids | observed_vehicle_ids)

    async def async_add_trip(self, trip: dict[str, Any]) -> dict[str, Any]:
        """Add one trip to the store and persist it."""
        self._data.setdefault("trips", []).append(trip)
        await self.async_save()
        return trip

    async def _async_start_trip(self, vehicle_id: str) -> None:
        state = self._vehicles.setdefault(
            vehicle_id, self._new_vehicle_state())
        if state["trip"] is not None:
            return
        trip = {
            "vehicle": vehicle_id,
            "start_time": None,
            "stop_time": None,
            "start_point_lat": state["latitude"],
            "start_point_long": state["longitude"],
            "stop_point_lat": None,
            "stop_point_long": None,
            "distance": 0,
            "waypoints": [],
        }
        state["trip"] = trip
        self._data["active"][vehicle_id] = trip
        await self.async_save()
        self._schedule_timeout(vehicle_id)

    async def _async_stop_trip(self, vehicle_id: str) -> None:
        state = self._vehicles.get(vehicle_id)
        if (
            not state
            or state["trip"] is None
            or vehicle_id in self._stopping_vehicle_ids
        ):
            return
        self._stopping_vehicle_ids.add(vehicle_id)
        trip = state["trip"]
        try:
            trip["stop_time"] = (
                trip["waypoints"][-1]["timestamp"]
                if trip["waypoints"]
                else state["timestamp"] or self._now()
            )
            trip["stop_point_lat"] = state["latitude"]
            trip["stop_point_long"] = state["longitude"]
            trip["distance"] = state["distance"]
            await self._async_geocode_trip(trip)
            self._data["trips"].append(trip)
            self._data["active"].pop(vehicle_id, None)
            state["trip"] = None
            self._cancel_timeout(vehicle_id)
            await self.async_save()
        finally:
            self._stopping_vehicle_ids.discard(vehicle_id)

    async def _async_update_metric(
        self, vehicle_id: str, metric: str, value: str
    ) -> None:
        state = self._vehicles.setdefault(
            vehicle_id, self._new_vehicle_state())
        metric_name = metric.rsplit("/", 1)[-1]
        if metric_name == "utc":
            timestamp = value.replace(" UTC", "+00:00")
            try:
                state["timestamp"] = datetime.fromisoformat(
                    timestamp).isoformat()
            except ValueError:
                pass
        elif metric_name in {
            "latitude",
            "longitude",
            "gpshdop",
            "odometer",
            "distance",
            "trip",
        }:
            try:
                number = float(value)
            except ValueError:
                return
            state["distance" if metric_name ==
                  "trip" else metric_name] = number
        else:
            return

        trip = state["trip"]
        if trip is None:
            return
        if trip["start_point_lat"] == -1 and state["latitude"] != -1:
            trip["start_point_lat"] = state["latitude"]
        if trip["start_point_long"] == -1 and state["longitude"] != -1:
            trip["start_point_long"] = state["longitude"]
        if state["latitude"] == -1 or state["longitude"] == -1:
            return

        trip["distance"] = state["distance"]
        waypoint = {
            "timestamp": state["timestamp"] or self._now(),
            "distance": state["distance"],
            "gpshdop": state["gpshdop"],
            "odometer": state["odometer"],
            "position_lat": state["latitude"],
            "position_long": state["longitude"],
        }
        if not trip["waypoints"] or trip["waypoints"][-1] != waypoint:
            trip["waypoints"].append(waypoint)
        if trip["start_time"] is None:
            trip["start_time"] = waypoint["timestamp"]
        self._data["active"][vehicle_id] = trip
        await self.async_save()
        self._schedule_timeout(vehicle_id)

    def _new_vehicle_state(
        self, trip: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        state = {
            "latitude": -1,
            "longitude": -1,
            "gpshdop": -1,
            "odometer": -1,
            "distance": 0,
            "timestamp": None,
            "trip": trip,
        }
        if trip and trip.get("waypoints"):
            last_waypoint = trip["waypoints"][-1]
            state.update(
                latitude=last_waypoint.get("position_lat", -1),
                longitude=last_waypoint.get("position_long", -1),
                gpshdop=last_waypoint.get("gpshdop", -1),
                odometer=last_waypoint.get("odometer", -1),
                distance=trip.get("distance", 0),
                timestamp=last_waypoint.get("timestamp", state["timestamp"]),
            )
        return state

    def _schedule_timeout(self, vehicle_id: str) -> None:
        self._cancel_timeout(vehicle_id)
        self._timeout_tasks[vehicle_id] = self._hass.async_create_task(
            self._async_timeout(vehicle_id)
        )

    def _cancel_timeout(self, vehicle_id: str) -> None:
        task = self._timeout_tasks.pop(vehicle_id, None)
        if task is not None:
            task.cancel()

    async def _async_timeout(self, vehicle_id: str) -> None:
        try:
            await asyncio.sleep(WAYPOINT_TIMEOUT)
            await self._async_stop_trip(vehicle_id)
        except asyncio.CancelledError:
            return

    async def _async_geocode_trip(self, trip: dict[str, Any]) -> None:
        """Add Nominatim address fields without blocking Home Assistant."""
        for point in ("start", "stop"):
            latitude = trip.get(f"{point}_point_lat")
            longitude = trip.get(f"{point}_point_long")
            if latitude in (None, -1) or longitude in (None, -1):
                continue
            address = await self._async_geocode(float(latitude), float(longitude))
            for field in (
                "house_number",
                "road",
                "village",
                "postcode",
                "country",
            ):
                trip[f"{point}_{field}"] = address.get(field, "-1")

    async def _async_geocode(self, latitude: float, longitude: float) -> dict[str, str]:
        cache_key = f"{latitude:.6f},{longitude:.6f}"
        if cache_key in self._geocode_cache:
            return self._geocode_cache[cache_key]
        async with self._geocode_lock:
            if cache_key in self._geocode_cache:
                return self._geocode_cache[cache_key]
            wait_for = 1.0 - (time.monotonic() - self._last_geocode_at)
            if wait_for > 0:
                await asyncio.sleep(wait_for)
            geocoder = Nominatim(user_agent="ovms-trips-recorder")
            try:
                location = await self._hass.async_add_executor_job(
                    partial(
                        geocoder.reverse,
                        (latitude, longitude),
                        language="fr",
                        timeout=10,
                    )
                )
            except Exception as ex:
                _LOGGER.warning("Unable to reverse geocode trip point: %s", ex)
                return {}
            self._last_geocode_at = time.monotonic()
            address = dict(
                (location.raw if location else {}).get("address", {}))
            address["village"] = address.get(
                "town", address.get("village", address.get("city", "-1"))
            )
            self._geocode_cache[cache_key] = address
            self._data["geocode_cache"] = self._geocode_cache
            await self.async_save()
            return address

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    async def async_clear(self) -> None:
        """Clear stored trips."""
        self._data = {"trips": []}
        self._data["active"] = {}
        self._vehicles.clear()
        for vehicle_id in list(self._timeout_tasks):
            self._cancel_timeout(vehicle_id)
        await self.async_save()
