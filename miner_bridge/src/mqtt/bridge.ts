import { EventEmitter } from 'node:events';
import mqtt, { type MqttClient } from 'mqtt';
import type { AppConfig } from '../config.js';
import type { DeviceRow } from '../db/devices-repo.js';
import { createLogger } from '../logger.js';
import { buildDiscovery, topics, type TopicConfig } from './discovery.js';

const log = createLogger('mqtt');

export interface MqttBridgeEvents {
  connected: [];
  /** HA restarted (homeassistant/status = online) - discovery must be re-sent. */
  'ha-online': [];
  command: [deviceId: string, command: string];
}

/**
 * Wraps mqtt.js. When no broker is configured all publish calls are no-ops,
 * so the rest of the app never has to check.
 */
export class MqttBridge extends EventEmitter<MqttBridgeEvents> {
  private client: MqttClient | null = null;
  private readonly topicCfg: TopicConfig;

  constructor(private readonly cfg: AppConfig['mqtt'], private readonly version: string) {
    super();
    this.topicCfg = { discoveryPrefix: cfg.discoveryPrefix, baseTopic: cfg.baseTopic };
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  connect(): void {
    if (!this.cfg.url && !this.cfg.host) {
      log.warn('MQTT_HOST/MQTT_URL not set - MQTT bridge disabled');
      return;
    }
    const url = this.cfg.url ?? `mqtt://${this.cfg.host}:${this.cfg.port}`;
    const t = topics(this.topicCfg);
    log.info(`Connecting to ${url.replace(/\/\/[^@]*@/, '//***@')}`);

    const client = mqtt.connect(url, {
      clientId: this.cfg.clientId,
      username: this.cfg.username,
      password: this.cfg.password,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
      will: { topic: t.bridgeStatus, payload: Buffer.from('offline'), retain: true, qos: 1 },
    });
    this.client = client;

    client.on('connect', () => {
      log.info('Connected');
      client.publish(t.bridgeStatus, 'online', { retain: true, qos: 1 });
      client.subscribe([t.commandWildcard, t.relaySetWildcard, t.haStatus], { qos: 1 }, (err) => {
        if (err) log.error('Subscribe failed', err);
      });
      this.emit('connected');
    });
    client.on('message', (topic, payload) => this.route(topic, payload.toString().trim()));
    client.on('reconnect', () => log.debug('Reconnecting...'));
    client.on('offline', () => log.warn('Broker offline'));
    client.on('error', (err) => log.warn('Client error', err));
  }

  private route(topic: string, payload: string): void {
    const t = topics(this.topicCfg);
    if (topic === t.haStatus) {
      if (payload === 'online') this.emit('ha-online');
      return;
    }
    const rest = topic.slice(this.cfg.baseTopic.length + 1).split('/');
    const deviceId = rest[0];
    if (rest.length === 2 && rest[1] === 'command') {
      this.emit('command', deviceId, payload);
    } else if (rest.length === 3 && rest[1] === 'relay' && rest[2] === 'set') {
      const on = payload.toUpperCase() === 'ON';
      this.emit('command', deviceId, on ? 'relay_on' : 'relay_off');
    }
  }

  publish(topic: string, payload: string | object, opts: { retain?: boolean; qos?: 0 | 1 } = {}): void {
    if (!this.client) return;
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.client.publish(topic, body, { retain: opts.retain ?? false, qos: opts.qos ?? 0 });
  }

  /** Publishes (or reconciles) all HA discovery configs for one device. */
  publishDiscovery(device: DeviceRow, driverCommands: readonly string[], area?: string): void {
    for (const m of buildDiscovery(this.topicCfg, device, driverCommands, this.version, false, area)) {
      this.publish(m.topic, m.payload ?? '', { retain: true, qos: 1 });
    }
  }

  removeDiscovery(device: DeviceRow): void {
    for (const m of buildDiscovery(this.topicCfg, device, [], this.version, true)) {
      this.publish(m.topic, '', { retain: true, qos: 1 });
    }
    const t = topics(this.topicCfg, device.id);
    for (const topic of [t.state, t.availability, t.relayState]) this.publish(topic, '', { retain: true });
  }

  publishState(deviceId: string, state: Record<string, unknown>): void {
    this.publish(topics(this.topicCfg, deviceId).state, state, { retain: true });
  }

  publishAvailability(deviceId: string, online: boolean): void {
    this.publish(topics(this.topicCfg, deviceId).availability, online ? 'online' : 'offline', { retain: true, qos: 1 });
  }

  publishRelayState(deviceId: string, on: boolean): void {
    this.publish(topics(this.topicCfg, deviceId).relayState, on ? 'ON' : 'OFF', { retain: true, qos: 1 });
  }

  async close(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    if (client.connected) {
      await new Promise<void>((resolve) =>
        client.publish(topics(this.topicCfg).bridgeStatus, 'offline', { retain: true, qos: 1 }, () => resolve()),
      );
    }
    await client.endAsync();
  }
}
