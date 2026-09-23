"""Module defining the peewee models"""

from peewee import (
    BigAutoField,
    CharField,
    DateTimeField,
    FloatField,
    ForeignKeyField,
    IntegerField,
)
from playhouse.signals import Model, pre_save

from .config import DB
from utils.geocoder import geocoder


class Base(Model):
    """Defining a Base Model"""

    class Meta:
        """Metadata of Base Model"""
        database = DB
        only_save_dirty = True


class User(Base):
    """Model of user"""
    id = BigAutoField()

    class Meta:
        """Metadata of """
        table_name = 'users'


class Vehicle(Base):
    """Model of vehicle"""
    id = BigAutoField()
    last_seen = DateTimeField(null=True)
    module_id = CharField(unique=True)
    module_username = CharField(unique=True)
    main_user_id = ForeignKeyField(model=User, field='id')

    class Meta:
        """Metadata of vehicle model"""
        table_name = 'vehicles'


class Trip(Base):
    """Model of trip"""
    distance = FloatField()
    id = BigAutoField()
    start_point_lat = FloatField()
    start_point_long = FloatField()
    start_time = DateTimeField()
    start_house_number = CharField(null=True)
    start_road = CharField(null=True)
    start_village = CharField(null=True)
    start_postcode = CharField(null=True)
    start_country = CharField(null=True)
    stop_point_lat = FloatField(null=True)
    stop_point_long = FloatField(null=True)
    stop_time = DateTimeField()
    stop_house_number = CharField(null=True)
    stop_road = CharField(null=True)
    stop_village = CharField(null=True)
    stop_postcode = CharField(null=True)
    stop_country = CharField(null=True)
    vehicle_id = ForeignKeyField(model=Vehicle, field='id')
    user_id = ForeignKeyField(model=User, field='id')

    class Meta:
        """Metadata for Trip Model"""
        table_name = 'trips'


@pre_save(sender=Trip)
def on_save_handler(model_class, instance, created):  # pylint: disable=unused-argument
    """Function executed before Trip is saved in db"""
    if (
        (instance.start_point_lat is not None and instance.start_point_lat != -1)
        and
        (instance.start_point_long is not None and instance.start_point_long != -1)
    ):
        address = geocoder.reverse((instance.start_point_lat, instance.start_point_long)).raw['address']
        instance.start_house_number = address.get('house_number', '-1')
        instance.start_road = address.get('road', '-1')
        instance.start_village = address.get('town', address.get('village', address.get('city', '-1')))
        instance.start_postcode = address.get('postcode', '-1')
        instance.start_country = address.get('country', '-1')

    if (
        (instance.stop_point_lat is not None and instance.stop_point_lat != -1)
        and
        (instance.stop_point_long is not None and instance.stop_point_long != -1)
    ):
        address = geocoder.reverse((instance.stop_point_lat, instance.stop_point_long)).raw['address']
        instance.stop_house_number = address.get('house_number', '-1')
        instance.stop_road = address.get('road', '-1')
        instance.stop_village = address.get('village', address.get('city', '-1'))
        instance.stop_postcode = address.get('postcode', '-1')
        instance.stop_country = address.get('country', '-1')


class Waypoint(Base):
    """Model of waypoint"""
    timestamp = DateTimeField(null=True)
    distance = FloatField()
    gpshdop = FloatField(null=True)
    id = BigAutoField()
    odometer = IntegerField()
    position_lat = FloatField()
    position_long = FloatField()
    trip = ForeignKeyField(column_name='trip_id', field='id', model=Trip)

    class Meta:
        """Metadata for Waypoint Model"""
        table_name = 'waypoints'