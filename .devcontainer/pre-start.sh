#!/usr/bin/env bash
set -euo pipefail

OVMS_DIR=../ovms-home-assistant
OVMS_URL=https://github.com/enoch85/ovms-home-assistant.git

if [[ -d "$OVMS_DIR" && ! -d "$OVMS_DIR/.git" ]]; then
  # Leftover non-git directory (e.g. from a previous container run as root) blocks git clone.
  rm -rf "$OVMS_DIR"
fi

if [[ ! -d "$OVMS_DIR/.git" ]]; then
  git clone "$OVMS_URL" "$OVMS_DIR"
else
  git -C "$OVMS_DIR" pull --ff-only
fi