import type { AppConfig } from '../config.js';
import { devicesRepo, type DevicePatch, type DeviceRow, type DeviceStatus } from '../db/devices-repo.js';
import { eventsRepo, type DeviceEvent } from '../db/events-repo.js';
import { metricsRepo } from '../db/metrics-repo.js';
import type { Pool } from '../db/pool.js';
import { bus } from '../events.js';
import { createLogger } from '../logger.js';
import { getDriver } from '../miners/index.js';
import { METRIC_KEYS, type MinerIdentity, type MinerMetrics, type MinerTarget } from '../miners/types.js';
import type { MqttBridge } from '../mqtt/bridge.js';
import { normalizeMac } from '../net/arp.js';
import { RelayController } from '../relays/relay.js';
import { errorMessage, sleep } from '../util/async.js';
import { HttpError } from '../util/http-error.js';
import { evaluateHealth, type Health, type HealthSnapshot } from '../health/health.js';
import { requiredFlow } from '../health/coolant.js';
import type { FirmwareEvent, MinerDetails, TuningInfo } from '../miners/types.js';

const log = createLogger('devices');

export type LatestSnapshot = HealthSnapshot;

export interface FoundDevice {
  id: string;
  ip: string;
  port: number;
  driver: string;
  model: string | null;
  mac: string | null;
  isNew: boolean;
}

const sanitizeId = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');

/** Stable device ID: MAC > vendor serial > driver+IP (last resort, changes with DHCP). */
export function resolveDeviceId(identity: MinerIdentity, ip: string, driver: string): string {
  const mac = normalizeMac(identity.mac);
  if (mac) return mac.replace(/:/g, '');
  if (identity.uniqueId) return sanitizeId(identity.uniqueId);
  return sanitizeId(`${driver}_${ip}`);
}

export function capabilitiesOf(metrics: MinerMetrics): string[] {
  return METRIC_KEYS.filter((k) => metrics[k] !== null);
}

/** Device registry + side effects (DB, MQTT discovery, dashboard events, commands). */
export class DeviceService {
  private readonly latest = new Map<string, LatestSnapshot>();
  /** Firmware events inside the health window, per device. */
  private readonly fwEvents = new Map<string, DeviceEvent[]>();
  /** Last coolant flow estimate taken while mining. */
  private readonly lastFlow = new Map<string, { lpm: number; at: Date }>();
  /** Auto-tuning profile / progress (read from the miner's tuner log). */
  private readonly tuning = new Map<string, TuningInfo>();

  setTuning(id: string, info: TuningInfo): void {
    this.tuning.set(id, info);
  }

  snapshotState(id: string): string | null {
    return this.latest.get(id)?.details?.state ?? null;
  }
  private readonly relays: RelayController;
  private readonly relayStates = new Map<string, boolean>();

  constructor(
    private readonly pool: Pool,
    private readonly mqtt: MqttBridge,
    private readonly cfg: AppConfig,
  ) {
    this.relays = new RelayController(mqtt, cfg.relay.timeoutMs);
  }

  /** Imports firmware log events for a device and refreshes the in-memory health window. */
  async ingestFirmwareEvents(id: string, events: FirmwareEvent[]): Promise<number> {
    const added = await eventsRepo.addFirmware(this.pool, id, events);
    const since = Date.now() - this.cfg.firmwareLog.windowH * 3600_000;
    this.fwEvents.set(
      id,
      events
        .filter((e) => e.time.getTime() >= since)
        .map((e) => ({ id: 0, time: e.time, device_id: id, level: e.level, message: e.message, source: 'firmware', code: e.code })),
    );
    return added.length;
  }

  /** Re-reads last flow estimates (after coolant settings changed and history was rescaled). */
  async reloadLastFlow(): Promise<void> {
    this.lastFlow.clear();
    for (const r of await metricsRepo.lastFlow(this.pool, this.cfg.firmwareLog.windowH)) {
      this.lastFlow.set(r.device_id, { lpm: r.coolant_flow_lpm, at: new Date(r.time) });
    }
    bus.publish('device.changed', {});
  }

  async warmCache(): Promise<void> {
    await this.reloadLastFlow();
    for (const e of await eventsRepo.recentFirmware(this.pool, this.cfg.firmwareLog.windowH)) {
      if (!e.device_id) continue;
      const list = this.fwEvents.get(e.device_id) ?? [];
      list.push(e);
      this.fwEvents.set(e.device_id, list);
    }
    for (const row of await metricsRepo.latestPerDevice(this.pool)) {
      const metrics: Record<string, number | null> = {};
      for (const k of METRIC_KEYS) metrics[k] = (row[k] as number | null) ?? null;
      this.latest.set(row.device_id, {
        polledAt: new Date(row.time).toISOString(),
        metrics,
        errors: typeof row.errors === 'string' ? row.errors.split('; ') : [],
        details: (row.extra as MinerDetails | null) ?? null,
        stateSince: null,
      });
    }
  }

  setLatest(id: string, metrics: MinerMetrics): void {
    const values: Record<string, number | null> = {};
    for (const k of METRIC_KEYS) values[k] = metrics[k];
    if (metrics.coolant_flow_lpm !== null) this.lastFlow.set(id, { lpm: metrics.coolant_flow_lpm, at: new Date() });
    const prev = this.latest.get(id);
    const state = metrics.details?.state ?? null;
    const now = new Date().toISOString();
    this.latest.set(id, {
      polledAt: now,
      metrics: values,
      errors: metrics.errors,
      details: metrics.details ?? null,
      stateSince: prev && prev.details?.state === state ? prev.stateSince ?? now : now,
    });
  }

  health(d: DeviceRow, status: DeviceStatus = d.status): Health {
    return evaluateHealth(
      {
        active: d.active,
        status,
        lastError: d.last_error,
        snapshot: this.latest.get(d.id) ?? null,
        firmwareEvents: this.fwEvents.get(d.id),
        // Only hydro miners (reporting water temperatures) have a coolant flow requirement
        requiredFlow: d.capabilities.includes('water_in_c') ? requiredFlow(d.model, this.cfg.coolant) : undefined,
        lastFlow: this.lastFlow.get(d.id) ?? null,
        tuning: this.tuning.get(d.id) ?? null,
      },
      this.cfg.alerts,
      this.cfg.poll.intervalMs,
      { windowH: this.cfg.firmwareLog.windowH },
    );
  }

  async list() {
    const devices = await devicesRepo.listAll(this.pool);
    return devices.map((d) => this.withLatest(d));
  }

  async get(id: string) {
    const d = await devicesRepo.get(this.pool, id);
    if (!d) throw new HttpError(404, `Device ${id} not found`);
    return this.withLatest(d);
  }

  private withLatest(d: DeviceRow) {
    const driver = getDriver(d.driver);
    return {
      ...d,
      commands: [...(driver?.commands ?? []), ...(d.relay ? ['power_cycle', 'relay_on', 'relay_off'] : [])],
      latest: this.latest.get(d.id) ?? null,
      tuning: this.tuning.get(d.id) ?? null,
      health: this.health(d),
    };
  }

  /** Called by the scanner for every validated miner. */
  async registerDiscovered(target: MinerTarget & { driver: string }, identity: MinerIdentity): Promise<FoundDevice> {
    const id = resolveDeviceId(identity, target.ip, target.driver);
    const { device, isNew } = await devicesRepo.upsertDiscovered(this.pool, {
      id,
      mac: normalizeMac(identity.mac),
      ip: target.ip,
      port: target.port,
      driver: target.driver,
      vendor: identity.vendor ?? null,
      model: identity.model ?? null,
      firmware: identity.firmware ?? null,
      hostname: identity.hostname ?? null,
    });

    // Seed capabilities with one poll so HA gets the right sensors immediately
    let current = device;
    const driver = getDriver(target.driver);
    if (driver && device.capabilities.length === 0) {
      try {
        const metrics = await driver.poll(target, this.cfg.poll.timeoutMs);
        current = (await devicesRepo.setCapabilities(this.pool, id, capabilitiesOf(metrics))) ?? device;
        this.setLatest(id, metrics);
      } catch (err) {
        log.debug(`Initial poll of ${target.ip} failed`, err);
      }
    }

    this.publishDiscovery(current);
    if (isNew) await eventsRepo.add(this.pool, id, 'info', `Discovered ${identity.model ?? 'miner'} at ${target.ip}`);
    bus.publish('device.changed', { id });
    return { id, ip: target.ip, port: target.port, driver: target.driver, model: current.model, mac: current.mac, isNew };
  }

  async update(id: string, patch: DevicePatch) {
    const device = await devicesRepo.update(this.pool, id, patch);
    if (!device) throw new HttpError(404, `Device ${id} not found`);
    this.publishDiscovery(device);
    if (patch.active === false) this.mqtt.publishAvailability(id, false);
    bus.publish('device.changed', { id });
    return this.withLatest(device);
  }

  async remove(id: string): Promise<void> {
    const device = await devicesRepo.get(this.pool, id);
    if (!device) throw new HttpError(404, `Device ${id} not found`);
    this.mqtt.removeDiscovery(device);
    await devicesRepo.remove(this.pool, id);
    this.latest.delete(id);
    await eventsRepo.add(this.pool, id, 'info', `Device removed (${device.ip})`);
    bus.publish('device.changed', { id });
  }

  /** Maps a device to a Home Assistant area name (set from the container layout). */
  private areaOf: (d: DeviceRow) => string | undefined = () => undefined;

  setAreaResolver(fn: (d: DeviceRow) => string | undefined): void {
    this.areaOf = fn;
  }

  publishDiscovery(device: DeviceRow): void {
    this.mqtt.publishDiscovery(device, getDriver(device.driver)?.commands ?? [], this.areaOf(device));
    if (device.relay && this.relayStates.has(device.id)) this.mqtt.publishRelayState(device.id, this.relayStates.get(device.id)!);
  }

  async publishAllDiscovery(): Promise<void> {
    const devices = await devicesRepo.listAll(this.pool);
    for (const d of devices) this.publishDiscovery(d);
    log.info(`Published HA discovery for ${devices.length} device(s)`);
  }

  /** Entry point for dashboard buttons and MQTT command topics. */
  async executeCommand(id: string, command: string, source: 'api' | 'mqtt'): Promise<void> {
    const device = await devicesRepo.get(this.pool, id);
    if (!device) throw new HttpError(404, `Device ${id} not found`);

    try {
      if (command === 'relay_on' || command === 'relay_off' || command === 'power_cycle') {
        if (!device.relay) throw new HttpError(400, 'No relay configured for this device');
        if (command === 'power_cycle') {
          await this.setRelay(device, false);
          await sleep(this.cfg.relay.cycleDelayMs);
          await this.setRelay(device, true);
        } else {
          await this.setRelay(device, command === 'relay_on');
        }
      } else {
        const driver = getDriver(device.driver);
        if (!driver?.commands.includes(command)) throw new HttpError(400, `Command "${command}" not supported by ${device.driver}`);
        await driver.execute({ ip: device.ip, port: device.port }, command, this.cfg.poll.timeoutMs);
      }
      await eventsRepo.add(this.pool, id, 'info', `Command "${command}" executed (via ${source})`);
    } catch (err) {
      await eventsRepo.add(this.pool, id, 'error', `Command "${command}" failed: ${errorMessage(err)}`);
      throw err;
    }
  }

  private async setRelay(device: DeviceRow, on: boolean): Promise<void> {
    await this.relays.set(device.relay!, on);
    this.relayStates.set(device.id, on);
    this.mqtt.publishRelayState(device.id, on);
  }

  /** Builds the MQTT state payload. All metric keys are always present (null -> HA "unknown"). */
  buildState(device: DeviceRow, status: DeviceStatus, fresh: boolean) {
    const health = this.health(device, status);
    const snap = fresh ? this.latest.get(device.id) : undefined;
    const problems = health.issues.filter((i) => i.level !== 'info');
    const state: Record<string, unknown> = {
      status,
      online: status === 'online' || status === 'warning',
      ip: device.ip,
      health: health.level,
      miner_state: snap?.details?.state ?? (status === 'offline' ? 'offline' : null),
      hashrate_pct: fresh ? health.hashrate_pct : null,
      coolant_flow_required_lpm: health.flow_required_lpm,
      errors: problems.length ? problems.map((i) => i.text).join('; ').slice(0, 250) : 'none',
    };
    for (const k of METRIC_KEYS) state[k] = snap?.metrics[k] ?? null;
    return state;
  }
}
