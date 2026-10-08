import type { MqttBridge } from '../mqtt/bridge.js';
import { HttpError } from '../util/http-error.js';

/**
 * Optional power relay per miner.
 *  - http: any relay with on/off URLs (Shelly Gen1: http://IP/relay/0?turn=on, Gen2: http://IP/rpc/Switch.Set?id=0&on=true)
 *  - mqtt: relay controlled via MQTT topic (Tasmota, ESPHome, Zigbee2MQTT...)
 */
export type RelayConfig =
  | { type: 'http'; on_url: string; off_url: string; method?: 'GET' | 'POST' }
  | { type: 'mqtt'; command_topic: string; payload_on?: string; payload_off?: string };

const isHttpUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\/.+/i.test(v);

/** Validates untrusted input (API body). Throws HttpError(400) when invalid. */
export function parseRelayConfig(input: unknown): RelayConfig {
  const v = input as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') throw new HttpError(400, 'relay must be an object or null');
  if (v.type === 'http') {
    if (!isHttpUrl(v.on_url) || !isHttpUrl(v.off_url)) throw new HttpError(400, 'relay.on_url and relay.off_url must be http(s) URLs');
    const method = v.method === 'POST' ? 'POST' : 'GET';
    return { type: 'http', on_url: v.on_url, off_url: v.off_url, method };
  }
  if (v.type === 'mqtt') {
    if (typeof v.command_topic !== 'string' || !v.command_topic || /[#+]/.test(v.command_topic)) {
      throw new HttpError(400, 'relay.command_topic must be a plain MQTT topic');
    }
    return {
      type: 'mqtt',
      command_topic: v.command_topic,
      payload_on: typeof v.payload_on === 'string' ? v.payload_on : 'ON',
      payload_off: typeof v.payload_off === 'string' ? v.payload_off : 'OFF',
    };
  }
  throw new HttpError(400, 'relay.type must be "http" or "mqtt"');
}

export class RelayController {
  constructor(private readonly mqtt: MqttBridge, private readonly timeoutMs: number) {}

  async set(relay: RelayConfig, on: boolean): Promise<void> {
    if (relay.type === 'http') {
      const res = await fetch(on ? relay.on_url : relay.off_url, {
        method: relay.method ?? 'GET',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`Relay returned HTTP ${res.status}`);
      return;
    }
    if (!this.mqtt.connected) throw new Error('MQTT not connected - cannot switch relay');
    this.mqtt.publish(relay.command_topic, on ? relay.payload_on ?? 'ON' : relay.payload_off ?? 'OFF', { qos: 1 });
  }
}
