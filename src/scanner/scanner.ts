import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { bus } from '../events.js';
import { createLogger } from '../logger.js';
import { getDriver, listDrivers } from '../miners/index.js';
import type { MinerDriver, MinerIdentity, MinerTarget } from '../miners/types.js';
import { lookupMac } from '../net/arp.js';
import { parseIpRange } from '../net/ip-range.js';
import type { FoundDevice } from '../services/device-service.js';
import { errorMessage, mapLimit } from '../util/async.js';
import { HttpError } from '../util/http-error.js';

const log = createLogger('scanner');

export interface ScanRequest {
  range: string;
  /** 'auto' tries every driver on its default port (or on `port` if given). */
  driver: string;
  port?: number;
}

export interface ScanStatus {
  id: string;
  range: string;
  driver: string;
  port: number | null;
  state: 'running' | 'done' | 'cancelled' | 'error';
  total: number;
  scanned: number;
  found: FoundDevice[];
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

type OnFound = (target: MinerTarget & { driver: string }, identity: MinerIdentity) => Promise<FoundDevice>;

export class Scanner {
  private status: ScanStatus | null = null;
  private abort: AbortController | null = null;

  constructor(private readonly cfg: AppConfig['scan'], private readonly onFound: OnFound) {}

  getStatus(): ScanStatus | null {
    return this.status;
  }

  start(req: ScanRequest): ScanStatus {
    if (this.status?.state === 'running') throw new HttpError(409, 'A scan is already running');
    const hosts = parseIpRange(req.range, this.cfg.maxHosts);

    let drivers: MinerDriver[];
    if (req.driver === 'auto') drivers = listDrivers();
    else {
      const d = getDriver(req.driver);
      if (!d) throw new HttpError(400, `Unknown driver "${req.driver}"`);
      drivers = [d];
    }
    if (req.port !== undefined && (!Number.isInteger(req.port) || req.port < 1 || req.port > 65535)) {
      throw new HttpError(400, 'port must be 1..65535');
    }

    this.abort = new AbortController();
    this.status = {
      id: randomUUID(),
      range: req.range,
      driver: req.driver,
      port: req.port ?? null,
      state: 'running',
      total: hosts.length,
      scanned: 0,
      found: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
    log.info(`Scan started: ${req.range} (${hosts.length} hosts, driver=${req.driver})`);
    bus.publish('scan.started', this.status);
    void this.run(this.status, hosts, drivers, req.port, this.abort.signal);
    return this.status;
  }

  cancel(): boolean {
    if (this.status?.state !== 'running') return false;
    this.abort?.abort();
    return true;
  }

  private async run(status: ScanStatus, hosts: string[], drivers: MinerDriver[], port: number | undefined, signal: AbortSignal) {
    let lastEmit = 0;
    const emitProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 250) return;
      lastEmit = now;
      bus.publish('scan.progress', { id: status.id, total: status.total, scanned: status.scanned, found: status.found.length });
    };

    try {
      await mapLimit(
        hosts,
        this.cfg.concurrency,
        async (ip) => {
          for (const driver of drivers) {
            if (signal.aborted) return;
            const target = { ip, port: port ?? driver.defaultPort };
            const identity = await driver.probe(target, this.cfg.timeoutMs);
            if (!identity) continue;
            identity.mac ??= await lookupMac(ip);
            try {
              const found = await this.onFound({ ...target, driver: driver.name }, identity);
              status.found.push(found);
              bus.publish('scan.found', found);
            } catch (err) {
              log.error(`Failed to register ${ip}`, err);
            }
            break;
          }
          status.scanned++;
          emitProgress();
        },
        signal,
      );
      status.state = signal.aborted ? 'cancelled' : 'done';
    } catch (err) {
      status.state = 'error';
      status.error = errorMessage(err);
      log.error('Scan failed', err);
    }
    status.finishedAt = new Date().toISOString();
    emitProgress(true);
    log.info(`Scan ${status.state}: ${status.found.length} miner(s) found, ${status.scanned}/${status.total} hosts`);
    bus.publish('scan.finished', status);
  }
}
