import { Router } from 'express';
import { metricsRepo } from '../../db/metrics-repo.js';
import type { AppContext } from '../context.js';

const clampHours = (v: unknown, def: number) => Math.min(Math.max(Number(v) || def, 1), 72);
/** ~120 points per chart, never finer than one poll interval. */
const autoBucket = (hours: number, minS: number) => Math.max(Math.ceil((hours * 3600) / 120), minS);

export function fleetRouter(ctx: AppContext): Router {
  const r = Router();
  const minBucket = Math.max(ctx.config.poll.intervalMs / 1000, 15);

  /** GET /api/fleet/history?hours=24 -> [{bucket, hashrate_ths, power_w, online}] */
  r.get('/history', async (req, res) => {
    const hours = clampHours(req.query.hours, 24);
    res.json(await metricsRepo.fleetHistory(ctx.pool, hours, autoBucket(hours, minBucket)));
  });

  /** GET /api/fleet/sparklines?hours=6 -> { deviceId: [[iso, ths], ...] } */
  r.get('/sparklines', async (req, res) => {
    const hours = clampHours(req.query.hours, 6);
    res.json(await metricsRepo.sparklines(ctx.pool, hours, Math.max(Math.ceil((hours * 3600) / 48), minBucket)));
  });

  return r;
}
