import { Router } from 'express';
import type { LicenseService } from '../../license/license-service.js';
import { createLogger } from '../../logger.js';

const log = createLogger('license');

export function licenseRouter(license: LicenseService): Router {
  const r = Router();

  /** Public: the lock screen needs this before the user is authenticated. */
  r.get('/status', (_req, res) => {
    const s = license.current;
    res.json({
      state: s.state,
      locked: s.locked,
      active: s.active,
      installId: s.installId,
      customer: s.customer,
      expiresAt: s.expiresAt,
      graceUntil: s.graceUntil,
      maxMiners: s.maxMiners,
      message: s.message,
    });
  });

  /** Activate a signed key. Public on purpose: only a validly signed key (issued by the developer) is accepted. */
  r.post('/activate', async (req, res) => {
    try {
      const status = await license.activate(req.body?.key);
      res.json({ ok: true, state: status.state, message: status.message, customer: status.customer, expiresAt: status.expiresAt });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return r;
}

/** Gate: when the license is not active, block everything except health, auth and license endpoints. */
export function licenseGate(license: LicenseService) {
  return (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
    if (req.path === '/health' || req.path.startsWith('/license/') || req.path.startsWith('/auth/')) return next();
    const s = license.current;
    if (s.active) return next();
    res.status(402).json({ error: s.message, code: 'license_locked', state: s.state, installId: s.installId });
    if (Math.random() < 0.02) log.warn(`Blocked request while locked (${s.state})`);
  };
}
