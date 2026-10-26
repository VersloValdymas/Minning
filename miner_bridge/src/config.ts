import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Project root (works from both src/ and dist/). */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(ROOT_DIR, '.env'));
} catch {
  // no .env file - fine in production / add-on mode
}

const OPTIONS_PATH = process.env.HA_OPTIONS_PATH ?? '/data/options.json';

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const haOptions = readJson(OPTIONS_PATH);

/**
 * Lookup order: environment variable (UPPER_CASE) -> HA add-on option (lower_case) -> default.
 * Empty strings count as "not set".
 */
function raw(key: string): string | undefined {
  const env = process.env[key];
  if (env !== undefined && env !== '') return env;
  const opt = haOptions?.[key.toLowerCase()];
  if (opt === undefined || opt === null || opt === '') return undefined;
  return String(opt);
}

function str(key: string): string | undefined;
function str(key: string, def: string): string;
function str(key: string, def?: string): string | undefined {
  return raw(key) ?? def;
}

function int(key: string, def: number): number {
  const v = raw(key);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Config ${key} must be a number, got "${v}"`);
  return n;
}

function bool(key: string, def: boolean): boolean {
  const v = raw(key);
  if (v === undefined) return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const pkg = readJson(path.join(ROOT_DIR, 'package.json'));

export const config = {
  appVersion: String(pkg?.version ?? '0.0.0'),
  isAddon: haOptions !== null,
  logLevel: str('LOG_LEVEL', 'info'),
  http: {
    port: int('HTTP_PORT', 3000),
    /** Reject requests that do not come through HA Ingress (172.30.32.2) or localhost. */
    // Secure by default inside Home Assistant (host_network exposes the port to the LAN, and the API has no own auth)
    ingressOnly: bool('INGRESS_ONLY', haOptions !== null),
  },
  db: {
    url: str('DATABASE_URL'),
    host: str('DB_HOST', 'localhost'),
    port: int('DB_PORT', 5432),
    database: str('DB_NAME', 'miners'),
    user: str('DB_USER', 'postgres'),
    password: str('DB_PASSWORD', ''),
    ssl: bool('DB_SSL', false),
    retentionDays: int('RETENTION_DAYS', 90),
  },
  mqtt: {
    url: str('MQTT_URL'),
    host: str('MQTT_HOST'),
    port: int('MQTT_PORT', 1883),
    username: str('MQTT_USERNAME'),
    password: str('MQTT_PASSWORD'),
    clientId: str('MQTT_CLIENT_ID', `minerbridge-${randomBytes(3).toString('hex')}`),
    discoveryPrefix: str('MQTT_DISCOVERY_PREFIX', 'homeassistant'),
    baseTopic: str('MQTT_BASE_TOPIC', 'minerbridge'),
  },
  poll: {
    intervalMs: int('POLL_INTERVAL_S', 15) * 1000,
    concurrency: int('POLL_CONCURRENCY', 25),
    timeoutMs: int('POLL_TIMEOUT_MS', 4000),
    offlineAfterFailures: int('OFFLINE_AFTER_FAILURES', 3),
  },
  scan: {
    concurrency: int('SCAN_CONCURRENCY', 64),
    timeoutMs: int('SCAN_TIMEOUT_MS', 1500),
    maxHosts: int('SCAN_MAX_HOSTS', 4096),
  },
  /** Health thresholds (see src/health/health.ts). Defaults tuned for Antminer S21+ Hydro, valid for air-cooled too. */
  alerts: {
    tempWarnC: int('TEMP_WARN_C', 75),
    tempCriticalC: int('TEMP_CRITICAL_C', 85),
    waterInWarnC: int('WATER_IN_WARN_C', 35),
    waterOutWarnC: int('WATER_OUT_WARN_C', 45),
    waterOutCritC: int('WATER_OUT_CRIT_C', 50),
    waterDeltaWarnC: int('WATER_DELTA_WARN_C', 15),
    hashrateWarnPct: int('HASHRATE_WARN_PCT', 90),
    hashrateCritPct: int('HASHRATE_CRIT_PCT', 75),
    /** Hashrate checks start after this many seconds in "mining" (ramp-up). */
    hashrateGraceS: int('HASHRATE_GRACE_S', 600),
    rejectWarnPct: int('REJECT_WARN_PCT', 1),
    rejectCritPct: int('REJECT_CRIT_PCT', 3),
    /** initializing/starting longer than this = stuck. */
    stuckStartingS: int('STUCK_STARTING_S', 900),
    /** Auto-tuning session longer than this = warning (first tuning of a preset usually takes 2-8 h). */
    tuningWarnH: int('TUNING_WARN_H', 12),
    /** Unfinished tuning interrupted this many times (restarts / power loss) = warning. */
    tuningInterruptionsWarn: int('TUNING_INTERRUPTIONS_WARN', 3),
  },
  coolant: {
    /** water | ethylene_glycol | propylene_glycol - properties are derived from type + concentration. */
    type: str('COOLANT_TYPE', 'water'),
    /** Glycol concentration, % by volume. */
    glycolPct: int('COOLANT_GLYCOL_PCT', 30),
    /** Optional exact values from the coolant datasheet (0 = derive from type/concentration). */
    cpOverride: int('COOLANT_CP', 0),
    densityOverride: int('COOLANT_DENSITY', 0),
    /** Required minimum flow for ALL miners, L/min. 0 = per model spec (src/health/coolant.ts). */
    requiredLpm: int('FLOW_REQUIRED_LPM', 0),
    /** Used for hydro models without a known spec. */
    defaultRequiredLpm: int('FLOW_REQUIRED_DEFAULT_LPM', 8),
    /** Flow is only estimated above this power and ΔT (otherwise too imprecise). */
    minPowerW: int('FLOW_MIN_POWER_W', 1000),
    minDeltaC: int('FLOW_MIN_DELTA_C', 2),
  },
  firmwareLog: {
    /** How often firmware logs are read (protection trips happen between polls). */
    intervalMs: int('FW_LOG_INTERVAL_S', 60) * 1000,
    /** Health looks at firmware events from this many hours back. */
    windowH: int('FW_EVENT_WINDOW_H', 6),
  },
  power: {
    /**
     * Wall draw of a miner that is powered but not hashing (control board + PSU standby).
     * Firmware reports 0 W in that state; 0 = unknown (shown as "not measured").
     */
    standbyW: int('STANDBY_POWER_W', 0),
  },
  vnish: {
    /** Preferred: 32-char API key created in the Vnish web UI (same key on all miners). */
    apiKey: str('VNISH_API_KEY'),
    /** Fallback: web UI password, exchanged for a JWT via /unlock. */
    password: str('VNISH_PASSWORD'),
  },
  relay: {
    cycleDelayMs: int('RELAY_CYCLE_DELAY_S', 10) * 1000,
    timeoutMs: int('RELAY_TIMEOUT_MS', 5000),
  },
};

export type AppConfig = typeof config;
