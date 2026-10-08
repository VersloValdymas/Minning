import { bus } from '../events.js';
import type { FirmwareEvent } from '../miners/types.js';
import type { Pool } from './pool.js';

export type EventLevel = 'info' | 'warn' | 'error';

export interface DeviceEvent {
  id: number;
  time: Date;
  device_id: string | null;
  level: EventLevel;
  message: string;
  source?: 'app' | 'firmware';
  code?: string | null;
}

export const eventsRepo = {
  /** Persists the event and pushes it to the dashboard. Never throws (logging must not break callers). */
  async add(pool: Pool, deviceId: string | null, level: EventLevel, message: string): Promise<void> {
    try {
      const { rows } = await pool.query<DeviceEvent>(
        'INSERT INTO device_events (device_id, level, message) VALUES ($1, $2, $3) RETURNING *',
        [deviceId, level, message],
      );
      bus.publish('event.log', rows[0]);
    } catch {
      // ignore
    }
  },

  /**
   * Imports firmware log events. Dedup by (device, time, code), so re-reading the same log is harmless.
   * Returns only rows that were new; those are pushed to the dashboard.
   */
  async addFirmware(pool: Pool, deviceId: string, events: FirmwareEvent[]): Promise<DeviceEvent[]> {
    if (events.length === 0) return [];
    const { rows } = await pool.query<DeviceEvent>(
      `INSERT INTO device_events (device_id, time, level, message, source, code)
       SELECT $1, u.time, u.level, u.message, 'firmware', u.code
       FROM unnest($2::timestamptz[], $3::text[], $4::text[], $5::text[]) AS u(time, level, message, code)
       ON CONFLICT (device_id, time, code) WHERE source = 'firmware' DO NOTHING
       RETURNING *`,
      [deviceId, events.map((e) => e.time), events.map((e) => e.level), events.map((e) => e.message), events.map((e) => e.code)],
    );
    for (const r of rows) bus.publish('event.log', r);
    return rows;
  },

  /** Firmware events of the last `hours` per device (feeds the health engine). */
  async recentFirmware(pool: Pool, hours: number): Promise<DeviceEvent[]> {
    const { rows } = await pool.query<DeviceEvent>(
      `SELECT * FROM device_events
       WHERE source = 'firmware' AND time > now() - make_interval(hours => $1::int)
       ORDER BY time`,
      [hours],
    );
    return rows;
  },

  async recent(pool: Pool, limit: number, deviceId?: string): Promise<DeviceEvent[]> {
    const { rows } = deviceId
      ? await pool.query<DeviceEvent>('SELECT * FROM device_events WHERE device_id = $1 ORDER BY time DESC LIMIT $2', [deviceId, limit])
      : await pool.query<DeviceEvent>('SELECT * FROM device_events ORDER BY time DESC LIMIT $1', [limit]);
    return rows;
  },
};
