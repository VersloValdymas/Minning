import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt (memory-hard KDF, OWASP-recommended alongside argon2id/bcrypt; built into Node).
 * Format: scrypt$N$r$p$<salt b64>$<hash b64>. Parameters are stored with the hash so they can be raised later.
 * N=2^15, r=8 -> ~32 MB and ~100 ms per attempt: offline brute force of a strong password is infeasible.
 */
const N = 1 << 15;
const R = 8;
const P = 1;
const KEYLEN = 64;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, { ...opts, maxmem: 128 * opts.N! * opts.r! * 2 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Server-side strength check (the dashboard checks the same rules). */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string') return 'Slaptažodis privalomas';
  if (password.length < 12) return 'Slaptažodis turi būti bent 12 simbolių';
  if (password.length > 256) return 'Slaptažodis per ilgas';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3 && password.length < 20) return 'Naudokite bent 3 iš 4: mažąsias, didžiąsias raides, skaičius, simbolius (arba 20+ simbolių frazę)';
  return null;
}
