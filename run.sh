#!/bin/sh
# Add-on entrypoint. Options from /data/options.json are read directly by src/config.ts.
set -e

if [ -f /data/options.json ]; then
  echo "[run.sh] Home Assistant add-on mode (/data/options.json found)"
else
  echo "[run.sh] Standalone mode (configuration from environment variables)"
fi

cd /app
exec node dist/index.js
