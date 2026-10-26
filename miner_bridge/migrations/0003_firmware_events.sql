-- 0003: firmware-reported events (overheat, chain break...) imported from miner logs, deduplicated

ALTER TABLE device_events ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'app';
ALTER TABLE device_events ADD COLUMN IF NOT EXISTS code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS device_events_firmware_uq
  ON device_events (device_id, time, code) WHERE source = 'firmware';
