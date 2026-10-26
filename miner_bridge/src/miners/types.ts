/** Normalized metric keys. Same names are used for DB columns, MQTT state JSON and the dashboard. */
export const METRIC_KEYS = [
  'hashrate_ths',
  'hashrate_avg_ths',
  'temp_max_c',
  'temp_avg_c',
  'water_in_c',
  'water_out_c',
  'coolant_flow_lpm',
  'fan_rpm_avg',
  'power_w',
  'voltage_v',
  'current_a',
  'efficiency_jth',
  'accepted',
  'rejected',
  'hw_errors',
  'uptime_s',
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

export interface ChainInfo {
  id: number | string;
  state: string | null;
  hashrate_ths: number | null;
  /** Target hashrate of the chain at current tuning (used for "% of nominal"). */
  ideal_ths: number | null;
  power_w: number | null;
  chip_temp_max_c: number | null;
  water_in_c?: number | null;
  water_out_c?: number | null;
}

/** Structured, non-numeric state (stored as JSONB in miner_metrics.extra). */
export interface MinerDetails {
  /** Normalized firmware state: mining | initializing | starting | auto-tuning | restarting | stopped | failure | ... */
  state: string | null;
  /** Expected hashrate at current tuning (sum of chain ideals) - basis for "% of nominal". */
  nominal_ths: number | null;
  pool: string | null;
  chains: ChainInfo[];
  /**
   * Where power_w comes from: "measured" (PSU/meter), "calculated" (firmware estimate from hashboards),
   * "estimated" (STANDBY_POWER_W while not hashing) or "unmeasured" (device is on, but nothing reports its draw).
   */
  power_source?: 'measured' | 'calculated' | 'estimated' | 'unmeasured' | null;
  /** "Find miner" LED blinking is on (used to locate the unit physically). */
  locating?: boolean;
}

export type MinerMetrics = Record<MetricKey, number | null> & {
  /** Device-reported critical problems (chain failure etc.). Threshold alerts live in health/. */
  errors: string[];
  details?: MinerDetails;
};

export interface MinerTarget {
  ip: string;
  port: number;
}

export interface MinerIdentity {
  /** Vendor serial or other stable ID, used when no MAC is available. */
  uniqueId?: string | null;
  mac?: string | null;
  vendor?: string | null;
  model?: string | null;
  firmware?: string | null;
  hostname?: string | null;
}

/** A problem the firmware logged itself (e.g. overheat protection), possibly between our polls. */
export interface FirmwareEvent {
  time: Date;
  level: 'info' | 'warn' | 'error';
  /** overheat | overheat_stop | chain_break | restart_fault | fw_error */
  code: string;
  message: string;
}

export interface MinerDriver {
  readonly name: string;
  readonly label: string;
  readonly defaultPort: number;
  /** Commands accepted by execute() (exposed as HA buttons). */
  readonly commands: readonly string[];
  /** Returns identity if the host is a miner speaking this protocol, otherwise null. Must not throw. */
  probe(target: MinerTarget, timeoutMs: number): Promise<MinerIdentity | null>;
  /** Reads current telemetry. Throws when the device is unreachable. */
  poll(target: MinerTarget, timeoutMs: number): Promise<MinerMetrics>;
  execute(target: MinerTarget, command: string, timeoutMs: number): Promise<void>;
  /** Optional: firmware log events (protection trips etc.). Called less often than poll(). */
  recentEvents?(target: MinerTarget, timeoutMs: number): Promise<FirmwareEvent[]>;
}

export function emptyMetrics(): MinerMetrics {
  const m = { errors: [] as string[] } as MinerMetrics;
  for (const k of METRIC_KEYS) m[k] = null;
  return m;
}

/** Parses numbers from numbers or strings like "1340 (W)" / "75.5". */
export function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function toStr(v: unknown): string | null {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number') return String(v);
  return null;
}

export function guessVendor(model: string | null | undefined): string | null {
  if (!model) return null;
  if (/antminer|bitmain/i.test(model)) return 'Bitmain';
  if (/whatsminer|^M\d{2}/i.test(model)) return 'MicroBT';
  if (/avalon|canaan/i.test(model)) return 'Canaan';
  return null;
}
