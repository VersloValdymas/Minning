import type { DeviceRow } from '../db/devices-repo.js';
import type { MetricKey } from '../miners/types.js';

export interface TopicConfig {
  discoveryPrefix: string;
  baseTopic: string;
}

export interface DiscoveryMessage {
  topic: string;
  /** null = remove entity (empty retained payload) */
  payload: Record<string, unknown> | null;
}

interface SensorDef {
  key: string;
  name: string;
  unit?: string;
  device_class?: string;
  state_class?: 'measurement' | 'total_increasing';
  icon?: string;
  entity_category?: 'diagnostic';
  precision?: number;
}

/** One HA sensor per metric; created only when the device actually reports that metric (capabilities). */
const METRIC_SENSORS: Array<SensorDef & { key: MetricKey }> = [
  { key: 'hashrate_ths', name: 'Hashrate', unit: 'TH/s', state_class: 'measurement', icon: 'mdi:pickaxe', precision: 2 },
  { key: 'hashrate_pct' as MetricKey, name: 'Hashrate of nominal', unit: '%', state_class: 'measurement', icon: 'mdi:gauge', precision: 1 },
  { key: 'hashrate_avg_ths', name: 'Hashrate average', unit: 'TH/s', state_class: 'measurement', icon: 'mdi:pickaxe', precision: 2 },
  { key: 'temp_max_c', name: 'Temperature max', unit: '°C', device_class: 'temperature', state_class: 'measurement', precision: 1 },
  { key: 'temp_avg_c', name: 'Temperature average', unit: '°C', device_class: 'temperature', state_class: 'measurement', precision: 1 },
  { key: 'water_in_c', name: 'Water inlet temperature', unit: '°C', device_class: 'temperature', state_class: 'measurement', precision: 1 },
  { key: 'water_out_c', name: 'Water outlet temperature', unit: '°C', device_class: 'temperature', state_class: 'measurement', precision: 1 },
  { key: 'coolant_flow_lpm', name: 'Coolant flow (est.)', unit: 'L/min', device_class: 'volume_flow_rate', state_class: 'measurement', icon: 'mdi:water-pump', precision: 1 },
  { key: 'coolant_flow_required_lpm' as MetricKey, name: 'Coolant flow required', unit: 'L/min', device_class: 'volume_flow_rate', icon: 'mdi:water-check', entity_category: 'diagnostic', precision: 1 },
  { key: 'fan_rpm_avg', name: 'Fan speed', unit: 'RPM', state_class: 'measurement', icon: 'mdi:fan', precision: 0 },
  { key: 'power_w', name: 'Power', unit: 'W', device_class: 'power', state_class: 'measurement', precision: 0 },
  { key: 'voltage_v', name: 'Voltage', unit: 'V', device_class: 'voltage', state_class: 'measurement', precision: 1 },
  { key: 'current_a', name: 'Current', unit: 'A', device_class: 'current', state_class: 'measurement', precision: 2 },
  { key: 'efficiency_jth', name: 'Efficiency', unit: 'J/TH', state_class: 'measurement', icon: 'mdi:flash', precision: 1 },
  { key: 'accepted', name: 'Accepted shares', state_class: 'total_increasing', icon: 'mdi:check', entity_category: 'diagnostic' },
  { key: 'rejected', name: 'Rejected shares', state_class: 'total_increasing', icon: 'mdi:close', entity_category: 'diagnostic' },
  { key: 'hw_errors', name: 'Hardware errors', state_class: 'total_increasing', icon: 'mdi:alert', entity_category: 'diagnostic' },
  { key: 'uptime_s', name: 'Uptime', unit: 's', device_class: 'duration', entity_category: 'diagnostic' },
];

/** Always created; they stay available while the device is offline so HA can show *why*. */
const STATUS_SENSORS: SensorDef[] = [
  { key: 'status', name: 'Status', icon: 'mdi:state-machine' },
  { key: 'health', name: 'Health', icon: 'mdi:heart-pulse' },
  { key: 'miner_state', name: 'Miner state', icon: 'mdi:pickaxe' },
  { key: 'errors', name: 'Errors', icon: 'mdi:alert-circle-outline' },
  { key: 'ip', name: 'IP address', icon: 'mdi:ip-network', entity_category: 'diagnostic' },
];

export const BUTTON_COMMANDS = ['find', 'start', 'stop', 'restart', 'reboot', 'power_cycle'] as const;

const BUTTONS: Record<(typeof BUTTON_COMMANDS)[number], { name: string; icon?: string; device_class?: string }> = {
  find: { name: 'Identify (blink LED)', device_class: 'identify' },
  start: { name: 'Start mining', icon: 'mdi:play' },
  stop: { name: 'Stop mining', icon: 'mdi:stop' },
  restart: { name: 'Restart', device_class: 'restart' },
  reboot: { name: 'Reboot', device_class: 'restart' },
  power_cycle: { name: 'Power cycle', icon: 'mdi:power-cycle' },
};

export function topics(cfg: TopicConfig, deviceId?: string) {
  const dev = `${cfg.baseTopic}/${deviceId}`;
  return {
    bridgeStatus: `${cfg.baseTopic}/bridge/status`,
    haStatus: `${cfg.discoveryPrefix}/status`,
    state: `${dev}/state`,
    availability: `${dev}/availability`,
    command: `${dev}/command`,
    relaySet: `${dev}/relay/set`,
    relayState: `${dev}/relay/state`,
    commandWildcard: `${cfg.baseTopic}/+/command`,
    relaySetWildcard: `${cfg.baseTopic}/+/relay/set`,
  };
}

const uid = (deviceId: string, key: string) => `minerbridge_${deviceId}_${key}`;

function deviceInfo(d: DeviceRow, area?: string) {
  return {
    suggested_area: area,
    identifiers: [`minerbridge_${d.id}`],
    name: d.name ?? d.hostname ?? `${d.model ?? 'Miner'} ${d.ip}`,
    manufacturer: d.vendor ?? undefined,
    model: d.model ?? undefined,
    sw_version: d.firmware ?? undefined,
    connections: d.mac ? [['mac', d.mac]] : undefined,
    configuration_url: `http://${d.ip}`,
  };
}

/**
 * Full desired discovery state for a device. Entities that do not apply (unsupported metric,
 * no relay, command not supported by the driver) get a null payload so stale ones are removed.
 * `remove = true` produces removals for everything (device deleted).
 */
export function buildDiscovery(
  cfg: TopicConfig,
  d: DeviceRow,
  driverCommands: readonly string[],
  version: string,
  remove = false,
  area?: string,
): DiscoveryMessage[] {
  const t = topics(cfg, d.id);
  const device = deviceInfo(d, area);
  const origin = { name: 'Miner Bridge', sw_version: version };
  const bridgeOnly = [{ topic: t.bridgeStatus }];
  const bridgeAndDevice = [{ topic: t.bridgeStatus }, { topic: t.availability }];
  const caps = new Set(d.capabilities);
  const out: DiscoveryMessage[] = [];

  const sensor = (s: SensorDef, availability: Array<{ topic: string }>, enabled: boolean) => {
    const id = uid(d.id, s.key);
    out.push({
      topic: `${cfg.discoveryPrefix}/sensor/${id}/config`,
      payload:
        remove || !enabled
          ? null
          : {
              name: s.name,
              unique_id: id,
              state_topic: t.state,
              value_template: `{{ value_json.${s.key} }}`,
              unit_of_measurement: s.unit,
              device_class: s.device_class,
              state_class: s.state_class,
              suggested_display_precision: s.precision,
              icon: s.icon,
              entity_category: s.entity_category,
              availability,
              availability_mode: 'all',
              device,
              origin,
            },
    });
  };

  for (const s of STATUS_SENSORS) sensor(s, bridgeOnly, true);
  // Derived sensors are enabled by the capability they are computed from
  const DERIVED_FROM: Record<string, string> = { hashrate_pct: 'hashrate_ths', coolant_flow_required_lpm: 'water_in_c', coolant_flow_lpm: 'water_in_c' };
  for (const s of METRIC_SENSORS) sensor(s, bridgeAndDevice, caps.has(DERIVED_FROM[s.key] ?? s.key));

  const onlineId = uid(d.id, 'online');
  out.push({
    topic: `${cfg.discoveryPrefix}/binary_sensor/${onlineId}/config`,
    payload: remove
      ? null
      : {
          name: 'Online',
          unique_id: onlineId,
          device_class: 'connectivity',
          state_topic: t.state,
          value_template: "{{ 'ON' if value_json.online else 'OFF' }}",
          availability: bridgeOnly,
          device,
          origin,
        },
  });

  for (const cmd of BUTTON_COMMANDS) {
    const id = uid(d.id, cmd);
    const supported = cmd === 'power_cycle' ? d.relay !== null : driverCommands.includes(cmd);
    out.push({
      topic: `${cfg.discoveryPrefix}/button/${id}/config`,
      payload:
        remove || !supported
          ? null
          : {
              name: BUTTONS[cmd].name,
              unique_id: id,
              command_topic: t.command,
              payload_press: cmd,
              device_class: BUTTONS[cmd].device_class,
              icon: BUTTONS[cmd].icon,
              availability: cmd === 'power_cycle' ? bridgeOnly : bridgeAndDevice,
              availability_mode: 'all',
              device,
              origin,
            },
    });
  }

  const relayId = uid(d.id, 'power');
  out.push({
    topic: `${cfg.discoveryPrefix}/switch/${relayId}/config`,
    payload:
      remove || !d.relay
        ? null
        : {
            name: 'Power relay',
            unique_id: relayId,
            command_topic: t.relaySet,
            state_topic: t.relayState,
            payload_on: 'ON',
            payload_off: 'OFF',
            device_class: 'outlet',
            availability: bridgeOnly,
            device,
            origin,
          },
  });

  // Drop undefined keys so payloads stay clean
  for (const m of out) if (m.payload) m.payload = JSON.parse(JSON.stringify(m.payload));
  return out;
}
