"""Module defining the random generators"""

import string
import random


def random_str():
    """Function to generate a random string"""
    character_list = ""
    character_list += string.ascii_letters
    character_list += string.digits

    rand_str = []

    for i in range(random.randrange(12, 22)):        # pylint: disable=unused-variable
        randomchar = random.choice(character_list)
        rand_str.append(randomchar)

    return ''.join(rand_str)