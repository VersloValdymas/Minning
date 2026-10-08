-- 0001: base schema (devices registry, metrics hypertable, device event log)

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS devices (
  id                    TEXT PRIMARY KEY,           -- normalized MAC (no separators), serial, or driver_ip fallback
  mac                   TEXT,
  ip                    TEXT NOT NULL,
  port                  INTEGER NOT NULL,
  driver                TEXT NOT NULL,
  vendor                TEXT,
  model                 TEXT,
  firmware              TEXT,
  hostname              TEXT,
  name                  TEXT,                       -- user-defined display name
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  relay                 JSONB,                      -- optional power relay config
  capabilities          TEXT[] NOT NULL DEFAULT '{}', -- metric keys this device actually reports
  status                TEXT NOT NULL DEFAULT 'unknown',
  last_error            TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  first_seen            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen             TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS devices_mac_uq ON devices (mac) WHERE mac IS NOT NULL;
CREATE INDEX IF NOT EXISTS devices_ip_idx ON devices (ip);

CREATE TABLE IF NOT EXISTS miner_metrics (
  time              TIMESTAMPTZ NOT NULL,
  device_id         TEXT NOT NULL,
  online            BOOLEAN NOT NULL,
  hashrate_ths      DOUBLE PRECISION,
  hashrate_avg_ths  DOUBLE PRECISION,
  temp_max_c        DOUBLE PRECISION,
  temp_avg_c        DOUBLE PRECISION,
  fan_rpm_avg       DOUBLE PRECISION,
  power_w           DOUBLE PRECISION,
  voltage_v         DOUBLE PRECISION,
  current_a         DOUBLE PRECISION,
  efficiency_jth    DOUBLE PRECISION,
  accepted          BIGINT,
  rejected          BIGINT,
  hw_errors         BIGINT,
  uptime_s          BIGINT,
  errors            TEXT,
  extra             JSONB
);

SELECT create_hypertable('miner_metrics', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS miner_metrics_device_time_idx ON miner_metrics (device_id, time DESC);

-- Compression is a TimescaleDB community-license feature; skip silently on Apache-only builds.
DO $$
BEGIN
  ALTER TABLE miner_metrics SET (timescaledb.compress, timescaledb.compress_segmentby = 'device_id');
  PERFORM add_compression_policy('miner_metrics', INTERVAL '7 days', if_not_exists => TRUE);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Compression not enabled: %', SQLERRM;
END $$;

CREATE TABLE IF NOT EXISTS device_events (
  id         BIGSERIAL PRIMARY KEY,
  time       TIMESTAMPTZ NOT NULL DEFAULT now(),
  device_id  TEXT,
  level      TEXT NOT NULL,      -- info | warn | error
  message    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS device_events_time_idx ON device_events (time DESC);
CREATE INDEX IF NOT EXISTS device_events_device_idx ON device_events (device_id, time DESC);
