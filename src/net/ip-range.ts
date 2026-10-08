import { HttpError } from '../util/http-error.js';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function ipToInt(ip: string): number {
  const m = IPV4.exec(ip.trim());
  if (!m) throw new HttpError(400, `Invalid IPv4 address: "${ip}"`);
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) throw new HttpError(400, `Invalid IPv4 address: "${ip}"`);
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

export function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/**
 * Parses a scan target into a list of IPv4 addresses. Supported forms (comma-separated):
 *   192.168.1.1-254            last-octet range
 *   192.168.1.10-192.168.2.20  full range
 *   192.168.1.0/24             CIDR (network/broadcast excluded for /30 and wider)
 *   192.168.1.5                single host
 */
export function parseIpRange(input: string, maxHosts: number): string[] {
  const result = new Set<number>();
  const add = (from: number, to: number) => {
    if (to < from) throw new HttpError(400, `Range end is before start: ${intToIp(from)}-${intToIp(to)}`);
    if (to - from + 1 + result.size > maxHosts) throw new HttpError(400, `Range too large (max ${maxHosts} hosts)`);
    for (let n = from; n <= to; n++) result.add(n);
  };

  const parts = input.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new HttpError(400, 'IP range is empty');

  for (const part of parts) {
    if (part.includes('/')) {
      const [base, bitsStr] = part.split('/');
      const bits = Number(bitsStr);
      if (!Number.isInteger(bits) || bits < 16 || bits > 32) throw new HttpError(400, `CIDR prefix must be /16../32: "${part}"`);
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      const network = (ipToInt(base) & mask) >>> 0;
      const broadcast = (network | (~mask >>> 0)) >>> 0;
      if (bits >= 31) add(network, broadcast);
      else add(network + 1, broadcast - 1);
    } else if (part.includes('-')) {
      const [startStr, endStr] = part.split('-').map((s) => s.trim());
      const start = ipToInt(startStr);
      if (/^\d{1,3}$/.test(endStr)) {
        const last = Number(endStr);
        if (last > 255) throw new HttpError(400, `Invalid range end: "${part}"`);
        add(start, ((start & 0xffffff00) | last) >>> 0);
      } else {
        add(start, ipToInt(endStr));
      }
    } else {
      const n = ipToInt(part);
      add(n, n);
    }
  }

  return [...result].sort((a, b) => a - b).map(intToIp);
}
