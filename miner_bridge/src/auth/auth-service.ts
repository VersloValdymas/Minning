import { createHash, randomBytes } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { eventsRepo } from '../db/events-repo.js';
import type { Pool } from '../db/pool.js';
import { createLogger } from '../logger.js';
import { HttpError } from '../util/http-error.js';
import { hashPassword, passwordProblem, verifyPassword } from './password.js';

const log = createLogger('auth');

/** Escalating lockout: after N consecutive failures the account is locked for the given duration. */
const LOCKOUT_STEPS: Array<{ failures: number; minutes: number }> = [
  { failures: 15, minutes: 24 * 60 },
  { failures: 10, minutes: 60 },
  { failures: 5, minutes: 15 },
];

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Single super-admin account for the dashboard.
 * Login flow order (matters): lockout check -> reset expired lock -> verify password -> count failure / create session.
 */
export class AuthService {
  private readonly idleMs: number;

  constructor(
    private readonly pool: Pool,
    cfg: AppConfig['auth'],
  ) {
    this.idleMs = cfg.sessionIdleDays * 24 * 3600 * 1000;
  }

  get sessionMaxAgeMs(): number {
    return this.idleMs;
  }

  async isSetUp(): Promise<boolean> {
    const { rows } = await this.pool.query('SELECT 1 FROM auth_admin WHERE id = 1');
    return rows.length > 0;
  }

  private async audit(event: string, client: ClientInfo, detail?: string): Promise<void> {
    await this.pool
      .query('INSERT INTO auth_audit (event, ip, user_agent, detail) VALUES ($1, $2, $3, $4)', [event, client.ip, client.userAgent?.slice(0, 300) ?? null, detail ?? null])
      .catch(() => undefined);
    const level = event === 'LOGIN_FAILED' || event === 'LOGIN_BLOCKED' ? 'warn' : event === 'ACCOUNT_LOCKED' || event === 'PASSWORD_RESET' ? 'error' : 'info';
    const text: Record<string, string> = {
      SETUP: 'Sukurtas administratoriaus slaptažodis',
      LOGIN: 'Prisijungta prie dashboard',
      LOGIN_FAILED: 'Nesėkmingas prisijungimas',
      ACCOUNT_LOCKED: 'Prisijungimas užrakintas po kelių nesėkmių',
      LOGIN_BLOCKED: 'Bandymas prisijungti, kol užrakinta',
      LOGOUT: 'Atsijungta',
      PASSWORD_CHANGED: 'Pakeistas administratoriaus slaptažodis',
      PASSWORD_RESET: 'Administratoriaus slaptažodis atstatytas per add-on nustatymus',
    };
    await eventsRepo.add(this.pool, null, level, `🔐 ${text[event] ?? event}${detail ? ` (${detail})` : ''}${client.ip ? ` · IP ${client.ip}` : ''}`);
  }

  /** First run only: create the password. Refused once a password exists. */
  async setup(password: unknown, client: ClientInfo): Promise<string> {
    const problem = passwordProblem(password);
    if (problem) throw new HttpError(400, problem);
    const hash = await hashPassword(password as string);
    const res = await this.pool.query('INSERT INTO auth_admin (id, password_hash) VALUES (1, $1) ON CONFLICT (id) DO NOTHING', [hash]);
    if (res.rowCount === 0) throw new HttpError(409, 'Slaptažodis jau sukurtas');
    await this.audit('SETUP', client);
    log.info('Admin password created');
    return this.createSession(client);
  }

  async login(password: unknown, client: ClientInfo): Promise<string> {
    if (typeof password !== 'string' || password.length === 0) throw new HttpError(400, 'Įveskite slaptažodį');
    const { rows } = await this.pool.query<{ password_hash: string; failed_attempts: number; locked_until: Date | null }>(
      'SELECT password_hash, failed_attempts, locked_until FROM auth_admin WHERE id = 1',
    );
    const admin = rows[0];
    if (!admin) throw new HttpError(409, 'Slaptažodis dar nesukurtas');

    // 1. Locked?
    if (admin.locked_until && admin.locked_until.getTime() > Date.now()) {
      const remainingSeconds = Math.ceil((admin.locked_until.getTime() - Date.now()) / 1000);
      await this.audit('LOGIN_BLOCKED', client);
      throw Object.assign(new HttpError(423, `Per daug nesėkmingų bandymų. Bandykite po ${Math.ceil(remainingSeconds / 60)} min.`), { remainingSeconds });
    }
    // 2. Lock expired -> clear it (the failure counter is kept so repeated lockouts escalate 15 min -> 1 h -> 24 h)
    let failures = admin.failed_attempts;
    if (admin.locked_until && admin.locked_until.getTime() <= Date.now()) {
      await this.pool.query('UPDATE auth_admin SET locked_until = NULL WHERE id = 1');
    }

    // 3. Verify
    if (!(await verifyPassword(password, admin.password_hash))) {
      failures++;
      const step = LOCKOUT_STEPS.find((s) => failures >= s.failures && failures % 5 === 0);
      const lockedUntil = step ? new Date(Date.now() + step.minutes * 60_000) : null;
      await this.pool.query('UPDATE auth_admin SET failed_attempts = $1, locked_until = COALESCE($2, locked_until) WHERE id = 1', [failures, lockedUntil]);
      if (lockedUntil) {
        await this.audit('ACCOUNT_LOCKED', client, `${failures} nesėkmės, ${step!.minutes} min`);
        throw Object.assign(new HttpError(423, `Per daug nesėkmingų bandymų. Užrakinta ${step!.minutes >= 60 ? step!.minutes / 60 + ' h' : step!.minutes + ' min'}.`), {
          remainingSeconds: step!.minutes * 60,
        });
      }
      await this.audit('LOGIN_FAILED', client, `${failures} iš eilės`);
      const remainingAttempts = 5 - (failures % 5);
      throw Object.assign(new HttpError(401, `Neteisingas slaptažodis. Liko bandymų iki užrakinimo: ${remainingAttempts}`), { remainingAttempts });
    }

    // 4. Success
    await this.pool.query('UPDATE auth_admin SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = 1');
    await this.audit('LOGIN', client);
    return this.createSession(client);
  }

  private async createSession(client: ClientInfo): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.pool.query(
      `INSERT INTO auth_sessions (token_hash, expires_at, ip, user_agent) VALUES ($1, now() + make_interval(secs => $2::float8), $3, $4)`,
      [sha256(token), this.idleMs / 1000, client.ip, client.userAgent?.slice(0, 300) ?? null],
    );
    await this.pool.query('DELETE FROM auth_sessions WHERE expires_at < now()');
    return token;
  }

  /**
   * Valid session -> true, and the expiry slides forward (idle timeout). To limit writes,
   * the row is refreshed at most once per hour. Returns whether the cookie should be re-issued.
   */
  async validate(token: string | undefined): Promise<{ ok: boolean; refreshed: boolean }> {
    if (!token) return { ok: false, refreshed: false };
    const { rows } = await this.pool.query<{ last_seen_at: Date }>('SELECT last_seen_at FROM auth_sessions WHERE token_hash = $1 AND expires_at > now()', [sha256(token)]);
    if (!rows[0]) return { ok: false, refreshed: false };
    if (Date.now() - rows[0].last_seen_at.getTime() > 3600_000) {
      await this.pool.query(
        'UPDATE auth_sessions SET last_seen_at = now(), expires_at = now() + make_interval(secs => $2::float8) WHERE token_hash = $1',
        [sha256(token), this.idleMs / 1000],
      );
      return { ok: true, refreshed: true };
    }
    return { ok: true, refreshed: false };
  }

  async logout(token: string | undefined, client: ClientInfo, everywhere = false): Promise<void> {
    if (everywhere) await this.pool.query('DELETE FROM auth_sessions');
    else if (token) await this.pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [sha256(token)]);
    await this.audit('LOGOUT', client, everywhere ? 'visuose įrenginiuose' : undefined);
  }

  /** Requires the current password; all other sessions are revoked. Returns a fresh session token. */
  async changePassword(current: unknown, next: unknown, client: ClientInfo): Promise<string> {
    await this.login(current, client); // same lockout protection as login
    const problem = passwordProblem(next);
    if (problem) throw new HttpError(400, problem);
    await this.pool.query('UPDATE auth_admin SET password_hash = $1, password_changed_at = now() WHERE id = 1', [await hashPassword(next as string)]);
    await this.pool.query('DELETE FROM auth_sessions');
    await this.audit('PASSWORD_CHANGED', client);
    return this.createSession(client);
  }

  /** Add-on option admin_password_reset: wipe the password and all sessions -> setup screen on next visit. */
  async reset(): Promise<void> {
    await this.pool.query('DELETE FROM auth_admin');
    await this.pool.query('DELETE FROM auth_sessions');
    await this.audit('PASSWORD_RESET', { ip: null, userAgent: null });
    log.warn('Admin password was reset - set a new one in the dashboard');
  }

  async sessionInfo(token: string | undefined) {
    if (!token) return null;
    const { rows } = await this.pool.query<{ created_at: Date; expires_at: Date }>(
      'SELECT created_at, expires_at FROM auth_sessions WHERE token_hash = $1 AND expires_at > now()',
      [sha256(token)],
    );
    return rows[0] ?? null;
  }
}
