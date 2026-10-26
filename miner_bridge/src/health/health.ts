import type { AppConfig } from '../config.js';
import type { DeviceStatus } from '../db/devices-repo.js';
import type { MinerDetails } from '../miners/types.js';
import type { RequiredFlow } from './coolant.js';

/**
 * Health engine: single source of truth for "is this miner OK and if not, why".
 * Used by the poller (device status), MQTT (HA sensors) and the dashboard (colors, alert list).
 */
export type IssueLevel = 'info' | 'warn' | 'crit';
export type HealthLevel = 'ok' | IssueLevel | 'offline' | 'disabled';

export interface Issue {
  level: IssueLevel;
  code: string;
  text: string;
}

export interface Health {
  level: HealthLevel;
  /** Short human state for badges: "Kasa", "Kraunasi", "Offline"... */
  label: string;
  issues: Issue[];
  /** Derived KPIs reused by UI */
  hashrate_pct: number | null;
  water_delta_c: number | null;
  reject_pct: number | null;
  /** Estimated coolant flow and the model's required minimum (hydro only). */
  flow_lpm: number | null;
  flow_required_lpm: number | null;
  flow_required_spec: string | null;
  flow_last: { lpm: number; at: string } | null;
}

export interface HealthSnapshot {
  polledAt: string;
  metrics: Partial<Record<string, number | null>>;
  /** Device-reported problems (chain failure, miner failure...) - always critical. */
  errors: string[];
  details: MinerDetails | null;
  /** When the current firmware state was first observed (for "stuck" detection). */
  stateSince: string | null;
}

export interface FirmwareEventLite {
  time: Date | string;
  code?: string | null;
  message: string;
}

export interface HealthInput {
  active: boolean;
  status: DeviceStatus;
  lastError: string | null;
  snapshot: HealthSnapshot | null;
  /** Firmware protection trips read from miner logs (may have happened between polls). */
  firmwareEvents?: FirmwareEventLite[];
  /** Required coolant flow for this model (hydro only). */
  requiredFlow?: RequiredFlow;
  /** Last flow estimate taken while mining (flow cannot be computed when the miner produces no heat). */
  lastFlow?: { lpm: number; at: Date | string } | null;
}

export interface FirmwareRules {
  windowH: number;
}

const agoText = (ms: number) => {
  const min = Math.round(ms / 60_000);
  return min < 60 ? `prieš ${min} min` : `prieš ${Math.round(min / 60)} h`;
};

/**
 * Firmware-log rules. Protection trips are invisible to 15 s polling (the miner trips within
 * seconds and restarts), so these are what makes a "stopped" or "restarting" miner show up red.
 */
function firmwareIssues(input: HealthInput, state: string | null, windowH: number, now: number): Issue[] {
  const since = now - windowH * 3600_000;
  const recent = (input.firmwareEvents ?? []).filter((e) => new Date(e.time).getTime() >= since);
  const issues: Issue[] = [];
  const overheats = recent.filter((e) => e.code === 'overheat' || e.code === 'overheat_stop');
  if (overheats.length) {
    const last = overheats[overheats.length - 1];
    const temps = overheats.map((e) => Number(/PCB (\d+)/.exec(e.message)?.[1])).filter(Number.isFinite);
    const peak = temps.length ? `, PCB iki ${Math.max(...temps)} °C` : '';
    const lastAgo = agoText(now - new Date(last.time).getTime());
    const notMining = state !== null && ['stopped', 'paused', 'failure', 'shutting-down'].includes(state);
    if (last.code === 'overheat_stop' || notMining) {
      issues.push({ level: 'crit', code: 'overheat_stop', text: `Sustabdyta po perkaitimo (${overheats.length}× per ${windowH} h${peak}, paskutinis ${lastAgo})` });
    } else if (overheats.length >= 2) {
      issues.push({ level: 'crit', code: 'overheat_repeat', text: `Kartotinis perkaitimas: ${overheats.length}× per ${windowH} h${peak} (paskutinis ${lastAgo})` });
    } else {
      issues.push({ level: 'warn', code: 'overheat_once', text: `Perkaito ${lastAgo}${peak}` });
    }
  }
  const breaks = recent.filter((e) => e.code === 'chain_break');
  if (breaks.length) {
    issues.push({ level: breaks.length >= 3 ? 'crit' : 'warn', code: 'chain_break', text: `Grandinės nutrūkimas ${breaks.length}× per ${windowH} h` });
  }
  const other = recent.filter((e) => e.code === 'fw_error' || e.code === 'restart_fault');
  if (other.length) issues.push({ level: 'warn', code: 'fw_error', text: other[other.length - 1].message });
  return issues;
}

const STATE_LABELS: Record<string, string> = {
  mining: 'Kasa',
  initializing: 'Kraunasi',
  starting: 'Startuoja',
  'auto-tuning': 'Autotuning',
  restarting: 'Persikrauna',
  'shutting-down': 'Išsijungia',
  stopped: 'Sustabdyta',
  paused: 'Pristabdyta',
  failure: 'Gedimas',
};

const STARTING_STATES = new Set(['initializing', 'starting', 'restarting']);
const RANK: Record<HealthLevel, number> = { ok: 0, disabled: 0, info: 1, warn: 2, crit: 3, offline: 4 };

const pct = (part: number, whole: number) => Math.round((part / whole) * 1000) / 10;

export function evaluateHealth(
  input: HealthInput,
  a: AppConfig['alerts'],
  pollIntervalMs: number,
  fw: FirmwareRules = { windowH: 6 },
  now = Date.now(),
): Health {
  const issues: Issue[] = [];
  const add = (level: IssueLevel, code: string, text: string) => issues.push({ level, code, text });
  const req = input.requiredFlow ?? null;
  const base = {
    hashrate_pct: null,
    water_delta_c: null,
    reject_pct: null,
    flow_lpm: null,
    flow_required_lpm: req?.lpm ?? null,
    flow_required_spec: req?.spec ?? null,
    flow_last: null,
  };

  if (!input.active) return { level: 'disabled', label: 'Išjungta', issues, ...base };
  if (input.status === 'offline') {
    add('crit', 'offline', `Nepasiekiama${input.lastError ? `: ${input.lastError}` : ''}`);
    issues.push(...firmwareIssues(input, null, fw.windowH, now));
    return { level: 'offline', label: 'Offline', issues, ...base };
  }
  const snap = input.snapshot;
  if (!snap) return { level: 'info', label: 'Laukiama duomenų', issues, ...base };

  const m = snap.metrics;
  const d = snap.details;
  const state = d?.state ?? (m.hashrate_ths ? 'mining' : null);
  const label = state ? STATE_LABELS[state] ?? state : 'Kasa';

  // Stale data: device answered before but not in the last few cycles
  const ageMs = now - new Date(snap.polledAt).getTime();
  if (ageMs > pollIntervalMs * 3) add('warn', 'stale', `Nėra naujų duomenų ${Math.round(ageMs / 1000)} s`);

  for (const e of snap.errors) add('crit', 'device_error', e);
  issues.push(...firmwareIssues(input, state, fw.windowH, now));

  // Firmware state
  const stateAgeS = snap.stateSince ? (now - new Date(snap.stateSince).getTime()) / 1000 : 0;
  if (state === 'failure') {
    if (snap.errors.length === 0) add('crit', 'failure', 'Kasyklos gedimas (failure)');
  } else if (state && STARTING_STATES.has(state)) {
    if (stateAgeS > a.stuckStartingS) add('warn', 'stuck', `Užstrigo būsenoje „${label}“ ${Math.round(stateAgeS / 60)} min`);
    else add('info', 'starting', label);
  } else if (state === 'auto-tuning') {
    add('info', 'tuning', 'Vyksta autotuning');
  } else if (state === 'stopped' || state === 'paused' || state === 'shutting-down') {
    add('info', 'stopped', `Kasimas: ${label.toLowerCase()}`);
  }

  // Hashrate vs nominal (only once the miner has settled in "mining")
  const nominal = d?.nominal_ths ?? null;
  const hr = m.hashrate_ths ?? null;
  const hashratePct = nominal && hr !== null ? pct(hr, nominal) : null;
  const miningForS = state === 'mining' ? m.uptime_s ?? stateAgeS : 0;
  const settled = (state === 'mining' || state === null) && miningForS >= a.hashrateGraceS;
  if (settled) {
    if (hashratePct !== null) {
      if (hashratePct < a.hashrateCritPct) add('crit', 'hashrate', `Hashrate ${hashratePct}% nominalo`);
      else if (hashratePct < a.hashrateWarnPct) add('warn', 'hashrate', `Hashrate ${hashratePct}% nominalo`);
    } else if (hr === 0) {
      add('crit', 'hashrate', 'Hashrate 0');
    }
    for (const c of d?.chains ?? []) {
      if (c.state !== 'mining' || !c.ideal_ths || c.hashrate_ths === null) continue;
      const p = pct(c.hashrate_ths, c.ideal_ths);
      if (p < a.hashrateCritPct) add('crit', `chain_${c.id}`, `Grandinė ${c.id}: ${p}% nominalo`);
      else if (p < a.hashrateWarnPct) add('warn', `chain_${c.id}`, `Grandinė ${c.id}: ${p}% nominalo`);
    }
  }

  // Temperatures
  const chip = m.temp_max_c ?? null;
  if (chip !== null) {
    if (chip >= a.tempCriticalC) add('crit', 'chip_temp', `Lustai ${chip.toFixed(0)}°C`);
    else if (chip >= a.tempWarnC) add('warn', 'chip_temp', `Lustai ${chip.toFixed(0)}°C`);
  }
  const wIn = m.water_in_c ?? null;
  const wOut = m.water_out_c ?? null;
  if (wOut !== null) {
    if (wOut >= a.waterOutCritC) add('crit', 'water_out', `Vanduo išėjime ${wOut.toFixed(0)}°C`);
    else if (wOut >= a.waterOutWarnC) add('warn', 'water_out', `Vanduo išėjime ${wOut.toFixed(0)}°C`);
  }
  if (wIn !== null && wIn >= a.waterInWarnC) add('warn', 'water_in', `Vanduo įėjime ${wIn.toFixed(0)}°C`);
  const waterDelta = wIn !== null && wOut !== null ? Math.round((wOut - wIn) * 10) / 10 : null;
  // Coolant flow (estimated from power and ΔT) vs the model's required minimum: below = critical immediately.
  const flow = m.coolant_flow_lpm ?? null;
  const last = input.lastFlow;
  const lastAgeMs = last ? now - new Date(last.at).getTime() : Infinity;
  if (flow !== null && req && flow < req.lpm) {
    add('crit', 'coolant_flow', `Aušinimo debitas ${flow.toFixed(1).replace(".", ",")} l/min < privalomo ${req.lpm} l/min`);
  } else if (flow === null && req && last && last.lpm < req.lpm && lastAgeMs <= fw.windowH * 3600_000) {
    // Not producing heat now (stopped/starting) - keep showing the last known insufficient flow.
    add('crit', 'coolant_flow', `Paskutinį kartą kasant debitas buvo ${last.lpm.toFixed(1).replace(".", ",")} l/min < privalomo ${req.lpm} l/min (${agoText(lastAgeMs)})`);
  } else if (flow === null && waterDelta !== null && state === 'mining' && waterDelta >= a.waterDeltaWarnC) {
    // No flow estimate available (e.g. power unknown): fall back to the ΔT heuristic.
    add('warn', 'water_delta', `ΔT ${waterDelta}°C – per mažas vandens debitas?`);
  }

  // Share rejects (only meaningful with enough shares)
  const acc = m.accepted ?? 0;
  const rej = m.rejected ?? 0;
  const rejectPct = acc + rej >= 100 ? pct(rej, acc + rej) : null;
  if (rejectPct !== null) {
    if (rejectPct >= a.rejectCritPct) add('crit', 'rejects', `Atmesta ${rejectPct}% share'ų`);
    else if (rejectPct >= a.rejectWarnPct) add('warn', 'rejects', `Atmesta ${rejectPct}% share'ų`);
  }

  issues.sort((x, y) => RANK[y.level] - RANK[x.level]);
  const level: HealthLevel = issues.length ? issues[0].level : 'ok';
  return {
    level,
    label: level === 'crit' && state === 'failure' ? 'Gedimas' : label,
    issues,
    hashrate_pct: hashratePct,
    water_delta_c: waterDelta,
    reject_pct: rejectPct,
    flow_lpm: flow,
    flow_required_lpm: req?.lpm ?? null,
    flow_required_spec: req?.spec ?? null,
    flow_last: last ? { lpm: last.lpm, at: new Date(last.at).toISOString() } : null,
  };
}

/** Issues that make a responding device "warning" (info-level ones do not). */
export const isProblem = (h: Health) => h.issues.some((i) => i.level === 'warn' || i.level === 'crit');
