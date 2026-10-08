import { Router } from 'express';
import type { DevicePatch } from '../../db/devices-repo.js';
import { metricsRepo } from '../../db/metrics-repo.js';
import { parseRelayConfig } from '../../relays/relay.js';
import { isInLayout, type Layout } from '../../settings/settings-service.js';
import { HttpError } from '../../util/http-error.js';
import type { AppContext } from '../context.js';

function parsePatch(body: unknown, layout: Layout): DevicePatch {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: DevicePatch = {};
  if ('name' in b) {
    if (b.name !== null && typeof b.name !== 'string') throw new HttpError(400, 'name must be a string or null');
    patch.name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 100) : null;
  }
  if ('active' in b) {
    if (typeof b.active !== 'boolean') throw new HttpError(400, 'active must be boolean');
    patch.active = b.active;
  }
  if ('relay' in b) patch.relay = b.relay === null ? null : parseRelayConfig(b.relay);
  if ('location' in b) {
    if (b.location === null) patch.location = null;
    else {
      const l = b.location as Record<string, unknown>;
      const loc = { rack: Number(l?.rack), shelf: Number(l?.shelf), slot: Number(l?.slot) };
      if (![loc.rack, loc.shelf, loc.slot].every(Number.isInteger) || !isInLayout(layout, loc)) {
        throw new HttpError(400, 'Tokios vietos konteinerio išdėstyme nėra');
      }
      patch.location = loc;
    }
  }
  return patch;
}

export function devicesRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/', async (_req, res) => {
    res.json(await ctx.devices.list());
  });

  r.get('/:id', async (req, res) => {
    res.json(await ctx.devices.get(req.params.id));
  });

  r.patch('/:id', async (req, res) => {
    res.json(await ctx.devices.update(req.params.id, parsePatch(req.body, ctx.settings.layout)));
  });

  r.delete('/:id', async (req, res) => {
    await ctx.devices.remove(req.params.id);
    res.status(204).end();
  });

  r.post('/:id/commands', async (req, res) => {
    const command = (req.body as { command?: unknown })?.command;
    if (typeof command !== 'string' || !command) throw new HttpError(400, 'command is required');
    await ctx.devices.executeCommand(req.params.id, command, 'api');
    res.json({ ok: true });
  });

  /** GET /api/devices/:id/metrics?hours=24&bucket=300 -> time_bucket aggregates */
  r.get('/:id/metrics', async (req, res) => {
    const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 90);
    const bucket = Math.max(Number(req.query.bucket) || Math.ceil((hours * 3600) / 300), 15);
    res.json(await metricsRepo.history(ctx.pool, req.params.id, hours, bucket));
  });

  return r;
}
