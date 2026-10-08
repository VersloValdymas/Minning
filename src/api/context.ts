import type { AppConfig } from '../config.js';
import type { Pool } from '../db/pool.js';
import type { MqttBridge } from '../mqtt/bridge.js';
import type { Poller } from '../poller/poller.js';
import type { Scanner } from '../scanner/scanner.js';
import type { DeviceService } from '../services/device-service.js';
import type { SettingsService } from '../settings/settings-service.js';

export interface AppContext {
  config: AppConfig;
  pool: Pool;
  mqtt: MqttBridge;
  devices: DeviceService;
  scanner: Scanner;
  poller: Poller;
  settings: SettingsService;
}
