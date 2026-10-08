import type { RelayConfig } from '../relays/relay.js';
import { HttpError } from '../util/http-error.js';
import type { Pool } from './pool.js';

export type DeviceStatus = 'unknown' | 'online' | 'warning' | 'offline';

export interface DeviceRow {
  id: string;
  mac: string | null;
  ip: string;
  port: number;
  driver: string;
  vendor: string | null;
  model: string | null;
  firmware: string | null;
  hostname: string | null;
  name: string | null;
  active: boolean;
  relay: RelayConfig | null;
  /** Physical location: rack (cabinet / pump loop), shelf (1 = top), slot (1 = left). */
  rack: number | null;
  shelf: number | null;
  slot: number | null;
  capabilities: string[];
  status: DeviceStatus;
  last_error: string | null;
  consecutive_failures: number;
  first_seen: Date;
  last_seen: Date | null;
  updated_at: Date;
}

export interface DiscoveredDevice {
  id: string;
  mac: string | null;
  ip: string;
  port: number;
  driver: string;
  vendor: string | null;
  model: string | null;
  firmware: string | null;
  hostname: string | null;
}

export interface DevicePatch {
  name?: string | null;
  active?: boolean;
  relay?: RelayConfig | null;
  location?: { rack: number; shelf: number; slot: number } | null;
}

export interface PollResultUpdate {
  id: string;
  status: DeviceStatus;
  lastError: string | null;
  failures: number;
  lastSeen: Date | null;
}

export const devicesRepo = {
  async listAll(pool: Pool): Promise<DeviceRow[]> {
    return (await pool.query<DeviceRow>('SELECT * FROM devices ORDER BY ip')).rows;
  },

  async listActive(pool: Pool): Promise<DeviceRow[]> {
    return (await pool.query<DeviceRow>('SELECT * FROM devices WHERE active ORDER BY ip')).rows;
  },

  async get(pool: Pool, id: string): Promise<DeviceRow | null> {
    return (await pool.query<DeviceRow>('SELECT * FROM devices WHERE id = $1', [id])).rows[0] ?? null;
  },

  /** Insert or refresh a device found by the scanner. Keeps user fields (name, active, relay). */
  async upsertDiscovered(pool: Pool, d: DiscoveredDevice): Promise<{ device: DeviceRow; isNew: boolean }> {
    const { rows } = await pool.query<DeviceRow & { inserted: boolean }>(
      `INSERT INTO devices (id, mac, ip, port, driver, vendor, model, firmware, hostname, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (id) DO UPDATE SET
         mac       = COALESCE(EXCLUDED.mac, devices.mac),
         ip        = EXCLUDED.ip,
         port      = EXCLUDED.port,
         driver    = EXCLUDED.driver,
         vendor    = COALESCE(EXCLUDED.vendor, devices.vendor),
         model     = COALESCE(EXCLUDED.model, devices.model),
         firmware  = COALESCE(EXCLUDED.firmware, devices.firmware),
         hostname  = COALESCE(EXCLUDED.hostname, devices.hostname),
         last_seen = now(),
         updated_at = now()
       RETURNING *, (xmax = 0) AS inserted`,
      [d.id, d.mac, d.ip, d.port, d.driver, d.vendor, d.model, d.firmware, d.hostname],
    );
    const { inserted, ...device } = rows[0];
    return { device, isNew: inserted };
  },

  async update(pool: Pool, id: string, patch: DevicePatch): Promise<DeviceRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) {
      values.push(patch.name);
      sets.push(`name = $${values.length}`);
    }
    if (patch.active !== undefined) {
      values.push(patch.active);
      sets.push(`active = $${values.length}`);
    }
    if (patch.relay !== undefined) {
      values.push(patch.relay === null ? null : JSON.stringify(patch.relay));
      sets.push(`relay = $${values.length}::jsonb`);
    }
    if (patch.location !== undefined) {
      const l = patch.location;
      values.push(l?.rack ?? null, l?.shelf ?? null, l?.slot ?? null);
      sets.push(`rack = $${values.length - 2}, shelf = $${values.length - 1}, slot = $${values.length}`);
    }
    if (sets.length === 0) return this.get(pool, id);
    values.push(id);
    try {
      const { rows } = await pool.query<DeviceRow>(
        `UPDATE devices SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
        values,
      );
      return rows[0] ?? null;
    } catch (err) {
      if ((err as { code?: string }).code === '23505' && patch.location) {
        const l = patch.location;
        const { rows } = await pool.query<{ id: string; name: string | null; hostname: string | null; ip: string }>(
          'SELECT id, name, hostname, ip FROM devices WHERE rack = $1 AND shelf = $2 AND slot = $3',
          [l.rack, l.shelf, l.slot],
        );
        const o = rows[0];
        throw new HttpError(409, `Vieta jau užimta: ${o ? o.name ?? o.hostname ?? o.ip : 'kita kasykla'}`);
      }
      throw err;
    }
  },


  async remove(pool: Pool, id: string): Promise<boolean> {
    return ((await pool.query('DELETE FROM devices WHERE id = $1', [id])).rowCount ?? 0) > 0;
  },

  async setCapabilities(pool: Pool, id: string, capabilities: string[]): Promise<DeviceRow | null> {
    const { rows } = await pool.query<DeviceRow>(
      'UPDATE devices SET capabilities = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [id, capabilities],
    );
    return rows[0] ?? null;
  },

  /** One round-trip for the whole poll cycle. */
  async applyPollResults(pool: Pool, updates: PollResultUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    await pool.query(
      `UPDATE devices d SET
         status = u.status,
         last_error = u.last_error,
         consecutive_failures = u.failures,
         last_seen = COALESCE(u.last_seen, d.last_seen),
         updated_at = now()
       FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::timestamptz[])
         AS u(id, status, last_error, failures, last_seen)
       WHERE d.id = u.id`,
      [
        updates.map((u) => u.id),
        updates.map((u) => u.status),
        updates.map((u) => u.lastError),
        updates.map((u) => u.failures),
        updates.map((u) => u.lastSeen),
      ],
    );
  },
};
