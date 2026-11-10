#!/bin/bash
set -euo pipefail
BRIDGES_LAUNCH_DIR=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd)
exec /bin/bash "$BRIDGES_LAUNCH_DIR/bridges-client.sh" deploy octopus-groundstation
