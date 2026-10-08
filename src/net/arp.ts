import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAC_RE = /([0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2}/i;

export function normalizeMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const parts = mac.trim().toLowerCase().split(/[:-]/);
  if (parts.length !== 6 || parts.some((p) => !/^[0-9a-f]{1,2}$/.test(p))) return null;
  const normalized = parts.map((p) => p.padStart(2, '0')).join(':');
  return normalized === '00:00:00:00:00:00' || normalized === 'ff:ff:ff:ff:ff:ff' ? null : normalized;
}

/**
 * Best-effort MAC lookup from the OS ARP cache. Works after we have just talked to the host.
 * In the HA add-on this requires host_network: true (otherwise we only see the Docker bridge).
 */
export async function lookupMac(ip: string): Promise<string | null> {
  try {
    if (process.platform === 'linux') {
      const table = await fs.readFile('/proc/net/arp', 'utf8');
      for (const line of table.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols[0] === ip) return normalizeMac(cols[3]);
      }
      return null;
    }
    const args = process.platform === 'win32' ? ['-a', ip] : ['-n', ip];
    const { stdout } = await execFileAsync('arp', args, { timeout: 2000, windowsHide: true });
    const line = stdout.split('\n').find((l) => l.includes(ip));
    const match = line ? MAC_RE.exec(line) : null;
    return match ? normalizeMac(match[0]) : null;
  } catch {
    return null;
  }
}
