import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AuthService, ClientInfo } from './auth-service.js';

export const SESSION_COOKIE = 'mb_session';

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** Cookie path: the HA Ingress prefix when behind Ingress, so the cookie is not sent to the rest of HA. */
function cookiePath(req: Request): string {
  const ingress = req.get('X-Ingress-Path');
  return ingress ? `${ingress.replace(/\/$/, '')}/` : '/';
}

/** Secure only when the browser is on HTTPS (a Secure cookie on a plain-HTTP HA would be dropped). */
function isHttps(req: Request): boolean {
  return req.secure || (req.get('X-Forwarded-Proto') ?? '').split(',')[0].trim() === 'https';
}

export function setSessionCookie(req: Request, res: Response, token: string, maxAgeMs: number): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: isHttps(req),
    path: cookiePath(req),
    maxAge: maxAgeMs,
  });
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: isHttps(req), path: cookiePath(req) });
}

export const clientInfo = (req: Request): ClientInfo => ({ ip: req.ip ?? null, userAgent: req.get('User-Agent') ?? null });

/**
 * Protects every /api route except auth endpoints and the health check (used by the HA watchdog).
 * Valid sessions slide forward; the cookie is re-issued when the expiry moves.
 */
export function authGate(auth: AuthService, enabled: boolean): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!enabled || req.path.startsWith('/auth/') || req.path === '/health') return next();
    try {
      const token = readCookie(req, SESSION_COOKIE);
      const { ok, refreshed } = await auth.validate(token);
      if (!ok) {
        res.status(401).json({ error: 'Reikia prisijungti', code: 'auth_required' });
        return;
      }
      if (refreshed && token) setSessionCookie(req, res, token, auth.sessionMaxAgeMs);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** IP layer of brute-force protection (the per-account lockout lives in AuthService / DB). */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Per daug bandymų iš šio adreso. Bandykite po 15 min.', code: 'rate_limited' },
});

/** Basic security headers. frame-ancestors 'self' keeps the HA Ingress iframe working (same origin). */
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
  );
  next();
};
