/**
 * Local miner simulator for development.
 *
 * Starts MOCK_COUNT fake miners on loopback addresses 127.0.0.<START>... :
 *   even index -> "http-json" driver on :8080   (GET /api/v1/status, POST /api/v1/command)
 *   odd index  -> "cgminer"   driver on :4028   (JSON over TCP: version, summary, stats, get_miner_info, restart)
 *
 * Built-in fault scenarios (by index) to exercise the health engine / dashboard:
 *   2 auto-tuning, 4 chain 2 failure, 6 degraded chain (~80%), 8 low water flow (high ΔT),
 *   9/19 overheating, 12 high reject rate. Everything else is healthy.
 *
 * Windows/Linux route the whole 127.0.0.0/8 to loopback. On macOS add aliases first:
 *   for i in $(seq 11 40); do sudo ifconfig lo0 alias 127.0.0.$i up; done
 *
 * Usage: npm run mock    (env: MOCK_COUNT=20 MOCK_START=11 MOCK_FAIL_RATE=0.01)
 */
import http from 'node:http';
import net from 'node:net';

const COUNT = Number(process.env.MOCK_COUNT ?? 20);
const START = Number(process.env.MOCK_START ?? 11);
const FAIL_RATE = Number(process.env.MOCK_FAIL_RATE ?? 0.01);
const BOOT_MS = 60_000;

const MODELS = [
  { model: 'Antminer S21+ Hydro', vendor: 'Bitmain', ths: 290, watts: 3780, hydro: true },
  { model: 'Antminer S21', vendor: 'Bitmain', ths: 200, watts: 3500, hydro: false },
  { model: 'Antminer S19 XP Hydro', vendor: 'Bitmain', ths: 255, watts: 5300, hydro: true },
];

type Scenario = 'ok' | 'tuning' | 'chain_failure' | 'degraded' | 'low_flow' | 'overheat' | 'rejects';

interface Miner {
  index: number;
  ip: string;
  mac: string;
  serial: string;
  spec: (typeof MODELS)[number];
  scenario: Scenario;
  bootedAt: number;
  temp: number;
  accepted: number;
  rejected: number;
  hwErrors: number;
}

const jitter = (base: number, pct: number) => base * (1 + (Math.random() * 2 - 1) * pct);
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function scenarioFor(i: number): Scenario {
  if (i === 2) return 'tuning';
  if (i === 4) return 'chain_failure';
  if (i === 6) return 'degraded';
  if (i === 8) return 'low_flow';
  if (i % 10 === 9) return 'overheat';
  if (i === 12) return 'rejects';
  return 'ok';
}

function snapshot(m: Miner) {
  const sinceBoot = Date.now() - m.bootedAt;
  const booting = sinceBoot < BOOT_MS;
  const state = booting ? 'initializing' : m.scenario === 'tuning' ? 'auto-tuning' : 'mining';
  const s = m.spec;
  const chainIdeal = s.ths / 3;

  // Thermal model: hydro chips run cool, air-cooled hotter; overheat scenario drifts up to ~92°C
  const baseTemp = s.hydro ? 48 : 68;
  m.temp = m.scenario === 'overheat' ? Math.min(93, m.temp + Math.random() * 0.8) : jitter(baseTemp, 0.04);

  const chainFactor = [1, 1, 1];
  if (m.scenario === 'chain_failure') chainFactor[1] = 0;
  if (m.scenario === 'degraded') chainFactor[0] = 0.42; // overall ~81%
  if (m.scenario === 'tuning') chainFactor.fill(0.93);

  const chains = [1, 2, 3].map((id, k) => {
    const hr = booting ? 0 : jitter(chainIdeal * chainFactor[k], 0.02);
    return {
      id,
      state: booting ? 'initializing' : chainFactor[k] === 0 ? 'failure' : 'mining',
      hashrate_ths: round(hr),
      ideal_ths: round(chainIdeal),
      power_w: booting ? 0 : Math.round((s.watts / 3) * (chainFactor[k] === 0 ? 0 : 1) * jitter(1, 0.01)),
      chip_temp_max_c: booting ? null : round(m.temp + k, 0),
      water_in_c: s.hydro ? round(jitter(m.scenario === 'low_flow' ? 24 : 22, 0.02), 1) : null,
      water_out_c: s.hydro ? round(jitter(m.scenario === 'low_flow' ? 42 : 30, 0.02), 1) : null,
    };
  });

  const hashrate = chains.reduce((a, c) => a + c.hashrate_ths, 0);
  const power = booting ? 40 : chains.reduce((a, c) => a + c.power_w, 0);
  if (!booting) {
    const shares = Math.round(Math.random() * 6);
    m.accepted += shares;
    if (m.scenario === 'rejects' ? Math.random() < 0.3 : Math.random() < 0.003) m.rejected++;
    if (Math.random() < 0.02) m.hwErrors++;
  }

  return {
    state,
    errors: chains.filter((c) => c.state === 'failure').map((c) => `Chain ${c.id}: failure`),
    chains,
    metrics: {
      hashrate_ths: round(hashrate),
      hashrate_avg_ths: booting ? 0 : round(s.ths * (chainFactor.reduce((a, b) => a + b, 0) / 3)),
      temp_max_c: booting ? null : round(m.temp + 2, 0),
      temp_avg_c: booting ? null : round(m.temp - 4, 1),
      water_in_c: s.hydro ? Math.max(...chains.map((c) => c.water_in_c ?? 0)) : null,
      water_out_c: s.hydro ? Math.max(...chains.map((c) => c.water_out_c ?? 0)) : null,
      fan_rpm_avg: s.hydro ? null : Math.round(jitter(5400, 0.05)),
      power_w: power,
      accepted: m.accepted,
      rejected: m.rejected,
      hw_errors: m.hwErrors,
      uptime_s: booting ? 0 : Math.round((sinceBoot - BOOT_MS) / 1000),
    },
  };
}

const shouldFail = () => Math.random() < FAIL_RATE;

function restart(m: Miner, command: string) {
  console.log(`[mock ${m.ip}] ${command}`);
  m.bootedAt = Date.now();
}

function startHttpMiner(m: Miner): void {
  const server = http.createServer((req, res) => {
    if (shouldFail()) return req.socket.destroy();
    if (req.method === 'GET' && req.url === '/api/v1/status') {
      const snap = snapshot(m);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          type: 'miner',
          id: m.serial,
          mac: m.mac,
          model: m.spec.model,
          vendor: m.spec.vendor,
          firmware: 'mock-1.0.0',
          hostname: `M${String(m.index + 1).padStart(2, '0')}`,
          metrics: {
            ...snap.metrics,
            errors: snap.errors,
            details: { state: snap.state, nominal_ths: m.spec.ths, pool: 'stratum+tcp://pool.example:3333', chains: snap.chains },
          },
        }),
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v1/command') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        restart(m, JSON.parse(body || '{}').command);
        res.end('{"ok":true}');
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(8080, m.ip);
}

function startCgminer(m: Miner): void {
  const server = net.createServer((socket) => {
    socket.once('data', (buf) => {
      if (shouldFail()) return socket.destroy();
      let command = '';
      try {
        command = JSON.parse(buf.toString()).command;
      } catch {
        // ignore
      }
      const when = Math.floor(Date.now() / 1000);
      const status = (msg: string) => [{ STATUS: 'S', When: when, Code: 11, Msg: msg, Description: 'mock cgminer' }];
      const snap = snapshot(m);
      const s = snap.metrics;
      let resp: unknown;
      switch (command) {
        case 'version':
          resp = { STATUS: status('CGMiner versions'), VERSION: [{ CGMiner: '4.11.1', API: '3.7', Type: m.spec.model, CompileTime: 'mock' }] };
          break;
        case 'summary':
          resp = {
            STATUS: status('Summary'),
            SUMMARY: [{ Elapsed: s.uptime_s, 'GHS 5s': (s.hashrate_ths * 1000).toFixed(2), 'GHS av': s.hashrate_avg_ths * 1000, Accepted: s.accepted, Rejected: s.rejected, 'Hardware Errors': s.hw_errors }],
          };
          break;
        case 'stats': {
          const st: Record<string, unknown> = {
            state: snap.state,
            total_rateideal: m.spec.ths * 1000,
            temp1: s.temp_avg_c ?? 0,
            temp2_1: s.temp_max_c ?? 0,
          };
          if (s.fan_rpm_avg) Object.assign(st, { fan1: s.fan_rpm_avg, fan2: s.fan_rpm_avg });
          for (const c of snap.chains) {
            st[`chain_rate${c.id}`] = c.hashrate_ths * 1000;
            st[`chain_rateideal${c.id}`] = c.ideal_ths * 1000;
            st[`chain_consumption${c.id}`] = c.power_w;
            st[`chain_state${c.id}`] = c.state;
            st[`chain_fault${c.id}`] = c.state === 'failure' ? 'failure' : '';
          }
          resp = { STATUS: status('CGMiner stats'), STATS: [{ CGMiner: '4.11.1', Type: m.spec.model }, st] };
          break;
        }
        case 'get_miner_info':
          resp = { STATUS: 'S', Msg: { mac: m.mac, hostname: `M${String(m.index + 1).padStart(2, '0')}` } };
          break;
        case 'restart':
          restart(m, 'restart');
          resp = { STATUS: status('RESTART') };
          break;
        default:
          resp = { STATUS: [{ STATUS: 'E', When: when, Code: 14, Msg: 'Invalid command' }] };
      }
      socket.end(JSON.stringify(resp) + '\0');
    });
    socket.on('error', () => undefined);
  });
  server.listen(4028, m.ip);
}

for (let i = 0; i < COUNT; i++) {
  const octet = START + i;
  const m: Miner = {
    index: i,
    ip: `127.0.0.${octet}`,
    mac: `02:00:00:00:00:${octet.toString(16).padStart(2, '0')}`,
    serial: `MOCK${String(octet).padStart(6, '0')}`,
    spec: MODELS[i % MODELS.length],
    scenario: scenarioFor(i),
    bootedAt: Date.now() - BOOT_MS - 3600_000 - Math.round(Math.random() * 86_400_000),
    temp: 60,
    accepted: 2000 + Math.round(Math.random() * 10_000),
    rejected: 0,
    hwErrors: 0,
  };
  if (m.scenario === 'rejects') m.rejected = Math.round(m.accepted * 0.04);
  if (m.scenario === 'overheat') m.temp = 80;
  if (i % 2 === 0) startHttpMiner(m);
  else startCgminer(m);
}

console.log(`Mock miners: ${COUNT} devices on 127.0.0.${START}-${START + COUNT - 1} (even=http-json:8080, odd=cgminer:4028)`);
console.log(`Scan range for the dashboard: 127.0.0.${START}-${START + COUNT - 1}`);
