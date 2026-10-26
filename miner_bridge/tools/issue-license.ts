/**
 * Issue a signed license token.
 *   npm run license:issue -- --cust "Kliento vardas" --id ORDER-001 --days 365 [--hwid INSTALL_ID] [--max-miners 100]
 * --days 0 (or omitted with --perpetual) = never expires. Prints the token to paste into the add-on.
 * Later a license server will sign the same payload with the same private key for paid orders.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signLicense, type LicensePayload } from '../src/license/crypto.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const privPath = process.env.LICENSE_PRIVATE_KEY_FILE ?? path.join(dir, '.license-private.pem');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

if (!fs.existsSync(privPath)) {
  console.error(`Private key not found: ${privPath}\nRun  npm run license:genkeys  first.`);
  process.exit(1);
}

const cust = arg('cust');
const id = arg('id');
if (!cust || !id) {
  console.error('Required: --cust "Name" --id ID   [--days N | --perpetual] [--hwid INSTALL_ID] [--max-miners N]');
  process.exit(1);
}

const days = flag('perpetual') ? 0 : Number(arg('days') ?? 365);
const now = Math.floor(Date.now() / 1000);
const payload: LicensePayload = {
  v: 1,
  cust,
  id,
  hwid: arg('hwid') ?? null,
  iat: now,
  exp: days > 0 ? now + days * 86400 : 0,
  max_miners: arg('max-miners') ? Number(arg('max-miners')) : null,
};

const token = signLicense(payload, fs.readFileSync(privPath, 'utf8'));

console.log('License issued:');
console.log(`  customer : ${payload.cust} (${payload.id})`);
console.log(`  install  : ${payload.hwid ?? 'any'}`);
console.log(`  expires  : ${payload.exp ? new Date(payload.exp * 1000).toISOString().slice(0, 10) : 'never'}`);
console.log(`  miners   : ${payload.max_miners ?? 'unlimited'}`);

// --out FILE: also save just the token to a file (used by issue-license.cmd)
const out = arg('out');
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, token);
  console.log(`  saved    : ${out}`);
}

console.log('\nLicense key (paste into the add-on Configuration -> license_key, or the dashboard lock screen):\n');
console.log(token);
