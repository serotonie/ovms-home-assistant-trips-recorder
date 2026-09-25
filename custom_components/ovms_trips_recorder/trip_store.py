"""Storage layer for saved trips."""

from __future__ import annotations

import asyncio
import logging
import ssl
import time
from datetime import datetime, timezone
from functools import partial
from typing import Any, Callable

from geopy.geocoders import Nominatim
import paho.mqtt.client as mqtt
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigEntryChange,
    SIGNAL_CONFIG_ENTRY_CHANGED,
)
from homeassistant.core import HomeAssistant
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
        self._mqtt_clients: dict[str, mqtt.Client] = {}
        self._allowed_vehicle_ids: set[str] = set()
        self._entry_signatures: dict[str, tuple[Any, ...]] = {}
        self._geocode_cache: dict[str, dict[str, str]] = {}
        self._geocode_lock = asyncio.Lock()
        self._last_geocode_at = 0.0
        self._ovms_sync_task: asyncio.Task[None] | None = None
        self._ovms_entry_unsub: Callable[[], None] | None = None
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
        """Connect to each broker configured by the OVMS integration."""
        if self._started:
            return
        self._started = True
        await self._async_sync_ovms_entries()
        self._ovms_entry_unsub = async_dispatcher_connect(
            self._hass,
            SIGNAL_CONFIG_ENTRY_CHANGED,
            self._async_ovms_entry_changed,
        )
        for vehicle_id in self._vehicles:
            self._schedule_timeout(vehicle_id)

    async def async_stop(self) -> None:
        """Stop receiving MQTT messages and cancel timeout tasks."""
        self._started = False
        if self._ovms_entry_unsub is not None:
            self._ovms_entry_unsub()
            self._ovms_entry_unsub = None
        if self._ovms_sync_task is not None:
            self._ovms_sync_task.cancel()
            self._ovms_sync_task = None
        for client in self._mqtt_clients.values():
            await self._hass.async_add_executor_job(client.loop_stop)
            await self._hass.async_add_executor_job(client.disconnect)
        self._mqtt_clients.clear()
        self._entry_signatures.clear()
        self._allowed_vehicle_ids.clear()
        for task in self._timeout_tasks.values():
            task.cancel()
        self._timeout_tasks.clear()
        self._stopping_vehicle_ids.clear()

    async def _async_start_mqtt_client(
        self, entry_id: str, config: dict[str, Any]
    ) -> mqtt.Client | None:
        """Start a listener using one OVMS config entry's broker settings."""
        protocol = mqtt.MQTTv5 if hasattr(mqtt, "MQTTv5") else mqtt.MQTTv311
        transport = "websockets" if config.get(
            "protocol") in ("ws", "wss") else "tcp"
        client = mqtt.Client(
            client_id=f"ha_trips_{id(config):x}"[:23],
            protocol=protocol,
            transport=transport,
        )
        username = config.get("username")
        if username:
            client.username_pw_set(username, config.get("password"))
        if config.get("protocol") in ("mqtts", "wss"):
            context = ssl.create_default_context()
            if not config.get("verify_ssl", True):
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
            client.tls_set_context(context)

        vehicle_id = str(config.get("vehicle_id", "")).strip()

        def on_message(_, __, message) -> None:
            asyncio.run_coroutine_threadsafe(
                self._async_mqtt_message(message, vehicle_id), self._hass.loop
            )

        client.on_message = on_message
        host = config.get("host")
        port = config.get("port")
        if not host or not port:
            _LOGGER.warning("OVMS broker configuration is incomplete")
            return None
        await self._hass.async_add_executor_job(client.connect, host, port, 60)
        topic = self._mqtt_topic_filter(config)
        await self._hass.async_add_executor_job(client.subscribe, topic, 2)
        await self._hass.async_add_executor_job(client.loop_start)
        self._mqtt_clients[entry_id] = client
        return client

    async def _async_sync_ovms_entries(self) -> None:
        """Keep MQTT clients and allowed vehicle IDs aligned with OVMS entries."""
        ovms_entries = self._hass.data.get(OVMS_DOMAIN, {})
        config_entries = {
            entry.entry_id: entry
            for entry in self._hass.config_entries.async_entries(OVMS_DOMAIN)
        }
        entry_configs: dict[str, dict[str, Any]] = {}
        wanted_vehicle_ids: set[str] = set()

        for entry_id, entry in config_entries.items():
            config = {**entry.data, **entry.options}
            entry_data = ovms_entries.get(entry_id, {})
            ovms_client = entry_data.get("mqtt_client")
            client_config = getattr(ovms_client, "config", None)
            if isinstance(client_config, dict):
                config.update(client_config)
            entry_configs[entry_id] = config

            vehicle_id = str(config.get("vehicle_id", "")).strip()
            if vehicle_id:
                wanted_vehicle_ids.add(vehicle_id)

        # The panel can list configured vehicles even when their broker is
        # temporarily unavailable.
        self._allowed_vehicle_ids = wanted_vehicle_ids

        for entry_id, config in entry_configs.items():

            signature = self._mqtt_config_signature(config)
            if self._entry_signatures.get(entry_id) == signature and entry_id in self._mqtt_clients:
                continue

            old_client = self._mqtt_clients.pop(entry_id, None)
            if old_client is not None:
                await self._hass.async_add_executor_job(old_client.loop_stop)
                await self._hass.async_add_executor_job(old_client.disconnect)

            try:
                client = await self._async_start_mqtt_client(entry_id, config)
            except Exception as ex:
                _LOGGER.warning(
                    "Unable to start MQTT listener for OVMS vehicle %s: %s",
                    config.get("vehicle_id", entry_id),
                    ex,
                )
                client = None
            if client is not None:
                self._entry_signatures[entry_id] = signature
            else:
                self._entry_signatures.pop(entry_id, None)

        removed_entry_ids = set(self._mqtt_clients) - set(entry_configs)
        for entry_id in removed_entry_ids:
            client = self._mqtt_clients.pop(entry_id)
            await self._hass.async_add_executor_job(client.loop_stop)
            await self._hass.async_add_executor_job(client.disconnect)
            self._entry_signatures.pop(entry_id, None)

    @staticmethod
    def _mqtt_topic_filter(config: dict[str, Any]) -> str:
        """Build the subscription topic from an OVMS topic structure."""
        topic_prefix = str(config.get("topic_prefix", "ovms")).strip("/")
        vehicle_id = str(config.get("vehicle_id", "")).strip()
        mqtt_username = str(
            config.get("mqtt_username") or config.get("username") or ""
        ).strip()
        structure = str(
            config.get("topic_structure")
            or "{prefix}/{mqtt_username}/{vehicle_id}"
        ).strip("/")
        try:
            topic = structure.format(
                prefix=topic_prefix,
                mqtt_username=mqtt_username,
                vehicle_id=vehicle_id,
            ).strip("/")
        except (KeyError, ValueError):
            _LOGGER.warning("Invalid OVMS topic structure: %s", structure)
            topic = topic_prefix
        return f"{topic}/#" if topic else "#"

    def _async_ovms_entry_changed(
        self, change: ConfigEntryChange, entry: ConfigEntry
    ) -> None:
        """Synchronize immediately when an OVMS config entry changes."""
        if self._started and entry.domain == OVMS_DOMAIN:
            self._hass.async_create_task(self._async_sync_ovms_entries())

    @staticmethod
    def _mqtt_config_signature(config: dict[str, Any]) -> tuple[Any, ...]:
        """Build a stable config signature for MQTT client restarts."""
        return (
            config.get("host"),
            config.get("port"),
            config.get("protocol"),
            config.get("username"),
            config.get("password"),
            config.get("verify_ssl", True),
            config.get("topic_prefix", "ovms"),
            config.get("topic_structure"),
            config.get("vehicle_id"),
        )

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

    async def _async_mqtt_message(
        self, message, vehicle_id: str | None = None
    ) -> None:
        """Handle OVMS event and metric messages."""
        parts = message.topic.split("/")
        if "event" in parts:
            marker = parts.index("event")
        elif "metric" in parts:
            marker = parts.index("metric")
        else:
            return
        if marker < 1:
            return
        vehicle_id = vehicle_id or parts[marker - 1]
        if self._allowed_vehicle_ids and vehicle_id not in self._allowed_vehicle_ids:
            return
        if "event" in parts:
            event_index = parts.index("event")
            event = "/".join(parts[event_index + 1:])
            if event == "vehicle/on":
                await self._async_start_trip(vehicle_id)
            elif event == "vehicle/off":
                await self._async_stop_trip(vehicle_id)
            return

        if "metric" not in parts:
            return
        metric_index = parts.index("metric")
        metric = "/".join(parts[metric_index + 1:])
        value = message.payload.decode(
            errors="replace").strip().replace("km", "")
        if metric in {"v/e/on", "v.e.on"}:
            if value.lower() in {"yes", "on", "1", "true"}:
                await self._async_start_trip(vehicle_id)
            elif value.lower() in {"no", "off", "0", "false"}:
                await self._async_stop_trip(vehicle_id)
            return
        await self._async_update_metric(vehicle_id, metric, value)

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
