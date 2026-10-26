import fs from 'node:fs';
import { createLogger } from '../logger.js';
import { errorMessage } from '../util/async.js';

const log = createLogger('auth');

/**
 * After a password reset, set the add-on option admin_password_reset back to false via the Supervisor API,
 * otherwise every restart would wipe the password again. Outside HA this is a no-op (env var stays as set).
 */
export async function clearResetOption(): Promise<void> {
  const token = process.env.SUPERVISOR_TOKEN;
  const file = process.env.HA_OPTIONS_PATH ?? '/data/options.json';
  if (!token || !fs.existsSync(file)) {
    log.warn('ADMIN_PASSWORD_RESET is set - remove it, otherwise the password is reset on every start');
    return;
  }
  try {
    const options = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    options.admin_password_reset = false;
    const res = await fetch('http://supervisor/addons/self/options', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ options }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log.info('admin_password_reset switched back to false');
  } catch (err) {
    log.warn(`Could not switch admin_password_reset back to false (${errorMessage(err)}) - turn it off in the add-on configuration`);
  }
}
