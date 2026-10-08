import { Router } from 'express';
import { HttpError } from '../../util/http-error.js';
import type { AppContext } from '../context.js';

export function scanRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/', (_req, res) => {
    res.json(ctx.scanner.getStatus());
  });

  /** POST /api/scan { range: "192.168.1.1-254", driver?: "auto", port?: 4028 } */
  r.post('/', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.range !== 'string' || !b.range.trim()) throw new HttpError(400, 'range is required');
    const port = b.port === undefined || b.port === null || b.port === '' ? undefined : Number(b.port);
    const status = ctx.scanner.start({
      range: b.range.trim(),
      driver: typeof b.driver === 'string' && b.driver ? b.driver : 'auto',
      port,
    });
    res.status(202).json(status);
  });

  r.delete('/', (_req, res) => {
    res.json({ cancelled: ctx.scanner.cancel() });
  });

  return r;
}
