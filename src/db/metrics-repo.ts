import { METRIC_KEYS, type MinerMetrics } from '../miners/types.js';
import type { Pool } from './pool.js';

export interface MetricRow {
  time: Date;
  deviceId: string;
  online: boolean;
  metrics: MinerMetrics | null;
}

export type StoredMetrics = Record<string, unknown> & { time: Date; device_id: string };

const COLUMNS = ['time', 'device_id', 'online', ...METRIC_KEYS, 'errors', 'extra'];

export const metricsRepo = {
  /** Batch insert via unnest() - a single statement for the whole poll cycle. */
  async insertBatch(pool: Pool, rows: MetricRow[]): Promise<void> {
    if (rows.length === 0) return;
    const params: unknown[] = [
      rows.map((r) => r.time),
      rows.map((r) => r.deviceId),
      rows.map((r) => r.online),
      ...METRIC_KEYS.map((k) => rows.map((r) => r.metrics?.[k] ?? null)),
      rows.map((r) => (r.metrics?.errors.length ? r.metrics.errors.join('; ') : null)),
      rows.map((r) => (r.metrics?.details ? JSON.stringify(r.metrics.details) : null)),
    ];
    const casts = ['timestamptz[]', 'text[]', 'boolean[]', ...METRIC_KEYS.map(() => 'float8[]'), 'text[]', 'jsonb[]'];
    const unnestArgs = casts.map((c, i) => `$${i + 1}::${c}`).join(', ');
    await pool.query(`INSERT INTO miner_metrics (${COLUMNS.join(', ')}) SELECT * FROM unnest(${unnestArgs})`, params);
  },

  /** Last successful sample per device (used to warm the in-memory cache on startup). */
  async latestPerDevice(pool: Pool): Promise<StoredMetrics[]> {
    const { rows } = await pool.query<StoredMetrics>(
      `SELECT DISTINCT ON (device_id) *
       FROM miner_metrics
       WHERE time > now() - INTERVAL '1 hour' AND online
       ORDER BY device_id, time DESC`,
    );
    return rows;
  },

  /** Last coolant flow estimate per device within `hours` (miners not hashing produce none). */
  async lastFlow(pool: Pool, hours: number): Promise<Array<{ device_id: string; time: Date; coolant_flow_lpm: number }>> {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (device_id) device_id, time, coolant_flow_lpm
       FROM miner_metrics
       WHERE coolant_flow_lpm IS NOT NULL AND time > now() - make_interval(hours => $1::int)
       ORDER BY device_id, time DESC`,
      [hours],
    );
    return rows;
  },

  /** Fleet totals per bucket: per-device average first, then summed (robust to missing samples). */
  async fleetHistory(pool: Pool, hours: number, bucketSeconds: number) {
    const { rows } = await pool.query(
      `WITH per AS (
         SELECT time_bucket(make_interval(secs => $1::float8), time) AS bucket, device_id,
                avg(hashrate_ths) AS hr, avg(power_w) AS pw, bool_or(online) AS up
         FROM miner_metrics
         WHERE time > now() - make_interval(hours => $2::int)
           AND device_id IN (SELECT id FROM devices WHERE active)
         GROUP BY bucket, device_id)
       SELECT bucket,
              sum(hr)::float8                         AS hashrate_ths,
              sum(pw)::float8                         AS power_w,
              (count(*) FILTER (WHERE up))::int       AS online
       FROM per GROUP BY bucket ORDER BY bucket`,
      [bucketSeconds, hours],
    );
    return rows;
  },

  /** Per-device hashrate series for card sparklines. */
  async sparklines(pool: Pool, hours: number, bucketSeconds: number): Promise<Record<string, Array<[string, number | null]>>> {
    const { rows } = await pool.query<{ device_id: string; bucket: Date; hr: number | null }>(
      `SELECT device_id, time_bucket(make_interval(secs => $1::float8), time) AS bucket, avg(hashrate_ths)::float8 AS hr
       FROM miner_metrics
       WHERE time > now() - make_interval(hours => $2::int)
       GROUP BY device_id, bucket ORDER BY device_id, bucket`,
      [bucketSeconds, hours],
    );
    const out: Record<string, Array<[string, number | null]>> = {};
    for (const r of rows) (out[r.device_id] ??= []).push([new Date(r.bucket).toISOString(), r.hr === null ? null : Math.round(r.hr * 100) / 100]);
    return out;
  },

  async history(pool: Pool, deviceId: string, hours: number, bucketSeconds: number) {
    const { rows } = await pool.query(
      `SELECT time_bucket(make_interval(secs => $2::float8), time) AS bucket,
              avg(hashrate_ths)                         AS hashrate_ths,
              max(temp_max_c)                           AS temp_max_c,
              avg(power_w)                              AS power_w,
              avg(fan_rpm_avg)                          AS fan_rpm_avg,
              max(temp_avg_c)                           AS temp_avg_c,
              avg(water_in_c)                           AS water_in_c,
              avg(water_out_c)                          AS water_out_c,
              avg(coolant_flow_lpm)                     AS coolant_flow_lpm,
              avg(efficiency_jth)                       AS efficiency_jth,
              max((extra->>'nominal_ths')::float8)      AS nominal_ths,
              avg(CASE WHEN online THEN 1 ELSE 0 END)::float8 AS uptime_ratio,
              max(rejected)                             AS rejected,
              max(accepted)                             AS accepted
       FROM miner_metrics
       WHERE device_id = $1 AND time > now() - make_interval(hours => $3::int)
       GROUP BY bucket
       ORDER BY bucket`,
      [deviceId, bucketSeconds, hours],
    );
    return rows;
  },
};
