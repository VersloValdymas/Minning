import { Router } from 'express';
import { coolantProperties } from '../../health/coolant.js';
import { bus } from '../../events.js';
import { parseCoolantSettings, parseLayout } from '../../settings/settings-service.js';
import type { AppContext } from '../context.js';

export function settingsRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/', (_req, res) => {
    res.json(ctx.settings.describe());
  });

  /** Container layout: racks (each = own pump loop) × shelves × slots. */
  r.get('/layout', (_req, res) => {
    res.json(ctx.settings.layout);
  });

  r.put('/layout', async (req, res) => {
    const layout = await ctx.settings.saveLayout(parseLayout(req.body));
    await ctx.devices.publishAllDiscovery(); // HA areas follow rack names
    bus.publish('device.changed', {}); // shelf numbers may have been flipped
    res.json(layout);
  });

  /** Derived properties for a candidate setting - nothing is saved (live preview in the dashboard). */
  r.post('/coolant/preview', (req, res) => {
    const s = parseCoolantSettings(req.body);
    res.json(coolantProperties({ ...ctx.config.coolant, ...s }));
  });

  r.put('/coolant', async (req, res) => {
    const recalculated = await ctx.settings.saveCoolant(parseCoolantSettings(req.body));
    await ctx.devices.reloadLastFlow();
    res.json({ ...ctx.settings.describe(), recalculated });
  });

  /** Back to env / add-on option defaults. */
  r.delete('/coolant', async (_req, res) => {
    const recalculated = await ctx.settings.resetCoolant();
    await ctx.devices.reloadLastFlow();
    res.json({ ...ctx.settings.describe(), recalculated });
  });

  return r;
}
