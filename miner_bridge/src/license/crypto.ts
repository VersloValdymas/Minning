import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

/**
 * License tokens are Ed25519-signed. The developer holds the private key (never in the repo);
 * the add-on ships only the public key. A token is: base64url(payload JSON) "." base64url(signature).
 * Shared by the issuing CLI (tools/issue-license.ts), and reusable by a future license server.
 */
export interface LicensePayload {
  v: 1;
  /** Customer display name. */
  cust: string;
  /** Customer / order id. */
  id: string;
  /** Binds the license to one install (install id). null = any install. */
  hwid: string | null;
  /** Issued at (unix seconds). */
  iat: number;
  /** Expiry (unix seconds). 0 = perpetual. */
  exp: number;
  /** Optional cap on active miners (null = unlimited). */
  max_miners: number | null;
}

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

export function generateKeypair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function signLicense(payload: LicensePayload, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign(null, body, key);
  return `${b64u(body)}.${b64u(signature)}`;
}

/** Verifies signature and shape. Returns the payload or null (invalid signature / malformed / wrong key). */
export function verifyLicense(token: string, publicKeyPem: string): LicensePayload | null {
  try {
    const key = createPublicKey(publicKeyPem);
    const [bodyB64, sigB64] = token.trim().split('.');
    if (!bodyB64 || !sigB64) return null;
    const body = fromB64u(bodyB64);
    if (!verify(null, body, key, fromB64u(sigB64))) return null;
    const payload = JSON.parse(body.toString('utf8')) as LicensePayload;
    if (payload.v !== 1 || typeof payload.exp !== 'number' || typeof payload.id !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

/** True when the string is a usable public key (not the shipped placeholder). */
export function isConfiguredKey(pem: string): boolean {
  try {
    createPublicKey(pem);
    return pem.includes('PUBLIC KEY') && !pem.includes('PLACEHOLDER');
  } catch {
    return false;
  }
}

export function publicKeyObject(pem: string): KeyObject {
  return createPublicKey(pem);
}
