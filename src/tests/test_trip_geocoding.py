import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from database import models


class DummyGeocoder:
    def reverse(self, position):
        return SimpleNamespace(raw={'address': {'house_number': '12', 'road': 'Main', 'town': 'Town', 'postcode': '12345', 'country': 'Country'}})


def test_pre_save_populates_trip_address(monkeypatch):
    monkeypatch.setattr(models, 'geocoder', DummyGeocoder())

    trip = models.Trip(
        distance=1.0,
        start_point_lat=48.8566,
        start_point_long=2.3522,
        start_time='2024-01-01T00:00:00',
        stop_time='2024-01-01T00:30:00',
        vehicle_id=1,
        user_id=1,
    )

    models.on_save_handler(models.Trip, trip, True)

    assert trip.start_house_number == '12'
    assert trip.start_road == 'Main'
    assert trip.start_village == 'Town'
    assert trip.start_postcode == '12345'
    assert trip.start_country == 'Country'
