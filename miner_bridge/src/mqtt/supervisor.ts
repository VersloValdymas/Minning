import type { AppConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { errorMessage } from '../util/async.js';

const log = createLogger('mqtt');

/**
 * Inside Home Assistant: when no broker is configured in the add-on options, ask the Supervisor for the
 * MQTT service (provided by the official Mosquitto add-on; requires "services": ["mqtt:want"]).
 * Fills config.mqtt in place. Returns true when a broker was found.
 */
export async function discoverMqttFromSupervisor(cfg: AppConfig['mqtt']): Promise<boolean> {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token || cfg.url || cfg.host) return false;
  try {
    const res = await fetch('http://supervisor/services/mqtt', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log.info(`No MQTT service from Supervisor (HTTP ${res.status}) - set mqtt_host in the add-on options`);
      return false;
    }
    const body = (await res.json()) as { data?: { host?: string; port?: number; username?: string; password?: string; ssl?: boolean } };
    const d = body.data;
    if (!d?.host) return false;
    cfg.host = d.host;
    cfg.port = d.port ?? 1883;
    cfg.username = d.username;
    cfg.password = d.password;
    if (d.ssl) cfg.url = `mqtts://${d.host}:${cfg.port}`;
    log.info(`Using MQTT broker provided by Home Assistant: ${d.host}:${cfg.port}`);
    return true;
  } catch (err) {
    log.warn(`Supervisor MQTT discovery failed: ${errorMessage(err)}`);
    return false;
  }
}
