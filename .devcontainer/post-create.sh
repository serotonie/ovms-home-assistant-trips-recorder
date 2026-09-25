#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OVMS_DIR="$ROOT/dev/ovms-home-assistant"

if [[ ! -d "$OVMS_DIR/custom_components/ovms" ]]; then
  git clone https://github.com/enoch85/ovms-home-assistant.git "$OVMS_DIR"
fi

sudo rm -f /etc/apt/sources.list.d/yarn.list
sudo apt-get update
sudo apt-get install -y --no-install-recommends mosquitto-clients
python -m pip install --user -r requirements.txt
