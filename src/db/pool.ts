import pg from 'pg';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { errorMessage, sleep } from '../util/async.js';

const log = createLogger('db');

// BIGINT counters fit safely into JS numbers for our use case.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Pool = pg.Pool;

export function createPool(): pg.Pool {
  const ssl = config.db.ssl ? { rejectUnauthorized: false } : undefined;
  const pool = config.db.url
    ? new pg.Pool({ connectionString: config.db.url, ssl, max: 10 })
    : new pg.Pool({
        host: config.db.host,
        port: config.db.port,
        database: config.db.database,
        user: config.db.user,
        password: config.db.password,
        ssl,
        max: 10,
      });
  pool.on('error', (err) => log.error('Idle client error', err));
  return pool;
}

/** The DB container/add-on may start after us - retry for a while before giving up. */
export async function waitForDb(pool: pg.Pool, attempts = 30, delayMs = 2000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === attempts) throw err;
      log.warn(`Database not reachable (${errorMessage(err)}), retry ${i}/${attempts}...`);
      await sleep(delayMs);
    }
  }
}

/** Retention is applied from config on every start, so changing retention_days just works. */
export async function applyRetentionPolicy(pool: pg.Pool, days: number): Promise<void> {
  try {
    await pool.query(`SELECT remove_retention_policy('miner_metrics', if_exists => TRUE)`);
    if (days > 0) {
      await pool.query(`SELECT add_retention_policy('miner_metrics', drop_after => $1::int * INTERVAL '1 day')`, [days]);
      log.info(`Retention policy: ${days} days`);
    } else {
      log.info('Retention policy disabled (keeping all data)');
    }
  } catch (err) {
    log.warn('Could not apply retention policy (TimescaleDB community features unavailable?)', err);
  }
}
