#!/usr/bin/env bash
set -euo pipefail

if [[ ! -d ../ovms-home-assistant/custom_components/ovms ]]; then
  git clone --depth 1 https://github.com/enoch85/ovms-home-assistant.git ../ovms-home-assistant
fi

sudo rm -f /etc/apt/sources.list.d/yarn.list
sudo apt-get update
sudo apt-get install -y --no-install-recommends mosquitto-clients
python -m pip install --user -r requirements.txt
