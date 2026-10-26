import { Router } from 'express';
import type { AppContext } from '../context.js';

export function earningsRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/', (_req, res) => {
    res.json(ctx.earnings.current);
  });

  /** Set electricity price (EUR/kWh) from the dashboard. */
  r.put('/electricity', async (req, res) => {
    const value = Number((req.body as { value?: unknown })?.value);
    await ctx.earnings.setElectricity(value);
    res.json(ctx.earnings.current);
  });

  /** Force a refresh (after entering the token / price). */
  r.post('/refresh', async (_req, res) => {
    res.json(await ctx.earnings.refresh());
  });

  return r;
}
