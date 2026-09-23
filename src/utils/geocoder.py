"""Module defining custom geocoding classes"""

import time

import pygeohash as pgh
import geopy
import redisshelve

from setup.constants import NOMINATIM_CACHE_TTL
from database.config import REDIS

class CachedGeocoder:
    """Class to enable cacheing of geocoding results"""
    def __init__(self):
        self.geocoder = geopy.Nominatim(user_agent='ovms-admin')
        self.db = redisshelve.open(REDIS, writeback = True)
        self.ts = time.time()+1.1
    def reverse(self, position):
        """Function to reverse geocode a position"""
        pos_hash = pgh.encode(float(position[0]), float(position[1]), precision=10)
        if pos_hash not in self.db:
            time.sleep(max(1 -(time.time() - self.ts), 0))
            self.ts = time.time()
            self.db[pos_hash] = self.geocoder.reverse(pgh.decode(pos_hash))
            REDIS.expire(pos_hash, NOMINATIM_CACHE_TTL)
        return self.db[pos_hash]

geocoder = CachedGeocoder()
