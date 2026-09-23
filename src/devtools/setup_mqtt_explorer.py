"""Main module"""

import logging

import sys
sys.path.insert(0, '.')

import paho.mqtt.client as mqtt

from utils.mqtt_creds import set_creds

set_creds('EXPLORER', 'EXPLORER_DEV')

mqtt_log = logging.getLogger('mqtt')
MQTTDEV = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
MQTTDEV.username_pw_set('EXPLORER', 'EXPLORER_DEV')
MQTTDEV.enable_logger(mqtt_log)