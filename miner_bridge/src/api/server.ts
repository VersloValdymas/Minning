import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ROOT_DIR, type AppConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { HttpError } from '../util/http-error.js';
import { authGate, securityHeaders } from '../auth/http.js';
import { authRouter } from './routes/auth.js';
import { licenseGate, licenseRouter } from './routes/license.js';
import { devicesRouter } from './routes/devices.js';
import { earningsRouter } from './routes/earnings.js';
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
  // Only the HA Ingress proxy (and localhost) may set X-Forwarded-For -> real client IP for rate limiting / audit
  app.set('trust proxy', ['loopback', '172.30.32.2']);
  app.use(securityHeaders);

  if (cfg.http.ingressOnly) {
    app.use((req, res, next) => {
      const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      if (INGRESS_ALLOWED.has(ip)) return next();
      log.warn(`Blocked non-ingress request from ${ip}`);
      res.status(403).send('Forbidden: access only via Home Assistant Ingress');
    });
  }

  app.use(express.json({ limit: '100kb' }));

  // License gate first: when locked, only /api/health, /api/license/* and /api/auth/* pass
  app.use('/api/license', licenseRouter(ctx.license));
  app.use('/api', licenseGate(ctx.license));

  // Dashboard super-admin login: everything under /api except /api/auth/* and /api/health needs a session
  app.use('/api/auth', authRouter(ctx.auth, cfg.auth.enabled));
  app.use('/api', authGate(ctx.auth, cfg.auth.enabled));

  app.use('/api', systemRouter(ctx));
  app.use('/api/devices', devicesRouter(ctx));
  app.use('/api/scan', scanRouter(ctx));
  app.use('/api/fleet', fleetRouter(ctx));
  app.use('/api/earnings', earningsRouter(ctx));
  app.use('/api/settings', settingsRouter(ctx));
  app.use('/api/stream', streamRouter(ctx));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Dashboard. All asset URLs in public/ are relative so they work under the Ingress path prefix.
  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      const extra = err as HttpError & { remainingSeconds?: number; remainingAttempts?: number };
      res.status(err.status).json({ error: err.message, remainingSeconds: extra.remainingSeconds, remainingAttempts: extra.remainingAttempts });
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
