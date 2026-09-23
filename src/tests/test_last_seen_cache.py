import os
import sys
from datetime import datetime

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from utils import last_seen as last_seen_module


@pytest.fixture(autouse=True)
def clear_redis_state():
    last_seen_module.REDIS.delete('vehicle:last_seen:veh-1')
    last_seen_module._PENDING_UPDATES.clear()
    last_seen_module._FLUSH_TIMER = None
    yield
    last_seen_module.REDIS.delete('vehicle:last_seen:veh-1')
    last_seen_module._PENDING_UPDATES.clear()
    last_seen_module._FLUSH_TIMER = None


def test_cache_last_seen_stores_value_in_redis():
    timestamp = datetime(2024, 1, 1, 12, 0, 0)
    last_seen_module.cache_last_seen('veh-1', timestamp)

    stored_value = last_seen_module.REDIS.get('vehicle:last_seen:veh-1')

    assert stored_value == timestamp.isoformat().encode('utf-8')
    assert last_seen_module._PENDING_UPDATES['veh-1'] == timestamp
