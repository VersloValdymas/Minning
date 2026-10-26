import { config } from '../config.js';
import { emptyMetrics, toNum, toStr, type FirmwareEvent, type MinerDriver, type MinerTarget, type TuningInfo } from './types.js';

type Obj = Record<string, unknown>;

/**
 * Vnish firmware HTTP API ("xminer-api", OpenAPI spec at http://<miner>/docs/api-doc.json).
 * Base path /api/v1. Verified against Antminer S21+ Hydro, Vnish 1.2.7.
 *
 * Read (no auth):  GET /info, /summary, /status, /chains
 * Write (auth):    POST /mining/restart, /system/reboot, /mining/stop, /mining/start ...
 *   auth = header "x-api-key: <32 chars>" (create in Vnish UI -> API keys)  - preferred
 *        or POST /unlock {"pw": "..."} -> {"token"} used as "Authorization: Bearer <token>"
 */
const BASE = '/api/v1';

const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const maxOf = (xs: Array<number | null>) => {
  const n = xs.filter((x): x is number => x !== null);
  return n.length ? Math.max(...n) : null;
};

async function getJson(t: MinerTarget, path: string, timeoutMs: number): Promise<Obj> {
  const res = await fetch(`http://${t.ip}:${t.port}${BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Obj;
}

/** JWT tokens from /unlock, cached per host (only used when no API key is configured). */
const tokens = new Map<string, string>();

async function authHeaders(t: MinerTarget, timeoutMs: number, refresh = false): Promise<Record<string, string>> {
  if (config.vnish.apiKey) return { 'x-api-key': config.vnish.apiKey };
  if (!config.vnish.password) throw new Error('Vnish commands need VNISH_API_KEY or VNISH_PASSWORD');
  const key = `${t.ip}:${t.port}`;
  if (refresh || !tokens.has(key)) {
    const res = await fetch(`http://${key}${BASE}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pw: config.vnish.password }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 403) throw new Error('Vnish: wrong password');
    if (res.status === 429) throw new Error('Vnish: too many unlock attempts');
    if (!res.ok) throw new Error(`Vnish unlock: HTTP ${res.status}`);
    tokens.set(key, String(((await res.json()) as Obj).token));
  }
  return { authorization: `Bearer ${tokens.get(key)}` };
}

async function postAuthed(t: MinerTarget, path: string, timeoutMs: number): Promise<void> {
  const send = async (refresh: boolean) =>
    fetch(`http://${t.ip}:${t.port}${BASE}${path}`, {
      method: 'POST',
      headers: await authHeaders(t, timeoutMs, refresh),
      signal: AbortSignal.timeout(timeoutMs),
    });
  let res = await send(false);
  if (res.status === 401 && !config.vnish.apiKey) res = await send(true); // expired JWT
  if (!res.ok) throw new Error(`Vnish ${path}: HTTP ${res.status}`);
}

/** Miner clock offset from UTC in minutes, from /metrics "timezone" ("GMT+2"). Cached per host. */
const tzCache = new Map<string, { offsetMin: number; at: number }>();

async function tzOffsetMin(t: MinerTarget, timeoutMs: number): Promise<number> {
  const key = `${t.ip}:${t.port}`;
  const hit = tzCache.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return hit.offsetMin;
  const res = await getJson(t, '/metrics?time_slice=60&step=60', timeoutMs);
  const m = /^GMT(?:([+-])(\d{1,2}))?$/.exec(String(res.timezone ?? ''));
  const offsetMin = m ? (m[1] === '-' ? -1 : 1) * Number(m[2] ?? 0) * 60 : 0;
  tzCache.set(key, { offsetMin, at: Date.now() });
  return offsetMin;
}

const LOG_LINE = /^\[(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})\] (\w+): (.*)$/;

/**
 * Parses Vnish /logs/status. Protection trips look like:
 *   [2026/10/08 11:16:12] ERROR: Miner is overheated /base.c:4522/
 *   [2026/10/08 11:16:12] INFO: Restarting (2 of 3) - Miner is overheated (pcb temp: 80°C)
 * An ERROR without a matching "Restarting" line means the firmware gave up (attempts exhausted).
 */
/**
 * Parses Vnish /logs/autotune. A tuning "campaign" lasts until "Auto-tune finished successfully";
 * every restart/power loss in between logs "Starting auto-tuning" + "Recovering autotune state...".
 * Rounds: "Collecting stats" (~5 min) -> per-chain "chain#N - X GH/s (Y%)" -> voltage step.
 */
export function parseAutotuneLog(text: string, offsetMin: number): Omit<TuningInfo, 'preset' | 'presetPretty' | 'presetTuned' | 'apiAccess'> {
  const lines = text
    .split('\n')
    .map((l) => LOG_LINE.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null);
  const iso = (m: RegExpExecArray) =>
    new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - offsetMin * 60_000).toISOString();

  let lastFinishedAt: string | null = null;
  let sessionStartedAt: string | null = null;
  let interruptions = 0;
  let rounds = 0;
  let badChips = 0;
  let collecting = false;
  let progress: TuningInfo['progress'] = null;
  let pending: { at: string; chains: Array<{ id: number; pct: number }>; voltageMv: number | null } | null = null;

  for (const m of lines) {
    const msg = m[8];
    if (msg.startsWith('Auto-tune finished successfully')) {
      lastFinishedAt = iso(m);
      interruptions = 0;
    } else if (msg.startsWith('Starting auto-tuning')) {
      sessionStartedAt = iso(m);
      rounds = 0;
    } else if (msg.startsWith('Recovering autotune state')) {
      interruptions++;
    } else if (msg.startsWith('Collecting stats')) {
      collecting = true;
    } else if (msg.startsWith('Stats collected')) {
      rounds++;
      badChips = 0;
      pending = { at: iso(m), chains: [], voltageMv: null };
      collecting = false;
    } else if (pending) {
      const chain = /^chain#(\d+) - (\d+) GH\/s \(([\d.]+)%\)/.exec(msg);
      const volt = /^voltage = (\d+) mV/.exec(msg);
      if (chain) pending.chains.push({ id: Number(chain[1]), pct: Number(chain[3]) });
      else if (volt) pending.voltageMv = Number(volt[1]);
      else if (/is bad$/.test(msg)) badChips++;
      if (pending.chains.length) progress = pending;
    }
  }
  void collecting;
  return { sessionStartedAt, interruptions, lastFinishedAt, progress, badChips, rounds };
}

export function parseStatusLog(text: string, offsetMin: number): FirmwareEvent[] {
  const lines = text
    .split('\n')
    .map((l) => LOG_LINE.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null);
  const toDate = (m: RegExpExecArray) =>
    new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - offsetMin * 60_000);
  const restartAt = new Set(lines.filter((m) => m[8].startsWith('Restarting')).map((m) => m.slice(1, 7).join()));
  const events: FirmwareEvent[] = [];

  for (const m of lines) {
    const [level, msg] = [m[7], m[8]];
    const time = toDate(m);
    const restart = /^Restarting \((\d+) of (\d+)\) - (.*)$/.exec(msg);
    if (restart) {
      const [, n, of, reason] = restart;
      const pcb = /pcb temp: (\d+)/i.exec(reason)?.[1];
      if (/overheat/i.test(reason)) {
        events.push({ time, level: 'error', code: 'overheat', message: `Perkaitimas${pcb ? `: PCB ${pcb} °C` : ''} – firmware perkrauna (${n}/${of})` });
      } else if (/chain break/i.test(reason)) {
        events.push({ time, level: 'error', code: 'chain_break', message: `Grandinės ryšio nutrūkimas – firmware perkrauna (${n}/${of})` });
      } else {
        events.push({ time, level: 'warn', code: 'restart_fault', message: `Firmware perkrauna (${n}/${of}): ${reason}` });
      }
    } else if (level === 'ERROR' && !restartAt.has(m.slice(1, 7).join())) {
      const overheat = /overheat/i.test(msg);
      events.push({
        time,
        level: 'error',
        code: overheat ? 'overheat_stop' : 'fw_error',
        message: overheat ? 'Perkaitimas – bandymai išnaudoti, kasimas sustabdytas' : `Firmware klaida: ${msg.replace(/\s*\/[\w.]+:\d+\/\s*$/, '')}`,
      });
    }
  }
  return events;
}

const COMMAND_PATHS: Record<string, string> = {
  find: '/find-miner', // toggles the "find miner" LED blinking
  start: '/mining/start',
  stop: '/mining/stop',
  restart: '/mining/restart',
  reboot: '/system/reboot',
};


export const vnishDriver: MinerDriver = {
  name: 'vnish',
  label: 'Vnish firmware (HTTP :80)',
  defaultPort: 80,
  commands: Object.keys(COMMAND_PATHS),

  async probe(t, timeoutMs) {
    try {
      const info = await getJson(t, '/info', timeoutMs);
      if (!/vnish/i.test(String(info.fw_name ?? ''))) return null;
      const net = obj(obj(info.system).network_status);
      const model = toStr(info.miner);
      return {
        uniqueId: toStr(info.serial),
        mac: toStr(net.mac),
        hostname: toStr(net.hostname),
        model,
        vendor: /antminer/i.test(model ?? '') ? 'Bitmain' : null,
        firmware: `Vnish ${toStr(info.fw_version) ?? ''}`.trim(),
      };
    } catch {
      return null;
    }
  },

  async poll(t, timeoutMs) {
    const [summary, statusPane] = await Promise.all([
      getJson(t, '/summary', timeoutMs),
      getJson(t, '/status', timeoutMs).catch(() => null),
    ]);
    const miner = obj(summary.miner);
    const m = emptyMetrics();
    const status = obj(miner.miner_status);
    const state = toStr(status.miner_state) ?? 'unknown';
    const chains = arr(miner.chains);

    // hr_* fields are in hr_measure units: GH/s on SHA-256 models
    const realtime = toNum(miner.hr_realtime);
    const average = toNum(miner.hr_average);
    m.hashrate_ths = realtime !== null ? realtime / 1000 : null;
    m.hashrate_avg_ths = average !== null ? average / 1000 : null;

    const chip = obj(miner.chip_temp);
    const chipMin = toNum(chip.min);
    // Vnish reports 0 when a sensor is not read (miner off / booting) - treat as "no data", not 0 °C.
    const temp = (v: unknown) => {
      const n = toNum(v);
      return n !== null && n > 0 ? n : null;
    };
    m.temp_max_c = temp(chip.max);
    m.temp_avg_c = temp(chipMin) !== null && m.temp_max_c !== null ? (chipMin! + m.temp_max_c) / 2 : null;
    m.water_in_c = maxOf(chains.map((c) => temp(c.inlet_water_temp)));
    m.water_out_c = maxOf(chains.map((c) => temp(c.outlet_water_temp)));

    const rpms = arr(obj(miner.cooling).fans).map((f) => toNum(f.rpm)).filter((r): r is number => r !== null && r > 0);
    m.fan_rpm_avg = rpms.length ? rpms.reduce((a, b) => a + b, 0) / rpms.length : null;

    m.power_w = toNum(miner.power_consumption);
    const eff = toNum(miner.power_efficiency);
    m.efficiency_jth = eff && eff > 0 ? eff : null;
    m.hw_errors = toNum(miner.hw_errors);
    if (state === 'mining') m.uptime_s = toNum(status.miner_state_time); // only reported for "mining"

    const userPools = arr(miner.pools).filter((p) => p.pool_type !== 'DevFee');
    m.accepted = userPools.reduce((s, p) => s + (toNum(p.accepted) ?? 0), 0);
    m.rejected = userPools.reduce((s, p) => s + (toNum(p.rejected) ?? 0), 0);

    if (state === 'failure') {
      const code = toNum(status.failure_code);
      m.errors.push(`Miner failure${code !== null ? ` #${code}` : ''}: ${toStr(status.description) ?? 'unknown'}`);
    }
    // Chip grades are NOT used for alerts: right after start Vnish reports not-yet-measured chips
    // (hr=0) as "red" although the chain runs at ~100% of ideal. health/ compares chain hashrate instead.
    for (const c of chains) {
      const chainState = toStr(obj(c.status).state) ?? 'unknown';
      if (chainState === 'failure' || chainState === 'disconnected') m.errors.push(`Chain ${c.id}: ${chainState}`);
    }

    const ghsToThs = (v: unknown) => (toNum(v) !== null ? toNum(v)! / 1000 : null);
    const chainIdeal = chains.reduce((sum, c) => sum + (toNum(c.hashrate_ideal) ?? 0), 0);
    const psu = obj(miner.psu);
    m.details = {
      power_source: psu.psu_power_metering === true ? 'measured' : 'calculated',
      locating: statusPane?.find_miner === true,
      state_time_s: toNum(status.miner_state_time),
      state,
      nominal_ths: chainIdeal > 0 ? chainIdeal / 1000 : toNum(miner.hr_nominal) ? ghsToThs(miner.hr_nominal) : null,
      pool: toStr(userPools.find((p) => p.status === 'active')?.url),
      chains: chains.map((c) => ({
        id: toNum(c.id) ?? String(c.id),
        state: toStr(obj(c.status).state),
        hashrate_ths: ghsToThs(c.hashrate_rt),
        ideal_ths: toNum(c.hashrate_ideal) ? ghsToThs(c.hashrate_ideal) : null,
        power_w: toNum(c.power_consumption),
        chip_temp_max_c: toNum(obj(c.chip_temp).max),
        water_in_c: toNum(c.inlet_water_temp),
        water_out_c: toNum(c.outlet_water_temp),
      })),
    };
    return m;
  },

  async tuningInfo(t, timeoutMs) {
    const offsetMin = await tzOffsetMin(t, timeoutMs);
    const res = await fetch(`http://${t.ip}:${t.port}${BASE}/logs/autotune`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`logs/autotune: HTTP ${res.status}`);
    const parsed = parseAutotuneLog(await res.text(), offsetMin);

    // Selected preset + whether it is tuned: needs the API key (settings / presets are protected)
    let preset: string | null = null;
    let presetPretty: string | null = null;
    let presetTuned: boolean | null = null;
    let apiAccess: boolean | null = null;
    if (config.vnish.apiKey || config.vnish.password) {
      try {
        const headers = await authHeaders(t, timeoutMs);
        const [settings, presets] = await Promise.all([
          fetch(`http://${t.ip}:${t.port}${BASE}/settings`, { headers, signal: AbortSignal.timeout(timeoutMs) }).then((r) => {
            apiAccess = r.status !== 401 && r.status !== 403;
            return r.ok ? r.json() : null;
          }),
          fetch(`http://${t.ip}:${t.port}${BASE}/autotune/presets`, { headers, signal: AbortSignal.timeout(timeoutMs) }).then((r) => (r.ok ? r.json() : null)),
        ]);
        preset = toStr(obj(obj(obj(settings).miner).overclock).preset);
        const item = arr(presets).find((p) => toStr(p.name) === preset);
        presetPretty = toStr(item?.pretty) ?? preset;
        presetTuned = item ? item.status === 'tuned' : null;
      } catch (err) {
        // wrong password -> unlock fails with 403
        if (/wrong password|HTTP 40[13]/i.test(String((err as Error)?.message))) apiAccess = false;
      }
    }
    return { preset, presetPretty, presetTuned, apiAccess, ...parsed };
  },

  async recentEvents(t, timeoutMs) {
    const offsetMin = await tzOffsetMin(t, timeoutMs);
    const res = await fetch(`http://${t.ip}:${t.port}${BASE}/logs/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`logs/status: HTTP ${res.status}`);
    return parseStatusLog(await res.text(), offsetMin);
  },

  async execute(t, command, timeoutMs) {
    const path = COMMAND_PATHS[command];
    if (!path) throw new Error(`Unsupported command: ${command}`);
    await postAuthed(t, path, timeoutMs);
  },
};
