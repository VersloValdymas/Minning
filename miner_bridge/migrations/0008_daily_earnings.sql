-- 0008: daily economics snapshot for cumulative profit and ROI

CREATE TABLE IF NOT EXISTS daily_earnings (
  day               DATE PRIMARY KEY,          -- UTC date
  revenue_eur       DOUBLE PRECISION NOT NULL DEFAULT 0,
  miner_cost_eur    DOUBLE PRECISION NOT NULL DEFAULT 0,
  overhead_cost_eur DOUBLE PRECISION NOT NULL DEFAULT 0,
  btc               DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
