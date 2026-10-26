import { METRIC_KEYS, emptyMetrics, guessVendor, toNum, toStr, type ChainInfo, type MinerDriver } from './types.js';

/**
 * Generic HTTP JSON driver for custom firmware, ESP-based bridges and the bundled mock (tools/mock-miners.ts).
 *
 * GET  /api/v1/status  -> { "type": "miner", "id", "mac", "model", "vendor", "firmware", "hostname",
 *                          "metrics": { <METRIC_KEYS>..., "errors": ["..."],
 *                                       "details": { "state", "nominal_ths", "pool", "chains": [ChainInfo] } } }
 * POST /api/v1/command -> body { "command": "restart" | "reboot" }
 */
const STATUS_PATH = '/api/v1/status';
const COMMAND_PATH = '/api/v1/command';

const url = (ip: string, port: number, p: string) => `http://${ip}:${port}${p}`;

async function getStatus(ip: string, port: number, timeoutMs: number): Promise<Record<string, unknown>> {
  const res = await fetch(url(ip, port, STATUS_PATH), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

export const httpJsonDriver: MinerDriver = {
  name: 'http-json',
  label: 'Generic HTTP JSON (/api/v1/status)',
  defaultPort: 8080,
  commands: ['restart', 'reboot'],

  async probe(t, timeoutMs) {
    try {
      const body = await getStatus(t.ip, t.port, timeoutMs);
      if (body.type !== 'miner') return null;
      const model = toStr(body.model);
      return {
        uniqueId: toStr(body.id),
        mac: toStr(body.mac),
        model,
        vendor: toStr(body.vendor) ?? guessVendor(model),
        firmware: toStr(body.firmware),
        hostname: toStr(body.hostname),
      };
    } catch {
      return null;
    }
  },

  async poll(t, timeoutMs) {
    const body = await getStatus(t.ip, t.port, timeoutMs);
    const src = (body.metrics ?? {}) as Record<string, unknown>;
    const m = emptyMetrics();
    for (const k of METRIC_KEYS) m[k] = toNum(src[k]);
    if (Array.isArray(src.errors)) m.errors = src.errors.map(String);
    const d = src.details as Record<string, unknown> | undefined;
    if (d && typeof d === 'object') {
      m.details = {
        state: toStr(d.state),
        nominal_ths: toNum(d.nominal_ths),
        pool: toStr(d.pool),
        chains: Array.isArray(d.chains) ? (d.chains as ChainInfo[]) : [],
      };
    }
    return m;
  },

  async execute(t, command, timeoutMs) {
    if (!this.commands.includes(command)) throw new Error(`Unsupported command: ${command}`);
    const res = await fetch(url(t.ip, t.port, COMMAND_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Miner returned HTTP ${res.status}`);
  },
};
