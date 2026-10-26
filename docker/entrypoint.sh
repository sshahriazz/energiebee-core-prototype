#!/bin/sh
# Starts the Node app (as the node user) and nginx; the container ends if either stops,
# so the restart policy (docker run --restart / compose restart:) brings both back.
set -eu

cd /app
mkdir -p /app/data /app/data/logs /app/data/raw
chown -R node:node /app/data

# The app reads its settings from the container environment (docker --env-file / compose env_file).
# Node's --env-file is not used, so a missing .env file is fine.
if [ -z "${SUNSYNK_USERNAME:-}" ] && [ -z "${OCTOPUS_API_KEY:-}" ]; then
  echo "entrypoint: note: no SUNSYNK_USERNAME / OCTOPUS_API_KEY in the environment; the app starts without a home to sync (pass --env-file .env)" >&2
fi

su-exec node node --disable-warning=ExperimentalWarning src/server.js &
APP=$!

nginx -g 'daemon off;' &
NGINX=$!

stop() { kill -TERM "$APP" "$NGINX" 2>/dev/null || true; wait "$APP" "$NGINX" 2>/dev/null || true; exit 0; }
trap stop TERM INT

# Wait for the first of the two to exit, then stop the other and exit non-zero.
while kill -0 "$APP" 2>/dev/null && kill -0 "$NGINX" 2>/dev/null; do sleep 2; done
echo "entrypoint: a process exited (app=$(kill -0 "$APP" 2>/dev/null && echo up || echo down), nginx=$(kill -0 "$NGINX" 2>/dev/null && echo up || echo down)); stopping" >&2
kill -TERM "$APP" "$NGINX" 2>/dev/null || true
wait "$APP" "$NGINX" 2>/dev/null || true
exit 1
