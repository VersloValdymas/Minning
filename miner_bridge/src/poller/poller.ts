import type { AppConfig } from '../config.js';
import { devicesRepo, type DeviceRow, type DeviceStatus, type PollResultUpdate } from '../db/devices-repo.js';
import { eventsRepo } from '../db/events-repo.js';
import { metricsRepo, type MetricRow } from '../db/metrics-repo.js';
import type { Pool } from '../db/pool.js';
import { bus } from '../events.js';
import { createLogger } from '../logger.js';
import { getDriver } from '../miners/index.js';
import type { MinerMetrics } from '../miners/types.js';
import type { MqttBridge } from '../mqtt/bridge.js';
import { capabilitiesOf, type DeviceService } from '../services/device-service.js';
import type { EarningsService } from '../earnings/earnings-service.js';
import { isProblem } from '../health/health.js';
import { estimateFlowLpm } from '../health/coolant.js';
import { errorMessage, mapLimit } from '../util/async.js';

const log = createLogger('poller');

/** Firmware states in which hashboards are off. */
const NOT_HASHING = new Set(['stopped', 'paused', 'shutting-down', 'initializing', 'starting', 'restarting']);

type Outcome = { device: DeviceRow; ok: true; metrics: MinerMetrics } | { device: DeviceRow; ok: false; error: string };

/**
 * Non-blocking polling loop: every interval, polls all active devices in parallel
 * (bounded by poll.concurrency), then writes one batched INSERT and one batched UPDATE.
 * Cycles never overlap - the next one is scheduled after the current one finishes.
 */
export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private lastFirmwareRead = 0;
  private stopped = true;
  private lastCycle: { at: string; durationMs: number; devices: number; online: number; totalHashrateThs: number } | null = null;

  constructor(
    private readonly cfg: AppConfig,
    private readonly pool: Pool,
    private readonly devices: DeviceService,
    private readonly mqtt: MqttBridge,
    private readonly earnings: EarningsService,
  ) {}

  get stats() {
    return this.lastCycle;
  }

  start(): void {
    this.stopped = false;
    this.schedule(1000);
    log.info(`Polling every ${this.cfg.poll.intervalMs / 1000}s (concurrency ${this.cfg.poll.concurrency})`);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    const started = Date.now();
    try {
      await this.cycle();
    } catch (err) {
      log.error('Poll cycle failed', err);
    }
    const elapsed = Date.now() - started;
    if (elapsed > this.cfg.poll.intervalMs) log.warn(`Poll cycle took ${elapsed}ms (> interval) - consider higher concurrency`);
    this.schedule(Math.max(0, this.cfg.poll.intervalMs - elapsed));
  }

  private async pollDevice(device: DeviceRow): Promise<Outcome> {
    const driver = getDriver(device.driver);
    if (!driver) return { device, ok: false, error: `Unknown driver ${device.driver}` };
    try {
      const metrics = await driver.poll({ ip: device.ip, port: device.port }, this.cfg.poll.timeoutMs);
      this.enrich(metrics);
      return { device, ok: true, metrics };
    } catch (err) {
      return { device, ok: false, error: errorMessage(err) };
    }
  }

  /** Derived values common to every driver. Alert rules live in health/health.ts. */
  private enrich(m: MinerMetrics): void {
    if (m.details?.power_source !== 'estimated' && m.details?.power_source !== 'unmeasured') {
      m.coolant_flow_lpm = estimateFlowLpm(m.power_w, m.water_in_c, m.water_out_c, this.cfg.coolant);
    }
    // Not hashing -> hashboards are off and firmware reports 0 W, yet the miner still draws standby power.
    const state = m.details?.state;
    if (m.details && state && NOT_HASHING.has(state) && !m.power_w && m.details.power_source !== 'measured') {
      const standby = this.cfg.power.standbyW;
      m.power_w = standby > 0 ? standby : null;
      m.details.power_source = standby > 0 ? 'estimated' : 'unmeasured';
      m.efficiency_jth = null;
    }
    if (m.efficiency_jth === null && m.power_w && m.hashrate_ths) {
      m.efficiency_jth = Math.round((m.power_w / m.hashrate_ths) * 10) / 10;
    }
  }

  async cycle(): Promise<void> {
    const started = Date.now();
    const active = await devicesRepo.listActive(this.pool);
    if (active.length === 0) return;

    const now = new Date();
    const outcomes = await mapLimit(active, this.cfg.poll.concurrency, (d) => this.pollDevice(d));

    const metricRows: MetricRow[] = [];
    const updates: PollResultUpdate[] = [];
    let online = 0;
    let totalHashrate = 0;
    let totalPowerW = 0;

    for (const o of outcomes) {
      const d = o.device;
      let status: DeviceStatus;
      let failures: number;

      if (o.ok) {
        failures = 0;
        this.devices.setLatest(d.id, o.metrics);
        const health = this.devices.health(d, 'online');
        status = isProblem(health) ? 'warning' : 'online';
        const problems = health.issues.filter((i) => i.level !== 'info').map((i) => i.text);
        online++;
        totalHashrate += o.metrics.hashrate_ths ?? 0;
        totalPowerW += o.metrics.power_w ?? 0;
        metricRows.push({ time: now, deviceId: d.id, online: true, metrics: o.metrics });
        updates.push({ id: d.id, status, lastError: problems.join('; ') || null, failures, lastSeen: now });
        await this.maybeExtendCapabilities(d, o.metrics);
      } else {
        failures = d.consecutive_failures + 1;
        status = failures >= this.cfg.poll.offlineAfterFailures ? 'offline' : d.status;
        metricRows.push({ time: now, deviceId: d.id, online: false, metrics: null });
        updates.push({ id: d.id, status, lastError: o.error, failures, lastSeen: null });
        log.debug(`${d.ip} poll failed (${failures}x): ${o.error}`);
      }

      this.mqtt.publishAvailability(d.id, status !== 'offline');
      const lastError = updates[updates.length - 1].lastError;
      this.mqtt.publishState(d.id, this.devices.buildState({ ...d, last_error: lastError }, status, o.ok));

      if (status !== d.status) {
        const level = status === 'offline' ? 'error' : status === 'warning' ? 'warn' : 'info';
        const detail = lastError;
        await eventsRepo.add(this.pool, d.id, level, `Status ${d.status} → ${status}${detail ? `: ${detail}` : ''}`);
      }
    }

    await metricsRepo.insertBatch(this.pool, metricRows);
    await devicesRepo.applyPollResults(this.pool, updates);
    await this.readFirmwareLogs(outcomes.filter((o) => o.ok).map((o) => o.device));

    const minersKw = totalPowerW / 1000;
    this.earnings.accrue(minersKw).catch(() => undefined);
    if (this.earnings.current.configured) this.mqtt.publishFleetEconomics(this.earnings.fleetEconomics(minersKw) as unknown as Record<string, number | null>);
    this.lastCycle = {
      at: now.toISOString(),
      durationMs: Date.now() - started,
      devices: active.length,
      online,
      totalHashrateThs: Math.round(totalHashrate * 100) / 100,
    };
    log.debug(`Cycle: ${online}/${active.length} online, ${this.lastCycle.totalHashrateThs} TH/s, ${this.lastCycle.durationMs}ms`);
    bus.publish('poll.cycle', this.lastCycle);
  }

  /**
   * Firmware protection trips (overheat, chain break) happen and recover within seconds - between our
   * polls. Reading the miner's own log is the only way to see them. Runs every firmwareLog.intervalMs.
   */
  private readonly lastTuningRead = new Map<string, number>();

  /** Re-read tuning / API access for all miners in the next cycle (e.g. after keys were added). */
  forceTuningRead(): void {
    this.lastTuningRead.clear();
    this.lastFirmwareRead = 0;
  }

  /** Auto-tuning progress: each firmware-log cycle while tuning, every 10 min otherwise (preset / tuned state). */
  private async readTuning(reachable: DeviceRow[]): Promise<void> {
    const now = Date.now();
    const targets = reachable.filter((d) => {
      if (!getDriver(d.driver)?.tuningInfo) return false;
      const tuning = this.devices.snapshotState(d.id) === 'auto-tuning';
      return tuning || now - (this.lastTuningRead.get(d.id) ?? 0) > 600_000;
    });
    await mapLimit(targets, 5, async (d) => {
      try {
        const info = await getDriver(d.driver)!.tuningInfo!({ ip: d.ip, port: d.port }, this.cfg.poll.timeoutMs * 2);
        this.devices.setTuning(d.id, info);
        this.lastTuningRead.set(d.id, now);
      } catch (err) {
        log.debug(`${d.ip}: tuning info read failed: ${errorMessage(err)}`);
      }
    });
  }

  private async readFirmwareLogs(reachable: DeviceRow[]): Promise<void> {
    if (Date.now() - this.lastFirmwareRead < this.cfg.firmwareLog.intervalMs) return;
    this.lastFirmwareRead = Date.now();
    await this.readTuning(reachable);
    const targets = reachable.filter((d) => getDriver(d.driver)?.recentEvents);
    await mapLimit(targets, 5, async (d) => {
      try {
        const events = await getDriver(d.driver)!.recentEvents!({ ip: d.ip, port: d.port }, this.cfg.poll.timeoutMs * 2);
        const added = await this.devices.ingestFirmwareEvents(d.id, events);
        if (added) log.info(`${d.ip}: ${added} new firmware event(s)`);
      } catch (err) {
        log.debug(`${d.ip}: firmware log read failed: ${errorMessage(err)}`);
      }
    });
  }

  /** New metric showed up (e.g. after firmware update) -> add HA sensor. Never shrinks. */
  private async maybeExtendCapabilities(d: DeviceRow, metrics: MinerMetrics): Promise<void> {
    const known = new Set(d.capabilities);
    const added = capabilitiesOf(metrics).filter((k) => !known.has(k));
    if (added.length === 0) return;
    const updated = await devicesRepo.setCapabilities(this.pool, d.id, [...known, ...added]);
    if (updated) this.devices.publishDiscovery(updated);
  }
}
