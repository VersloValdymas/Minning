#!/bin/sh
# Add-on entrypoint.
#  - db_mode "embedded" (default): runs PostgreSQL/TimescaleDB inside this container, data in /data/postgres.
#    Listens only on a unix socket - not reachable from the network.
#  - db_mode "external": uses db_host/db_port/... from the add-on options (or DATABASE_URL).
# Supervises both processes: if either exits, the other is stopped and the container exits
# (HA restarts the add-on). On SIGTERM: stop the app first, then PostgreSQL cleanly.
set -eu

OPTIONS=/data/options.json
PGDATA=/data/postgres
PGSOCK=/run/postgresql
DB_NAME=miners

log() { echo "[run.sh] $*"; }

opt() {
  # opt <key> <default>: read a value from the HA add-on options (node is available, jq is not)
  [ -f "$OPTIONS" ] || { echo "$2"; return; }
  node -e "const o=JSON.parse(require('fs').readFileSync('$OPTIONS','utf8')); const v=o['$1']; process.stdout.write(v===undefined||v===null||v===''?'$2':String(v))"
}

if [ -f "$OPTIONS" ]; then log "Home Assistant add-on mode"; else log "Standalone mode"; fi

DB_MODE="${DB_MODE:-$(opt db_mode embedded)}"
PG_PID=""

if [ "$DB_MODE" = "embedded" ] && [ -z "${DATABASE_URL:-}" ]; then
  mkdir -p "$PGDATA" "$PGSOCK"
  chown -R postgres:postgres "$PGDATA" "$PGSOCK"
  chmod 700 "$PGDATA"

  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    log "First start: initialising embedded TimescaleDB in $PGDATA"
    gosu postgres initdb -D "$PGDATA" -U postgres -E UTF8 --no-locale --auth-local=trust --auth-host=reject >/dev/null
    cat >> "$PGDATA/postgresql.conf" <<'CONF'

# --- Miner Bridge embedded settings ---
listen_addresses = ''
shared_preload_libraries = 'timescaledb'
timescaledb.telemetry_level = off
shared_buffers = 128MB
work_mem = 8MB
maintenance_work_mem = 64MB
max_connections = 30
wal_compression = on
max_wal_size = 512MB
log_min_messages = warning
CONF
  fi

  log "Starting embedded PostgreSQL"
  gosu postgres postgres -D "$PGDATA" -k "$PGSOCK" &
  PG_PID=$!

  i=0
  until gosu postgres pg_isready -q -h "$PGSOCK"; do
    i=$((i + 1))
    if [ "$i" -gt 60 ] || ! kill -0 "$PG_PID" 2>/dev/null; then
      log "PostgreSQL did not start"; exit 1
    fi
    sleep 1
  done

  if ! gosu postgres psql -h "$PGSOCK" -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1; then
    log "Creating database $DB_NAME"
    gosu postgres createdb -h "$PGSOCK" "$DB_NAME"
  fi
  export DATABASE_URL="postgresql://postgres@/$DB_NAME?host=$PGSOCK"
else
  log "Using external database"
fi

cd /app
node dist/index.js &
APP_PID=$!

shutdown() {
  log "Stopping"
  kill -TERM "$APP_PID" 2>/dev/null || true
  wait "$APP_PID" 2>/dev/null || true
  if [ -n "$PG_PID" ]; then
    kill -INT "$PG_PID" 2>/dev/null || true # fast shutdown, clean checkpoint
    wait "$PG_PID" 2>/dev/null || true
  fi
  exit 0
}
trap shutdown TERM INT

# Supervise: exit (non-zero) as soon as one of the processes dies
while kill -0 "$APP_PID" 2>/dev/null && { [ -z "$PG_PID" ] || kill -0 "$PG_PID" 2>/dev/null; }; do
  sleep 2 &
  wait $! || true
done

log "A process exited unexpectedly - stopping the add-on so Home Assistant can restart it"
kill -TERM "$APP_PID" 2>/dev/null || true
[ -n "$PG_PID" ] && kill -INT "$PG_PID" 2>/dev/null || true
wait 2>/dev/null || true
exit 1
