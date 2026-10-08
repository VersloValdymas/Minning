-- 0002: water inlet/outlet temperatures (hydro-cooled miners, e.g. Antminer S21+ Hydro on Vnish)

ALTER TABLE miner_metrics ADD COLUMN IF NOT EXISTS water_in_c DOUBLE PRECISION;
ALTER TABLE miner_metrics ADD COLUMN IF NOT EXISTS water_out_c DOUBLE PRECISION;
