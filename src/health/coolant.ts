import type { AppConfig } from '../config.js';

/**
 * Manufacturer minimum coolant flow per model (L/min), lower bound of the spec range.
 * Sources: Bitmain product manuals / spec sheets - S21+ Hyd., S21 XP Hyd., S21 XP+ Hyd.: 8.0–10.0 L/min.
 * Add models here only from a verified spec sheet.
 */
const MODEL_FLOW: Array<{ match: RegExp; lpm: number; spec: string }> = [
  { match: /S21\s*XP\s*\+\s*Hyd/i, lpm: 8, spec: '8–10 l/min (Bitmain S21 XP+ Hyd.)' },
  { match: /S21\s*XP\s*Hyd/i, lpm: 8, spec: '8–10 l/min (Bitmain S21 XP Hyd.)' },
  { match: /S21\s*\+\s*Hyd/i, lpm: 8, spec: '8–10 l/min (Bitmain S21+ Hyd.)' },
];

export interface RequiredFlow {
  lpm: number;
  /** "model" = from the table above, "config" = FLOW_REQUIRED_LPM override or default for unknown models */
  source: 'model' | 'config';
  spec: string;
}

export function requiredFlow(model: string | null | undefined, cfg: AppConfig['coolant']): RequiredFlow {
  if (cfg.requiredLpm > 0) return { lpm: cfg.requiredLpm, source: 'config', spec: `${cfg.requiredLpm} l/min (konfigūracija)` };
  const hit = MODEL_FLOW.find((m) => m.match.test(model ?? ''));
  if (hit) return { lpm: hit.lpm, source: 'model', spec: hit.spec };
  return { lpm: cfg.defaultRequiredLpm, source: 'config', spec: `${cfg.defaultRequiredLpm} l/min (numatyta, modelio specifikacija nežinoma)` };
}

/**
 * Heat balance: all electrical power ends up in the coolant.
 *   flow [L/min] = P [W] / (cp [J/kg·K] × ρ [kg/L] × ΔT [K]) × 60
 * Assumes 100 % of power goes to water, so it slightly OVERestimates flow (errs on the safe side
 * for "too low" alarms). Unreliable at small ΔT (sensors report whole °C) - guarded by minDeltaC.
 */
export function estimateFlowLpm(powerW: number | null, waterIn: number | null, waterOut: number | null, cfg: AppConfig['coolant']): number | null {
  if (powerW === null || waterIn === null || waterOut === null) return null;
  const dT = waterOut - waterIn;
  if (powerW < cfg.minPowerW || dT < cfg.minDeltaC) return null;
  const { cpJkgK, densityKgL } = coolantProperties(cfg);
  return Math.round(((powerW / (cpJkgK * densityKgL * dT)) * 60) * 10) / 10;
}

export const COOLANT_TYPES = ['water', 'ethylene_glycol', 'propylene_glycol'] as const;
export type CoolantType = (typeof COOLANT_TYPES)[number];

/**
 * Approximate properties of glycol-water mixtures at ~25 °C, by % glycol (volume).
 * Engineering reference values (ASHRAE-style tables); linear interpolation between rows.
 *   [pct, cp J/(kg·K), density kg/L]
 */
const MIXTURES: Record<Exclude<CoolantType, 'water'>, Array<[number, number, number]>> = {
  ethylene_glycol: [
    [0, 4186, 1.0],
    [20, 3900, 1.026],
    [30, 3730, 1.04],
    [40, 3550, 1.054],
    [50, 3350, 1.067],
    [60, 3140, 1.079],
  ],
  propylene_glycol: [
    [0, 4186, 1.0],
    [20, 4000, 1.017],
    [30, 3880, 1.026],
    [40, 3730, 1.034],
    [50, 3550, 1.041],
    [60, 3360, 1.046],
  ],
};

const TYPE_LT: Record<CoolantType, string> = {
  water: 'vanduo',
  ethylene_glycol: 'etilenglikolis',
  propylene_glycol: 'propilenglikolis',
};

export interface CoolantProperties {
  cpJkgK: number;
  densityKgL: number;
  /** Human description, e.g. "etilenglikolis 30 % (cp 3730 J/kg·K, ρ 1,040 kg/l)" */
  label: string;
}

/** Resolves coolant properties: explicit COOLANT_CP / COOLANT_DENSITY win, otherwise from type + concentration. */
export function coolantProperties(cfg: AppConfig['coolant']): CoolantProperties {
  const type = (Object.keys(TYPE_LT).includes(cfg.type) ? cfg.type : 'water') as CoolantType;
  let cp = 4186;
  let rho = 1.0;
  if (type !== 'water') {
    const rows = MIXTURES[type];
    const pct = Math.min(Math.max(cfg.glycolPct, 0), rows[rows.length - 1][0]);
    const hi = rows.findIndex((r) => r[0] >= pct);
    const [p0, c0, d0] = rows[Math.max(hi - 1, 0)];
    const [p1, c1, d1] = rows[hi];
    const k = p1 === p0 ? 0 : (pct - p0) / (p1 - p0);
    cp = Math.round(c0 + (c1 - c0) * k);
    rho = Math.round((d0 + (d1 - d0) * k) * 1000) / 1000;
  }
  if (cfg.cpOverride > 0) cp = cfg.cpOverride;
  if (cfg.densityOverride > 0) rho = cfg.densityOverride;
  const name = type === 'water' ? TYPE_LT.water : `${TYPE_LT[type]} ${cfg.glycolPct} %`;
  return { cpJkgK: cp, densityKgL: rho, label: `${name} (cp ${cp} J/kg·K, ρ ${rho.toFixed(3).replace('.', ',')} kg/l)` };
}
