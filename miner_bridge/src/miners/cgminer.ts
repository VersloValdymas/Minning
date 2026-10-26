import net from 'node:net';
import {
  emptyMetrics,
  type ChainInfo,
  type MinerDetails,
  guessVendor,
  toNum,
  toStr,
  type MinerDriver,
  type MinerIdentity,
  type MinerMetrics,
  type MinerTarget,
} from './types.js';

type Obj = Record<string, unknown>;

/**
 * CGMiner-compatible JSON-over-TCP API (port 4028).
 * Spoken by Antminer (bmminer/cgminer), Whatsminer (btminer, read-only part), Avalon and many others.
 * Field names differ between vendors, so parsing below is best-effort - extend per model as needed.
 */
function requestRaw(t: MinerTarget, payload: Obj, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: t.ip, port: t.port });
    const chunks: Buffer[] = [];
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => socket.write(JSON.stringify(payload)));
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('timeout', () => socket.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    socket.on('error', reject);
  });
}

function parseResponse(text: string): Obj {
  const cleaned = text.replace(/\0/g, '').trim();
  try {
    return JSON.parse(cleaned) as Obj;
  } catch {
    // Antminer "stats" is known to omit commas between objects inside STATS: "}{"
    return JSON.parse(cleaned.replace(/}\s*{/g, '},{')) as Obj;
  }
}

async function request(t: MinerTarget, command: string, timeoutMs: number): Promise<Obj> {
  const res = parseResponse(await requestRaw(t, { command }, timeoutMs));
  const status = firstObj(res.STATUS);
  if (status?.STATUS === 'E') throw new Error(`${command}: ${toStr(status.Msg) ?? 'error'}`);
  return res;
}

function firstObj(v: unknown): Obj | null {
  if (Array.isArray(v)) return (v.find((x) => x && typeof x === 'object') as Obj) ?? null;
  return v && typeof v === 'object' ? (v as Obj) : null;
}

/** Hashrate in TH/s from GHS or MHS fields. */
function ths(o: Obj, ghsKey: string, mhsKey: string): number | null {
  const ghs = toNum(o[ghsKey]);
  if (ghs !== null) return ghs / 1000;
  const mhs = toNum(o[mhsKey]);
  return mhs !== null ? mhs / 1e6 : null;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Per-chain data from Antminer-style stats (chain_rateN / chain_rateidealN are GH/s). Vnish adds "state". */
function parseDetails(stats: Obj[]): MinerDetails | undefined {
  const s = Object.assign({}, ...stats.filter((e) => e && typeof e === 'object')) as Obj;
  const ids = Object.keys(s)
    .map((k) => /^chain_rate(d+)$/.exec(k)?.[1])
    .filter((x): x is string => Boolean(x));
  if (ids.length === 0 && s.state === undefined) return undefined;
  const ths = (v: unknown) => (toNum(v) !== null ? toNum(v)! / 1000 : null);
  const chains: ChainInfo[] = ids.map((i) => ({
    id: Number(i),
    state: toStr(s[`chain_state${i}`]),
    hashrate_ths: ths(s[`chain_rate${i}`]),
    ideal_ths: toNum(s[`chain_rateideal${i}`]) ? ths(s[`chain_rateideal${i}`]) : null,
    power_w: toNum(s[`chain_consumption${i}`]) ?? null,
    chip_temp_max_c: null,
  }));
  const totalIdeal = toNum(s.total_rateideal);
  const chainIdeal = chains.reduce((sum, c) => sum + (c.ideal_ths ?? 0), 0);
  return {
    state: toStr(s.state),
    nominal_ths: totalIdeal ? totalIdeal / 1000 : chainIdeal > 0 ? chainIdeal : null,
    pool: null,
    chains,
  };
}

function parseMetrics(summaryRes: Obj, statsRes: Obj | null): MinerMetrics {
  const m = emptyMetrics();
  const s = firstObj(summaryRes.SUMMARY) ?? {};

  m.hashrate_ths = ths(s, 'GHS 5s', 'MHS 5s') ?? ths(s, 'GHS 1m', 'MHS 1m');
  m.hashrate_avg_ths = ths(s, 'GHS av', 'MHS av');
  m.accepted = toNum(s.Accepted);
  m.rejected = toNum(s.Rejected);
  m.hw_errors = toNum(s['Hardware Errors']);
  m.uptime_s = toNum(s.Elapsed);
  m.power_w = toNum(s.Power); // Whatsminer

  const temps: number[] = [];
  const fans: number[] = [];
  const addTemp = (v: unknown) => {
    const parts = typeof v === 'string' ? v.split('-') : [v];
    for (const p of parts) {
      const n = toNum(p);
      if (n !== null && n > 0 && n < 150) temps.push(n);
    }
  };
  if (s.Temperature !== undefined) addTemp(s.Temperature);
  for (const k of ['Fan Speed In', 'Fan Speed Out']) {
    const n = toNum(s[k]);
    if (n !== null && n > 0) fans.push(n);
  }

  const stats = Array.isArray(statsRes?.STATS) ? (statsRes.STATS as Obj[]) : [];
  let chainPower: number | null = null;
  for (const entry of stats) {
    for (const [k, v] of Object.entries(entry ?? {})) {
      if (/^temp(_?chip|_?pcb|_?sens|\d|2_)/i.test(k)) addTemp(v);
      else if (/^chain_consumption\d+$/i.test(k)) chainPower = (chainPower ?? 0) + (toNum(v) ?? 0); // Vnish
      else if (/^chain_fault\d+$/i.test(k) && toStr(v)) m.errors.push(`${k.replace('chain_fault', 'chain ')}: ${toStr(v)}`);
      else if (/^fan\d+$/i.test(k)) {
        const n = toNum(v);
        if (n !== null && n > 0) fans.push(n);
      } else if (/^chain_acs\d+$/i.test(k) && typeof v === 'string') {
        const bad = (v.match(/x/gi) ?? []).length;
        if (bad > 0) m.errors.push(`${k.replace('chain_acs', 'chain ')}: ${bad} bad chips`);
      } else if (m.power_w === null && /^(chain_power|power)$/i.test(k)) {
        m.power_w = toNum(v);
      }
    }
  }

  if (m.power_w === null && chainPower !== null && chainPower > 0) m.power_w = chainPower;
  m.temp_max_c = temps.length ? Math.max(...temps) : null;
  m.temp_avg_c = avg(temps);
  m.fan_rpm_avg = avg(fans);

  const st = firstObj(summaryRes.STATUS);
  if (st?.STATUS === 'W') m.errors.push(toStr(st.Msg) ?? 'warning');
  m.details = parseDetails(stats);
  return m;
}

export const cgminerDriver: MinerDriver = {
  name: 'cgminer',
  label: 'CGMiner API (TCP 4028: Antminer, Whatsminer, Avalon...)',
  defaultPort: 4028,
  commands: ['restart'],

  async probe(t, timeoutMs) {
    try {
      // "stats" is the most widely supported command (Vnish rejects "version" as invalid).
      const stats = await request(t, 'stats', timeoutMs).catch(() => null);
      const ver = await request(t, 'version', timeoutMs).catch(() => null);
      const isApi = (r: Obj | null) => r !== null && (Array.isArray(r.STATUS) || typeof r.STATUS === 'string');
      if (!isApi(stats) && !isApi(ver)) return null; // not a cgminer API

      const v = firstObj(ver?.VERSION) ?? {};
      const entries = Array.isArray(stats?.STATS) ? (stats.STATS as Obj[]) : [];
      const model =
        toStr(v.Type) ?? toStr(v.Model) ?? toStr(v.PROD) ?? entries.map((e) => toStr(e?.Type)).find(Boolean) ?? null;
      const firmware =
        toStr(v.CompileTime) ?? toStr(v.BMMiner) ?? toStr(v.CGMiner) ?? toStr(v.Miner) ?? toStr(entries[0]?.CompileTime);

      // Whatsminer exposes MAC via get_miner_info; others will fall back to the ARP cache.
      const info = await request(t, 'get_miner_info', timeoutMs).catch(() => null);
      const infoMsg = firstObj(info?.Msg);

      const identity: MinerIdentity = {
        model: model ?? 'CGMiner-compatible',
        vendor: guessVendor(model),
        firmware,
        mac: toStr(infoMsg?.mac),
        hostname: toStr(infoMsg?.hostname),
      };
      return identity;
    } catch {
      return null;
    }
  },

  async poll(t, timeoutMs) {
    // Sequential on purpose: some firmwares handle concurrent API connections poorly.
    // Either command alone is enough; "stats" carries GHS/Elapsed too when "summary" stalls (e.g. during boot).
    const summary = await request(t, 'summary', timeoutMs).catch(() => null);
    const stats = await request(t, 'stats', timeoutMs).catch((err) => {
      if (!summary) throw err;
      return null;
    });
    return parseMetrics(summary ?? { SUMMARY: (stats?.STATS as Obj[] | undefined)?.slice(1) ?? [] }, stats);
  },

  async execute(t, command, timeoutMs) {
    if (command !== 'restart') throw new Error(`Unsupported command: ${command}`);
    // Requires API write access (e.g. Antminer "api-allow" W: flag). Response is often not JSON.
    const text = await requestRaw(t, { command: 'restart' }, timeoutMs);
    if (/"STATUS"\s*:\s*"E"/.test(text) || /Access denied/i.test(text)) {
      throw new Error(`Miner rejected restart: ${text.slice(0, 200)}`);
    }
  },
};
