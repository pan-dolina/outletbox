import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Opaque identifier: prefix + 16 chars of base64url (96 bits of randomness). */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

/** Upload-link token: 256 bits, base64url (43 chars). Never stored in clear. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export function newCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Tokens are high-entropy, so an unsalted SHA-256 is sufficient and allows lookup by hash. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize('NFKC'), salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * SCRYPT_N * SCRYPT_R * 2 });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]); const r = Number(parts[2]); const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  const actual = scryptSync(password.normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: 128 * N * r * 2 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const ID_RE = /^[a-z]+_[A-Za-z0-9_-]{16}$/;

/** Per-browser token for the public unlock flow (double-submit CSRF + binding a challenge to one browser). */
export function newFlowToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * One-time access code sent by e-mail: 6 digits, uniformly distributed
 * (rejection sampling, never `% 10`), grouped as "123 456" when displayed.
 */
export function newAccessCode(digits = 6): string {
  let out = '';
  while (out.length < digits) {
    for (const byte of randomBytes(digits)) {
      if (byte >= 250) continue; // 250 = 25 * 10: the remaining range is an exact multiple of 10
      out += String(byte % 10);
      if (out.length === digits) break;
    }
  }
  return out;
}

/** Codes are compared after stripping the spaces/dashes people paste in from an e-mail. */
export function normalizeCode(raw: string): string {
  return raw.replace(/[\s-]/g, '');
}

/** Lower-cased, NFKC-normalised address. Comparison and storage both use this form. */
export function normalizeEmail(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

// Deliberately permissive: this validates shape, not deliverability.
const EMAIL_RE = /^[^\s@,;<>"']+@[^\s@,;<>"'.]+(\.[^\s@,;<>"'.]+)+$/;

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}
