-- 0006: physical location of a miner in the container: rack (cabinet with its own pump loop) / shelf / slot

ALTER TABLE devices ADD COLUMN IF NOT EXISTS rack INTEGER;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS shelf INTEGER;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS slot INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS devices_location_uq ON devices (rack, shelf, slot) WHERE rack IS NOT NULL;
