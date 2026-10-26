import type { AppConfig } from '../config.js';
import type { Pool } from '../db/pool.js';
import { bus } from '../events.js';
import { coolantProperties, COOLANT_TYPES, type CoolantType } from '../health/coolant.js';
import { createLogger } from '../logger.js';
import { HttpError } from '../util/http-error.js';

const log = createLogger('settings');

/** Coolant settings editable from the dashboard. */
export interface CoolantSettings {
  type: CoolantType;
  glycolPct: number;
  cpOverride: number;
  densityOverride: number;
  requiredLpm: number;
  defaultRequiredLpm: number;
}

const COOLANT_KEY = 'coolant';
const LAYOUT_KEY = 'layout';

/** A cabinet with its own circulation pump (= its own coolant loop). */
export interface RackLayout {
  id: number;
  name: string;
  shelves: number;
  /** Slots per shelf, left -> right */
  slots: number;
}

export type ShelfNumbering = 'bottom' | 'top';

export interface Layout {
  siteName: string;
  /** "bottom": shelf 1 is the lowest (data-centre convention, default); "top": shelf 1 is the highest. */
  shelfNumbering: ShelfNumbering;
  racks: RackLayout[];
}

/** Default matches the reference container: 5 cabinets × 4 shelves × 4 slots. Editable in the dashboard. */
export const DEFAULT_LAYOUT: Layout = {
  siteName: 'Konteineris',
  shelfNumbering: 'bottom',
  racks: [1, 2, 3, 4, 5].map((id) => ({ id, name: `Spinta ${id}`, shelves: 4, slots: 4 })),
};

export function parseLayout(input: unknown): Layout {
  const b = (input ?? {}) as Record<string, unknown>;
  const siteName = typeof b.siteName === 'string' && b.siteName.trim() ? b.siteName.trim().slice(0, 60) : 'Konteineris';
  if (!Array.isArray(b.racks) || b.racks.length < 1 || b.racks.length > 30) throw new HttpError(400, 'racks: 1..30 spintų');
  const racks = b.racks.map((r: Record<string, unknown>, i: number) => ({
    id: i + 1,
    name: typeof r?.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 40) : `Spinta ${i + 1}`,
    shelves: num(r?.shelves, `racks[${i}].shelves`, 1, 12),
    slots: num(r?.slots, `racks[${i}].slots`, 1, 12),
  }));
  const shelfNumbering: ShelfNumbering = b.shelfNumbering === 'top' ? 'top' : 'bottom';
  return { siteName, shelfNumbering, racks };
}

export function isInLayout(layout: Layout, loc: { rack: number; shelf: number; slot: number }): boolean {
  const r = layout.racks.find((x) => x.id === loc.rack);
  return !!r && loc.shelf >= 1 && loc.shelf <= r.shelves && loc.slot >= 1 && loc.slot <= r.slots;
}

const EDITABLE: Array<keyof CoolantSettings> = ['type', 'glycolPct', 'cpOverride', 'densityOverride', 'requiredLpm', 'defaultRequiredLpm'];

function num(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be ${min}..${max}`);
  return n;
}

/** Validates untrusted input. Throws HttpError(400). */
export function parseCoolantSettings(input: unknown): CoolantSettings {
  const b = (input ?? {}) as Record<string, unknown>;
  if (!COOLANT_TYPES.includes(b.type as CoolantType)) throw new HttpError(400, `type must be one of ${COOLANT_TYPES.join(', ')}`);
  return {
    type: b.type as CoolantType,
    glycolPct: num(b.glycolPct, 'glycolPct', 0, 60),
    cpOverride: num(b.cpOverride ?? 0, 'cpOverride', 0, 5000),
    densityOverride: num(b.densityOverride ?? 0, 'densityOverride', 0, 2),
    requiredLpm: num(b.requiredLpm ?? 0, 'requiredLpm', 0, 100),
    defaultRequiredLpm: num(b.defaultRequiredLpm ?? 8, 'defaultRequiredLpm', 0, 100),
  };
}

/**
 * Runtime settings: env / add-on options are the defaults, values saved from the dashboard override them.
 * Applied by mutating the shared config object, so every reader picks them up immediately.
 */
export class SettingsService {
  private readonly defaults: CoolantSettings;
  private layoutValue: Layout = DEFAULT_LAYOUT;

  constructor(
    private readonly pool: Pool,
    private readonly cfg: AppConfig,
  ) {
    this.defaults = this.currentCoolant();
  }

  currentCoolant(): CoolantSettings {
    const c = this.cfg.coolant;
    return {
      type: (COOLANT_TYPES.includes(c.type as CoolantType) ? c.type : 'water') as CoolantType,
      glycolPct: c.glycolPct,
      cpOverride: c.cpOverride,
      densityOverride: c.densityOverride,
      requiredLpm: c.requiredLpm,
      defaultRequiredLpm: c.defaultRequiredLpm,
    };
  }

  get layout(): Layout {
    return this.layoutValue;
  }

  /**
   * Saves the layout in one transaction. When the shelf numbering direction changes, placed miners'
   * shelf numbers are flipped (shelf = N + 1 - shelf, N = current shelf count) so they keep their
   * PHYSICAL position. Rejects layouts that would leave placed miners outside (they must be moved first).
   */
  async saveLayout(next: Layout): Promise<Layout> {
    const prev = this.layoutValue;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (prev.shelfNumbering !== next.shelfNumbering) {
        for (const r of prev.racks) {
          // Two steps via negative values: the (rack, shelf, slot) unique index is checked per row.
          await client.query('UPDATE devices SET shelf = -($2::int + 1 - shelf) WHERE rack = $1 AND shelf IS NOT NULL', [r.id, r.shelves]);
          await client.query('UPDATE devices SET shelf = -shelf WHERE rack = $1 AND shelf < 0', [r.id]);
        }
      }
      const { rows } = await client.query<{ rack: number; shelf: number; slot: number }>('SELECT rack, shelf, slot FROM devices WHERE rack IS NOT NULL');
      const outside = rows.filter((p) => !isInLayout(next, p)).length;
      if (outside > 0) throw new HttpError(409, `${outside} kasykl. liktų už naujo išdėstymo ribų – pirmiausia jas perkelkite`);
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [LAYOUT_KEY, JSON.stringify(next)],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    this.layoutValue = next;
    bus.publish('settings.changed', { key: LAYOUT_KEY });
    return next;
  }

  async load(): Promise<void> {
    const layout = await this.pool.query<{ value: Layout }>('SELECT value FROM settings WHERE key = $1', [LAYOUT_KEY]);
    if (layout.rows[0]) this.layoutValue = parseLayout(layout.rows[0].value);
    const { rows } = await this.pool.query<{ value: Partial<CoolantSettings> }>('SELECT value FROM settings WHERE key = $1', [COOLANT_KEY]);
    if (rows[0]) {
      this.apply({ ...this.defaults, ...rows[0].value });
      log.info(`Coolant from dashboard settings: ${coolantProperties(this.cfg.coolant).label}`);
    }
  }

  private apply(s: CoolantSettings): void {
    for (const k of EDITABLE) (this.cfg.coolant as Record<string, unknown>)[k] = s[k];
  }

  describe() {
    return {
      coolant: this.currentCoolant(),
      defaults: this.defaults,
      derived: coolantProperties(this.cfg.coolant),
      types: COOLANT_TYPES,
    };
  }

  /** Saves, applies and rescales stored flow estimates (flow ∝ 1 / (cp·ρ)). Returns rows updated. */
  async saveCoolant(next: CoolantSettings): Promise<number> {
    const before = coolantProperties(this.cfg.coolant);
    await this.pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [COOLANT_KEY, JSON.stringify(next)],
    );
    this.apply(next);
    const after = coolantProperties(this.cfg.coolant);
    const updated = await this.rescaleHistory(before.cpJkgK * before.densityKgL, after.cpJkgK * after.densityKgL);
    log.info(`Coolant settings saved: ${after.label} (${updated} stored flow values recalculated)`);
    bus.publish('settings.changed', { key: COOLANT_KEY });
    return updated;
  }

  async resetCoolant(): Promise<number> {
    const before = coolantProperties(this.cfg.coolant);
    await this.pool.query('DELETE FROM settings WHERE key = $1', [COOLANT_KEY]);
    this.apply(this.defaults);
    const after = coolantProperties(this.cfg.coolant);
    const updated = await this.rescaleHistory(before.cpJkgK * before.densityKgL, after.cpJkgK * after.densityKgL);
    bus.publish('settings.changed', { key: COOLANT_KEY });
    return updated;
  }

  /** Last 7 days only, so already-compressed chunks are not touched. */
  private async rescaleHistory(oldCpRho: number, newCpRho: number): Promise<number> {
    if (!oldCpRho || !newCpRho || Math.abs(oldCpRho - newCpRho) < 1e-9) return 0;
    const res = await this.pool.query(
      `UPDATE miner_metrics SET coolant_flow_lpm = round((coolant_flow_lpm * $1::float8 / $2::float8)::numeric, 1)
       WHERE coolant_flow_lpm IS NOT NULL AND time > now() - INTERVAL '7 days'`,
      [oldCpRho, newCpRho],
    );
    return res.rowCount ?? 0;
  }
}
