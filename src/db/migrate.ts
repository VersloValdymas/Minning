import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT_DIR } from '../config.js';
import { createLogger } from '../logger.js';
import { createPool, waitForDb, type Pool } from './pool.js';

const log = createLogger('migrate');
const MIGRATIONS_DIR = path.join(ROOT_DIR, 'migrations');
const LOCK_ID = 74_210_001; // pg_advisory_lock key, prevents concurrent runs

/**
 * Applies pending migrations/NNNN_name.sql files in order, each in its own transaction.
 * Idempotent: applied files are tracked in schema_migrations. Throws on failure (server must not start).
 */
export async function runMigrations(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      log.info(`Applied ${file}`);
      applied.push(file);
    }
    if (applied.length === 0) log.info('Schema up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return applied;
}

// CLI: npm run migrate
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool();
  waitForDb(pool, 5)
    .then(() => runMigrations(pool))
    .then(() => pool.end())
    .catch(async (err) => {
      log.error('Migration failed', err);
      await pool.end();
      process.exit(1);
    });
}
