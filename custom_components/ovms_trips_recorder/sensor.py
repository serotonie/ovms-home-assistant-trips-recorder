"""Sensors for recorded trip counts."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DATA_TRIP_STORE, DOMAIN, OVMS_DOMAIN, TRIP_UPDATED_EVENT


def _count_completed_trips(trips: list[dict[str, Any]], vehicle_id: str) -> int:
    """Count finalized trips for one vehicle."""
    return sum(
        trip.get("vehicle") == vehicle_id and bool(trip.get("stop_time"))
        for trip in trips
    )


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up one recorded-trip counter for each configured OVMS vehicle."""
    ovms_entries = hass.config_entries.async_entries(OVMS_DOMAIN)
    sensors = []
    for ovms_entry in ovms_entries:
        config = {**ovms_entry.data, **ovms_entry.options}
        ovms_data = hass.data.get(OVMS_DOMAIN, {}).get(ovms_entry.entry_id, {})
        client_config = getattr(ovms_data.get("mqtt_client"), "config", None)
        if isinstance(client_config, dict):
            config.update(client_config)

        vehicle_id = str(config.get("vehicle_id", "")).strip()
        if vehicle_id:
            sensors.append(RecordedTripsSensor(hass, vehicle_id, config))

    async_add_entities(sensors)


class RecordedTripsSensor(SensorEntity):
    """Count completed trips for one OVMS vehicle."""

    _attr_has_entity_name = True
    _attr_name = "Recorded trips"
    _attr_icon = "mdi:car"
    _attr_native_unit_of_measurement = "trips"
    _attr_state_class = SensorStateClass.TOTAL_INCREASING

    def __init__(
        self, hass: HomeAssistant, vehicle_id: str, config: dict[str, Any]
    ) -> None:
        """Initialize the trip counter."""
        self._hass = hass
        self._vehicle_id = vehicle_id
        client_id = config.get("client_id")
        identifier = str(client_id) if client_id else vehicle_id.lower()
        self._attr_unique_id = f"{identifier}_recorded_trips"
        self._attr_device_info = {
            "identifiers": {(OVMS_DOMAIN, identifier)},
            "name": vehicle_id,
            "manufacturer": "Open Vehicles",
            "model": "OVMS Module",
        }
        self._attr_native_value = 0
        self._remove_event_listener = None

    async def async_added_to_hass(self) -> None:
        """Load the initial count and listen for trip store updates."""
        await super().async_added_to_hass()
        self._remove_event_listener = self._hass.bus.async_listen(
            TRIP_UPDATED_EVENT, self._handle_trip_update
        )
        await self._async_update_from_store()

    async def async_will_remove_from_hass(self) -> None:
        """Unsubscribe from trip store updates."""
        if self._remove_event_listener is not None:
            self._remove_event_listener()
            self._remove_event_listener = None
        await super().async_will_remove_from_hass()

    @callback
    def _handle_trip_update(self, event: Event) -> None:
        """Update the count when the store changes."""
        trips = event.data.get("trips", [])
        self._attr_native_value = _count_completed_trips(
            trips, self._vehicle_id)
        self.async_write_ha_state()

    async def _async_update_from_store(self) -> None:
        """Initialize the count from persisted trips."""
        store = self._hass.data.get(DOMAIN, {}).get(DATA_TRIP_STORE)
        trips = await store.async_get_trips() if store else []
        self._attr_native_value = _count_completed_trips(
            trips, self._vehicle_id)
