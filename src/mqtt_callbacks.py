"""Module defining the callbacks for the mqtt client"""

import logging
from datetime import datetime

from utils.topic import vhc_id_from_topic
from classes import Vehicle
from database.models import Vehicle as VehicleModel
from utils.last_seen import cache_last_seen

log = logging.getLogger('mqtt')

def on_connect(client, userdata, flags, reason_code, properties): # pylint: disable=unused-argument
    """Mqtt Callback when client is connected"""
    log.info("Connected with result code %s", reason_code)
    client.subscribe("ovms/+/+/event/#", 2)

def on_connect_fail(client, userdata): # pylint: disable=unused-argument
    """Mqtt Callback when client can't connect"""
    log.warning('Failed to connect to mqtt broker, I will retry')

def on_message(client, vehicles, msg):
    """Default mqtt callback when a message is received"""
    log.debug("Received message on topic %s: %s", msg.topic, msg.payload)
    vhc_id = vhc_id_from_topic(msg.topic)
    if VehicleModel.select().where(VehicleModel.module_id == vhc_id).exists():
        if not vhc_id in vehicles:
            vehicles = vehicles | {vhc_id_from_topic(msg.topic): Vehicle(vhc_id, client)}
            client.user_data_set(vehicles)

        cache_last_seen(vhc_id, datetime.now())

        if b'clock' not in msg.payload and msg.payload != b'':
            vehicles[vhc_id].send_command(
                'metrics get v.e.on',
                'vehicle_state(msg.payload, vehicles[vhc_id])'
            )

        if msg.payload == b'vehicle.on' or msg.topic.endswith('vehicle/on'):
            vehicles[vhc_id].driving = 'yes'

        if msg.payload == b'vehicle.off' or msg.topic.endswith('vehicle/off'):
            vehicles[vhc_id].driving = 'no'
    else:
        if vhc_id in vehicles:
            vehicles.pop(vhc_id)

def on_command_response(client, vehicles, msg): # pylint: disable=unused-argument
    """Callback when receiving a response to a command"""
    log.debug("Received command response on topic %s: %s", msg.topic, msg.payload)
    vhc_id = vhc_id_from_topic(msg.topic)
    command_id = msg.topic.split('/')[-1]
    exec(vehicles[vhc_id].command[command_id]['callback']) # pylint: disable=exec-used
    vehicles[vhc_id].cancel_command(command_id)

def on_wp_update(client, vehicles, msg): # pylint: disable=unused-argument
    """MQTT Calback to update the current waypoint"""
    vhc_id = vhc_id_from_topic(msg.topic)
    current_wp_update(msg.payload, vehicles[vhc_id], msg.topic.split('/')[-1])

def current_wp_update(payload, vehicle, attr):
    """Update the current waypoint"""
    setattr(vehicle.current_waypoint, attr, payload.decode().strip().replace('km', ''))

    if attr == 'utc':
        timestamp = datetime.now()
        vehicle.model.last_seen = timestamp
        cache_last_seen(vehicle.model.module_id, timestamp)

def vehicle_state(payload, vehicle):
    """Define the vehicle state (driving)"""
    vehicle.driving = payload.decode().strip()
