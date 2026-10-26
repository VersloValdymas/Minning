import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ROOT_DIR, type AppConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { HttpError } from '../util/http-error.js';
import { devicesRouter } from './routes/devices.js';
import { fleetRouter } from './routes/fleet.js';
import { scanRouter } from './routes/scan.js';
import { settingsRouter } from './routes/settings.js';
import { streamRouter } from './routes/stream.js';
import { systemRouter } from './routes/system.js';
import type { AppContext } from './context.js';

const log = createLogger('http');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

/** HA Supervisor proxies Ingress requests from this address. */
const INGRESS_ALLOWED = new Set(['172.30.32.2', '127.0.0.1', '::1']);

export function createServer(ctx: AppContext, cfg: AppConfig) {
  const app = express();
  app.disable('x-powered-by');

  if (cfg.http.ingressOnly) {
    app.use((req, res, next) => {
      const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      if (INGRESS_ALLOWED.has(ip)) return next();
      log.warn(`Blocked non-ingress request from ${ip}`);
      res.status(403).send('Forbidden: access only via Home Assistant Ingress');
    });
  }

  app.use(express.json({ limit: '100kb' }));

  app.use('/api', systemRouter(ctx));
  app.use('/api/devices', devicesRouter(ctx));
  app.use('/api/scan', scanRouter(ctx));
  app.use('/api/fleet', fleetRouter(ctx));
  app.use('/api/settings', settingsRouter(ctx));
  app.use('/api/stream', streamRouter(ctx));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Dashboard. All asset URLs in public/ are relative so they work under the Ingress path prefix.
  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: (err as Error).message });
      return;
    }
    log.error('Unhandled error', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
