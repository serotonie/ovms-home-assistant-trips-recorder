"""Module defining usefull function for the topic analysis"""

from functools import cache


@cache
def vhc_id_from_topic(topic):
    """Function to get the vehicle id from the topic"""
    return topic.split('/')[2]