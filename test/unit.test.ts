import { describe, expect, it } from 'vitest';
import { formatSize, loadBrand, loadConfig, parseSize } from '../src/config.js';
import { isValidEmail, newAccessCode, normalizeCode, normalizeEmail, safeEqual, hashPassword, verifyPassword } from '../src/crypto.js';
import { negotiateLang, t } from '../src/i18n.js';
import { redact } from '../src/log.js';
import { sanitizeFilename } from '../src/services/items.js';

describe('sizes', () => {
  it('parses the suffixes the panel offers', () => {
    expect(parseSize('1024')).toBe(1024);
    expect(parseSize('1KB')).toBe(1024);
    expect(parseSize('2 MiB')).toBe(2 * 1024 ** 2);
    expect(parseSize('1.5GB')).toBe(Math.floor(1.5 * 1024 ** 3));
    expect(() => parseSize('big')).toThrow();
    expect(() => parseSize('10 parsecs')).toThrow();
  });

  it('formats them back for people', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1024)).toBe('1.00 KB');
    expect(formatSize(5 * 1024 ** 3)).toBe('5.00 GB');
  });
});

describe('file names', () => {
  it('keeps only a safe base name', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Windows\\win.ini')).toBe('win.ini');
    expect(sanitizeFilename('bad\r\nname.txt')).toBe('badname.txt');
    expect(sanitizeFilename('   ')).toBe('unnamed');
    expect(sanitizeFilename('..')).toBe('unnamed');
    expect(sanitizeFilename(null)).toBe('unnamed');
  });

  it('shortens long names but keeps the extension', () => {
    const name = sanitizeFilename('a'.repeat(400) + '.pdf');
    expect(name.length).toBe(255);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('addresses and codes', () => {
  it('normalises what people type', () => {
    expect(normalizeEmail('  Jan.Kowalski@Example.COM ')).toBe('jan.kowalski@example.com');
    expect(isValidEmail('jan@example.com')).toBe(true);
    expect(isValidEmail('jan@example')).toBe(false);
    expect(isValidEmail('jan example.com')).toBe(false);
    expect(isValidEmail(`${'a'.repeat(250)}@example.com`)).toBe(false);
  });

  it('accepts a code however it was pasted', () => {
    expect(normalizeCode(' 123 456 ')).toBe('123456');
    expect(normalizeCode('123-456')).toBe('123456');
  });

  it('generates six uniformly distributed digits', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      const code = newAccessCode();
      expect(code).toMatch(/^\d{6}$/);
      for (const digit of code) counts.set(digit, (counts.get(digit) ?? 0) + 1);
    }
    // 12000 digits over ten buckets: a modulo bias would show up as a visible skew.
    expect(counts.size).toBe(10);
    for (const n of counts.values()) expect(n).toBeGreaterThan(900);
  });

  it('stores codes with the same work factor as a password', () => {
    const hash = hashPassword('123456');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('123456', hash)).toBe(true);
    expect(verifyPassword('123457', hash)).toBe(false);
    expect(verifyPassword('123456', 'garbage')).toBe(false);
  });

  it('compares in constant time without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('logging', () => {
  it('redacts delivery tokens, file names and code parameters', () => {
    expect(redact('GET /d/AbCdEf123 HTTP/1.1')).toBe('GET /d/[redacted] HTTP/1.1');
    // The path below the token stays readable: it tells an operator a download happened.
    expect(redact('/d/AbCdEf123/files/f_x')).toBe('/d/[redacted]/files/f_x');
    expect(redact('/admin/api/upload/secret plan.pdf')).toContain('[filename]');
    expect(redact('/x?code=123456&token=abc')).toBe('/x?code=[redacted]&token=[redacted]');
  });
});

describe('language negotiation', () => {
  it('uses the browser\'s first choice when we have it, and only the first', () => {
    expect(negotiateLang('pl-PL,pl;q=0.9,en;q=0.8')).toBe('pl');
    expect(negotiateLang('de-DE,de;q=0.9,pl;q=0.8')).toBe('de');
    expect(negotiateLang('pt-BR')).toBe('pt');
    expect(negotiateLang('ja,de;q=0.8')).toBe('en');
    expect(negotiateLang('en-GB')).toBe('en');
    expect(negotiateLang(undefined)).toBe('en');
    expect(negotiateLang('xx')).toBe('en');
  });

  it('fills placeholders and leaves unknown ones visible', () => {
    expect(t('en', 'deliver.code.attempts_left', { n: 3 })).toBe('Attempts left: 3.');
    expect(t('pl', 'deliver.code.attempts_left', { n: 3 })).toBe('Pozostałe próby: 3.');
    expect(t('en', 'deliver.code.attempts_left')).toContain('{n}');
  });
});

describe('configuration', () => {
  const base = { PUBLIC_URL: 'https://out.example.com' } as NodeJS.ProcessEnv;

  it('refuses a blanket TRUST_PROXY', () => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY=true/);
    expect(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/8' }).trustProxy).toBe('10.0.0.0/8');
  });

  it('derives cookie security from the public URL', () => {
    expect(loadConfig(base).cookieSecure).toBe(true);
    expect(loadConfig({ PUBLIC_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv).cookieSecure).toBe(false);
  });

  it('validates the unlock knobs', () => {
    const cfg = loadConfig({ ...base, ACCESS_CODE_TTL_MINUTES: '5', ACCESS_SESSION_TTL_MINUTES: '30', MAX_CODE_ATTEMPTS: '3' });
    expect(cfg.accessCodeTtlMs).toBe(300_000);
    expect(cfg.accessSessionTtlMs).toBe(1_800_000);
    expect(cfg.maxCodeAttempts).toBe(3);
    expect(() => loadConfig({ ...base, MAX_CODE_ATTEMPTS: '0' })).toThrow(/MAX_CODE_ATTEMPTS/);
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'ftp://x' })).toThrow(/PUBLIC_URL/);
  });

  it('checks branding colours and logo types', () => {
    expect(loadBrand({ BRAND_COLOR_PRIMARY: '#0F766E' } as NodeJS.ProcessEnv).colorPrimary).toBe('#0f766e');
    expect(() => loadBrand({ BRAND_COLOR_PRIMARY: 'teal' } as NodeJS.ProcessEnv)).toThrow(/hex colour/);
    expect(() => loadBrand({ BRAND_LOGO_PATH: './logo.bmp' } as NodeJS.ProcessEnv)).toThrow(/BRAND_LOGO_PATH/);
    expect(loadBrand({} as NodeJS.ProcessEnv).name).toBe('outletbox');
  });
});
