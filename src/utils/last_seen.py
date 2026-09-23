"""Utility helpers to cache vehicle last_seen updates in Redis."""

from __future__ import annotations

from datetime import datetime
from threading import Timer

from database.config import REDIS

from setup.constants import LAST_SEEN_FLUSH_INTERVAL_SECONDS

_PENDING_UPDATES: dict[str, datetime] = {}
_FLUSH_INTERVAL_SECONDS = LAST_SEEN_FLUSH_INTERVAL_SECONDS
_FLUSH_TIMER: Timer | None = None


def cache_last_seen(module_id: str, timestamp: datetime | None = None) -> None:
    """Store a last_seen update in Redis and batch it for periodic flush to SQL."""
    if timestamp is None:
        timestamp = datetime.now()

    _PENDING_UPDATES[module_id] = timestamp

    global _FLUSH_TIMER
    if _FLUSH_TIMER is None or not _FLUSH_TIMER.is_alive():
        _FLUSH_TIMER = Timer(_FLUSH_INTERVAL_SECONDS, flush_pending_last_seen)
        _FLUSH_TIMER.daemon = True
        _FLUSH_TIMER.start()

    REDIS.set(f'vehicle:last_seen:{module_id}', timestamp.isoformat())


def flush_pending_last_seen() -> None:
    """Persist pending Redis updates into SQL once the batch window elapses."""
    global _FLUSH_TIMER
    _FLUSH_TIMER = None

    if not _PENDING_UPDATES:
        return

    from database.models import Vehicle

    for module_id, timestamp in list(_PENDING_UPDATES.items()):
        vehicle = Vehicle.get_or_none(Vehicle.module_id == module_id)
        if vehicle is not None:
            vehicle.last_seen = timestamp
            vehicle.save()
        _PENDING_UPDATES.pop(module_id, None)
