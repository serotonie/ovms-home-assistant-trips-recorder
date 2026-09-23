import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from mqtt_callbacks import current_wp_update


def test_current_wp_update_updates_last_seen_on_utc():
    class DummyModel:
        def __init__(self):
            self.module_id = 'veh-1'
            self.last_seen = None
            self.saved = False

        def save(self):
            self.saved = True

    class DummyWaypoint:
        pass

    vehicle = SimpleNamespace(model=DummyModel(), current_waypoint=DummyWaypoint())

    current_wp_update(b'2024-01-01 00:00:00 UTC', vehicle, 'utc')

    assert vehicle.model.last_seen is not None
