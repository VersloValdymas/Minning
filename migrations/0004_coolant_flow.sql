-- 0004: estimated coolant flow (L/min) derived from power and water ΔT (hydro miners)

ALTER TABLE miner_metrics ADD COLUMN IF NOT EXISTS coolant_flow_lpm DOUBLE PRECISION;

-- Backfill recent rows with the same heat-balance formula as the poller (water cp = 4186 J/kg·K).
-- Limited to 7 days so already-compressed chunks are not touched.
UPDATE miner_metrics
SET coolant_flow_lpm = round((power_w / (4186 * (water_out_c - water_in_c)) * 60)::numeric, 1)
WHERE time > now() - INTERVAL '7 days'
  AND coolant_flow_lpm IS NULL
  AND power_w >= 1000
  AND water_in_c IS NOT NULL AND water_out_c IS NOT NULL
  AND water_out_c - water_in_c >= 2;
