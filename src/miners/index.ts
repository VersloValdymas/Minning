import { cgminerDriver } from './cgminer.js';
import { httpJsonDriver } from './http-json.js';
import { vnishDriver } from './vnish.js';
import type { MinerDriver } from './types.js';

/** Register new drivers here (e.g. Antminer web CGI with digest auth, Braiins OS gRPC, LuxOS...). */
// Order matters for "auto" scan: richer APIs first, cgminer as the generic fallback.
const DRIVERS: MinerDriver[] = [vnishDriver, httpJsonDriver, cgminerDriver];

export function listDrivers(): MinerDriver[] {
  return DRIVERS;
}

export function getDriver(name: string): MinerDriver | undefined {
  return DRIVERS.find((d) => d.name === name);
}
