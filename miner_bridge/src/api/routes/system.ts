import { Router } from 'express';
import { eventsRepo } from '../../db/events-repo.js';
import { listDrivers } from '../../miners/index.js';
import { coolantProperties } from '../../health/coolant.js';
import type { AppContext } from '../context.js';

export function systemRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/health', async (_req, res) => {
    let db = true;
    try {
      await ctx.pool.query('SELECT 1');
    } catch {
      db = false;
    }
    res.status(db ? 200 : 503).json({ ok: db, db, mqtt: ctx.mqtt.connected, uptimeS: Math.round(process.uptime()) });
  });

  r.get('/info', (_req, res) => {
    res.json({
      version: ctx.config.appVersion,
      addon: ctx.config.isAddon,
      mqtt: { enabled: ctx.mqtt.enabled, connected: ctx.mqtt.connected },
      pollIntervalS: ctx.config.poll.intervalMs / 1000,
      thresholds: ctx.config.alerts,
      coolant: coolantProperties(ctx.config.coolant),
      vnishAuth: Boolean(ctx.config.vnish.apiKey || ctx.config.vnish.password),
      lastCycle: ctx.poller.stats,
      drivers: listDrivers().map((d) => ({ name: d.name, label: d.label, defaultPort: d.defaultPort, commands: d.commands })),
    });
  });

  r.get('/events', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const deviceId = typeof req.query.device === 'string' ? req.query.device : undefined;
    res.json(await eventsRepo.recent(ctx.pool, limit, deviceId));
  });

  return r;
}
