import { Router } from 'express';
import type { AuthService } from '../../auth/auth-service.js';
import { clearSessionCookie, clientInfo, loginLimiter, readCookie, SESSION_COOKIE, setSessionCookie } from '../../auth/http.js';

export function authRouter(auth: AuthService, enabled: boolean): Router {
  const r = Router();

  /** GET /api/auth/status -> { enabled, setupRequired, authenticated, expiresAt } */
  r.get('/status', async (req, res) => {
    if (!enabled) {
      res.json({ enabled: false, setupRequired: false, authenticated: true });
      return;
    }
    const token = readCookie(req, SESSION_COOKIE);
    const [setUp, session] = await Promise.all([auth.isSetUp(), auth.sessionInfo(token)]);
    res.json({ enabled: true, setupRequired: !setUp, authenticated: !!session, expiresAt: session?.expires_at ?? null, idleDays: auth.sessionMaxAgeMs / 86_400_000 });
  });

  r.post('/setup', loginLimiter, async (req, res) => {
    const token = await auth.setup(req.body?.password, clientInfo(req));
    setSessionCookie(req, res, token, auth.sessionMaxAgeMs);
    res.json({ ok: true });
  });

  r.post('/login', loginLimiter, async (req, res) => {
    const token = await auth.login(req.body?.password, clientInfo(req));
    setSessionCookie(req, res, token, auth.sessionMaxAgeMs);
    res.json({ ok: true });
  });

  r.post('/logout', async (req, res) => {
    await auth.logout(readCookie(req, SESSION_COOKIE), clientInfo(req), req.body?.everywhere === true);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  /** Requires a valid session AND the current password. Revokes all other sessions. */
  r.post('/change-password', loginLimiter, async (req, res) => {
    const { ok } = await auth.validate(readCookie(req, SESSION_COOKIE));
    if (!ok) {
      res.status(401).json({ error: 'Reikia prisijungti', code: 'auth_required' });
      return;
    }
    const token = await auth.changePassword(req.body?.current, req.body?.next, clientInfo(req));
    setSessionCookie(req, res, token, auth.sessionMaxAgeMs);
    res.json({ ok: true });
  });

  return r;
}
