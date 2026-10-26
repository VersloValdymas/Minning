import { createLogger } from '../logger.js';
import { errorMessage } from '../util/async.js';

const log = createLogger('ha');

export interface HaValue {
  value: number;
  unit: string;
  entity: string;
  at: string;
}

/**
 * Reads a Home Assistant entity state via the Supervisor proxy to Core.
 * Requires `homeassistant_api: true` in the add-on config (grants SUPERVISOR_TOKEN access to /core/api).
 * Returns null outside HA, when the entity is missing, or when the state is not numeric.
 */
export async function readHaState(entity: string, timeoutMs = 8000): Promise<HaValue | null> {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token || !entity) return null;
  try {
    const res = await fetch(`http://supervisor/core/api/states/${encodeURIComponent(entity)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log.warn(`HA entity ${entity}: HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { state?: string; attributes?: { unit_of_measurement?: string }; last_updated?: string };
    const value = Number(body.state);
    if (!Number.isFinite(value)) {
      log.debug(`HA entity ${entity}: non-numeric state "${body.state}"`);
      return null;
    }
    return { value, unit: body.attributes?.unit_of_measurement ?? '', entity, at: body.last_updated ?? new Date().toISOString() };
  } catch (err) {
    log.warn(`HA entity ${entity} read failed: ${errorMessage(err)}`);
    return null;
  }
}

/** Normalizes an electricity price to EUR/kWh regardless of the sensor's unit. */
export function priceToEurKwh(v: HaValue): number {
  const u = v.unit.toLowerCase();
  if (u.includes('mwh')) return v.value / 1000; // EUR/MWh
  if (u.includes('ct') || u.includes('cent') || u.includes('¢')) return v.value / 100; // ct/kWh
  return v.value; // assume EUR/kWh
}

/** Normalizes a power reading to kW regardless of the sensor's unit (W / kW / MW). */
export function powerToKw(v: HaValue): number {
  const u = v.unit.toLowerCase();
  if (u === 'w' || u.includes('watt')) return v.value / 1000;
  if (u.includes('mw')) return v.value * 1000;
  return v.value; // assume kW
}
