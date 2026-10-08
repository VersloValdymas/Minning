import type { Server } from 'node:http';
import { createServer } from './api/server.js';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { applyRetentionPolicy, createPool, waitForDb } from './db/pool.js';
import { createLogger, setLogLevel } from './logger.js';
import { MqttBridge } from './mqtt/bridge.js';
import { Poller } from './poller/poller.js';
import { Scanner } from './scanner/scanner.js';
import { DeviceService } from './services/device-service.js';
import { SettingsService } from './settings/settings-service.js';
import { errorMessage } from './util/async.js';

setLogLevel(config.logLevel);
const log = createLogger('main');

async function main() {
  log.info(`Miner Bridge v${config.appVersion} starting (${config.isAddon ? 'HA add-on' : 'standalone'} mode)`);

  // 1. Database: wait, migrate (fail hard), apply retention
  const pool = createPool();
  await waitForDb(pool);
  await runMigrations(pool);
  await applyRetentionPolicy(pool, config.db.retentionDays);

  // 2. Services (dashboard settings override env / add-on defaults)
  const settings = new SettingsService(pool, config);
  await settings.load();
  const mqtt = new MqttBridge(config.mqtt, config.appVersion);
  const devices = new DeviceService(pool, mqtt, config);
  devices.setAreaResolver((d) => {
    const rack = settings.layout.racks.find((r) => r.id === d.rack);
    return rack ? `${settings.layout.siteName} – ${rack.name}` : undefined;
  });
  await devices.warmCache();
  const scanner = new Scanner(config.scan, (target, identity) => devices.registerDiscovered(target, identity));
  const poller = new Poller(config, pool, devices, mqtt);

  // 3. MQTT: (re)publish discovery on every connect and whenever HA restarts
  const republish = () => devices.publishAllDiscovery().catch((err) => log.error('Discovery publish failed', err));
  mqtt.on('connected', republish);
  mqtt.on('ha-online', republish);
  mqtt.on('command', (deviceId, command) => {
    log.info(`MQTT command: ${deviceId} -> ${command}`);
    devices.executeCommand(deviceId, command, 'mqtt').catch((err) => log.warn(`Command failed: ${errorMessage(err)}`));
  });
  mqtt.connect();

  // 4. HTTP + polling
  const app = createServer({ config, pool, mqtt, devices, scanner, poller, settings }, config);
  const server: Server = app.listen(config.http.port, () => log.info(`Dashboard: http://localhost:${config.http.port}`));
  poller.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    poller.stop();
    scanner.cancel();
    server.closeAllConnections();
    server.close();
    await mqtt.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('Fatal startup error', err);
  process.exit(1);
});
