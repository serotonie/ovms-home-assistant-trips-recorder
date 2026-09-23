"""Module to configure the databases used"""

import os

import valkey as redis
from playhouse.db_url import connect

DB_CONNECTION = os.getenv('DB_CONNECTION') or 'mariadb'
DB_DRIVER = 'mysql' if DB_CONNECTION == 'mariadb' else DB_CONNECTION
DB_USERNAME = os.getenv('DB_USERNAME') or 'dbuser'
DB_PASSWORD = os.getenv('DB_PASSWORD') or ''
DB_HOST = os.getenv('DB_HOST') or 'mariadb'
DB_PORT = os.getenv('DB_PORT') or '3306'
DB_DATABASE = os.getenv('DB_DATABASE') or 'ovms-admin'

DB = connect(
    f'{DB_DRIVER}://{DB_USERNAME}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_DATABASE}'
)

REDIS = redis.Redis(
        os.getenv('REDIS_HOST', 'redis'),
        os.getenv('REDIS_PORT','6379'),
        int(os.getenv('REDIS_DB','2')),
        os.getenv('REDIS_PASSWORD')
)