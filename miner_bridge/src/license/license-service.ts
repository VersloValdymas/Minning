import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { eventsRepo } from '../db/events-repo.js';
import type { Pool } from '../db/pool.js';
import { createLogger } from '../logger.js';
import { isConfiguredKey, verifyLicense, type LicensePayload } from './crypto.js';
import { LICENSE_PUBLIC_KEY } from './public-key.js';

const log = createLogger('license');

export type LicenseState =
  | 'ok' // valid and current
  | 'grace' // expired, still within the grace period (full function + warning)
  | 'expired' // past grace -> locked
  | 'invalid' // bad signature / wrong install / clock tampered -> locked
  | 'missing' // no license key -> locked
  | 'unconfigured'; // developer has not generated signing keys -> locked

export interface LicenseStatus {
  state: LicenseState;
  locked: boolean;
  /** Full function allowed (ok or grace). */
  active: boolean;
  installId: string;
  customer: string | null;
  expiresAt: string | null;
  graceUntil: string | null;
  maxMiners: number | null;
  message: string;
}

const MS_DAY = 86_400_000;

/**
 * Signed-license gate. The add-on is fully functional only with a valid license; otherwise it locks
 * (owner's choice). The key is embedded at build time; licenses are issued offline by the developer
 * (tools/issue-license.ts) and later by a license server. Enforcement is best-effort against a client
 * with host access, and is meant to go together with a written license agreement.
 */
export class LicenseService {
  private status!: LicenseStatus;
  private installId = '';

  constructor(
    private readonly pool: Pool,
    private readonly cfg: AppConfig['license'],
  ) {}

  async init(): Promise<void> {
    this.installId = await this.getOrCreateInstallId();
    await this.refresh();
  }

  get current(): LicenseStatus {
    return this.status;
  }

  get installFingerprint(): string {
    return this.installId;
  }

  private async setting(key: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ value: string }>('SELECT value FROM settings WHERE key = $1', [`license_${key}`]);
    return rows[0]?.value ?? null;
  }
  private async setSetting(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, to_jsonb($2::text)) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [`license_${key}`, value],
    );
  }

  private async getOrCreateInstallId(): Promise<string> {
    const existing = await this.setting('install_id');
    if (existing) return existing;
    const id = randomBytes(6).toString('hex').toUpperCase();
    await this.setSetting('install_id', id);
    return id;
  }

  /** Monotonic clock guard: if the system clock jumps backwards past tolerance, treat as tampered. */
  private async clockTampered(): Promise<boolean> {
    const now = Date.now();
    const seen = Number(await this.setting('clock_max')) || 0;
    if (seen && now < seen - 2 * MS_DAY) return true;
    if (now > seen) await this.setSetting('clock_max', String(now));
    return false;
  }

  /** The active license key: dashboard-entered (DB) wins, else the add-on option / env. */
  private async effectiveKey(): Promise<string | null> {
    return (await this.setting('key')) ?? (this.cfg.key || null);
  }

  async refresh(): Promise<LicenseStatus> {
    this.status = await this.evaluate();
    return this.status;
  }

  private build(state: LicenseState, message: string, p?: LicensePayload, graceUntil?: number): LicenseStatus {
    const active = state === 'ok' || state === 'grace';
    return {
      state,
      locked: !active,
      active,
      installId: this.installId,
      customer: p ? `${p.cust} (${p.id})` : null,
      expiresAt: p?.exp ? new Date(p.exp * 1000).toISOString() : null,
      graceUntil: graceUntil ? new Date(graceUntil).toISOString() : null,
      maxMiners: p?.max_miners ?? null,
      message,
    };
  }

  private async evaluate(): Promise<LicenseStatus> {
    if (!this.cfg.enabled) return this.build('ok', 'Licencijavimas išjungtas (tik kūrimui)');
    if (!isConfiguredKey(LICENSE_PUBLIC_KEY)) {
      return this.build('unconfigured', 'Licencijavimas nesukonfigūruotas: sugeneruokite raktus (npm run license:genkeys).');
    }
    const key = await this.effectiveKey();
    if (!key) return this.build('missing', 'Licencija neįvesta. Įklijuokite licencijos raktą.');

    const payload = verifyLicense(key, LICENSE_PUBLIC_KEY);
    if (!payload) return this.build('invalid', 'Neteisinga arba sugadinta licencija.');
    if (payload.hwid && payload.hwid !== this.installId) {
      return this.build('invalid', `Licencija išduota kitam įrenginiui (šio įrenginio ID: ${this.installId}).`, payload);
    }
    if (await this.clockTampered()) return this.build('invalid', 'Aptiktas sistemos laikrodžio pakeitimas atgal.', payload);

    if (payload.exp === 0) return this.build('ok', 'Licencija galioja (neterminuota).', payload);
    const expMs = payload.exp * 1000;
    const graceUntil = expMs + this.cfg.graceDays * MS_DAY;
    const now = Date.now();
    if (now <= expMs) return this.build('ok', 'Licencija galioja.', payload, graceUntil);
    if (now <= graceUntil) {
      const left = Math.ceil((graceUntil - now) / MS_DAY);
      return this.build('grace', `Licencija pasibaigė. Lengvatos laikotarpis: liko ${left} d.`, payload, graceUntil);
    }
    return this.build('expired', 'Licencija pasibaigusi.', payload, graceUntil);
  }

  /** Install a key entered in the dashboard. Only a validly signed key is accepted. Returns the new status. */
  async activate(key: unknown): Promise<LicenseStatus> {
    if (typeof key !== 'string' || !key.trim()) throw new Error('Įveskite licencijos raktą');
    const payload = verifyLicense(key.trim(), LICENSE_PUBLIC_KEY);
    if (!isConfiguredKey(LICENSE_PUBLIC_KEY)) throw new Error('Licencijavimas nesukonfigūruotas (nėra viešo rakto)');
    if (!payload) throw new Error('Neteisinga licencija (neatpažintas parašas)');
    if (payload.hwid && payload.hwid !== this.installId) throw new Error(`Licencija kitam įrenginiui. Šio įrenginio ID: ${this.installId}`);
    await this.setSetting('key', key.trim());
    const status = await this.refresh();
    await eventsRepo.add(this.pool, null, 'info', `🔑 Aktyvuota licencija: ${status.customer ?? ''} (iki ${status.expiresAt?.slice(0, 10) ?? 'neterminuota'})`);
    log.info(`License activated: ${status.customer}, state ${status.state}`);
    return status;
  }
}
