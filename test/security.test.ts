import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_PASS, ADMIN_USER, adminPost, boot, lastCode, pathOf, RECIPIENT, randomBytes, unlock, uploadFile, Visitor, type TestApp,
} from './helpers.js';

let app: TestApp;

beforeAll(async () => { app = await boot(); });
afterAll(async () => { await app.close(); });

describe('response headers', () => {
  it('ships a strict CSP and no framing on every page', async () => {
    const link = app.mkLink(app.mkCase().id);
    for (const url of ['/', '/admin/login', pathOf(link.url)]) {
      const res = await fetch(`${app.base}${url}`);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain('unsafe-inline');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-powered-by')).toBeNull();
    }
  });
});

describe('cookies', () => {
  it('marks the admin session HttpOnly and SameSite=Lax', async () => {
    const res = await fetch(`${app.base}/admin/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
    });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure'); // COOKIE_SECURE=false for the plain-HTTP test server
  });

  it('marks the recipient session the same way and rotates the id at login', async () => {
    const c = app.mkCase();
    const link = app.mkLink(c.id);
    const v = new Visitor(app.base);
    const p = pathOf(link.url);
    await v.getPage(p);
    await v.post(`${p}/email`, { email: RECIPIENT });
    const res = await fetch(`${app.base}${p}/code`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: v.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded', origin: app.base },
      body: new URLSearchParams({ _flow: v.flowToken(), code: lastCode(app) }),
    });
    const cookie = res.headers.getSetCookie().find((c2) => c2.startsWith('outletbox_access'))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    const first = await app.adminLogin();
    const second = await app.adminLogin();
    expect(first.cookie).not.toBe(second.cookie);
  });

  it('a recipient session is worthless on another link', async () => {
    const a = app.mkCase('Case A');
    const b = app.mkCase('Case B');
    const linkA = app.mkLink(a.id);
    const linkB = app.mkLink(b.id);
    const v = await unlock(app, linkA.url);
    const page = await v.getPage(pathOf(linkB.url));
    expect(page.body).toContain('Confirm your e-mail address');
    expect(page.body).not.toContain('Case B');
  });
});

describe('CSRF', () => {
  it('rejects admin posts without a synchroniser token', async () => {
    const session = await app.adminLogin();
    const res = await fetch(`${app.base}/admin/cases`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'No token' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a cross-site post even with a stolen token', async () => {
    const session = await app.adminLogin();
    const res = await fetch(`${app.base}/admin/cases`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site', origin: 'https://evil.test' },
      body: new URLSearchParams({ _csrf: session.csrf, name: 'Cross site' }),
    });
    expect(res.status).toBe(403);
  });

  it('accepts Origin: null, which Referrer-Policy: no-referrer produces on same-origin forms', async () => {
    const session = await app.adminLogin();
    const res = await fetch(`${app.base}/admin/cases`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded', origin: 'null', 'sec-fetch-site': 'same-origin' },
      body: new URLSearchParams({ _csrf: session.csrf, name: 'Null origin' }),
    });
    expect(res.status).toBe(303);
  });

  it('rejects an upload without the CSRF header', async () => {
    const session = await app.adminLogin();
    const c = app.mkCase();
    const res = await fetch(`${app.base}/admin/api/cases/${c.id}/upload/x.bin`, {
      method: 'PUT', headers: { cookie: session.cookie }, body: randomBytes(64),
    });
    expect(res.status).toBe(403);
  });

  it('rejects recipient forms without the flow cookie', async () => {
    const link = app.mkLink(app.mkCase().id);
    const p = pathOf(link.url);
    const before = app.mailer.recent().length;
    const res = await fetch(`${app.base}${p}/email`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: app.base },
      body: new URLSearchParams({ _flow: 'made-up', email: RECIPIENT }),
    });
    expect(res.status).toBe(403);
    expect(app.mailer.recent().length).toBe(before);
  });
});

describe('authentication boundaries', () => {
  it('keeps the panel and the upload API out of reach without a session', async () => {
    const c = app.mkCase();
    expect((await fetch(`${app.base}/admin`, { redirect: 'manual' })).status).toBe(302);
    expect((await fetch(`${app.base}/admin/audit`, { redirect: 'manual' })).status).toBe(302);
    const tus = await fetch(`${app.base}/admin/api/tus`, { method: 'POST', headers: { 'tus-resumable': '1.0.0', 'upload-length': '10' } });
    expect(tus.status).toBe(401);
    const put = await fetch(`${app.base}/admin/api/cases/${c.id}/upload/x.bin`, { method: 'PUT', body: randomBytes(8) });
    expect(put.status).toBe(401);
  });

  it('ends a session on logout', async () => {
    const session = await app.adminLogin();
    const out = await adminPost(app, session, '/admin/logout');
    expect(out.status).toBe(303);
    expect((await fetch(`${app.base}/admin`, { headers: { cookie: session.cookie }, redirect: 'manual' })).status).toBe(302);
  });

  it('does not serve files through the static handler', async () => {
    for (const p of ['/static/../src/server.ts', '/static/%2e%2e/package.json', '/static/../../etc/passwd']) {
      const res = await fetch(`${app.base}${p}`, { redirect: 'manual' });
      expect([301, 302, 400, 403, 404]).toContain(res.status);
    }
  });
});

describe('rate limiting', () => {
  it('throttles guesses at delivery tokens', async () => {
    const strict = await boot({ TOKEN_FAILURE_RATE_LIMIT_PER_15MIN: '3' });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push((await fetch(`${strict.base}/d/${'a'.repeat(43)}`)).status);
      }
      expect(statuses.filter((s) => s === 404).length).toBe(3);
      expect(statuses.at(-1)).toBe(429);
    } finally {
      await strict.close();
    }
  });

  it('throttles wrong passwords', async () => {
    const strict = await boot({ LOGIN_RATE_LIMIT_PER_15MIN: '3' });
    try {
      let last = 0;
      for (let i = 0; i < 5; i++) {
        last = (await fetch(`${strict.base}/admin/login`, {
          method: 'POST', redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ username: ADMIN_USER, password: 'wrong' }),
        })).status;
      }
      expect(last).toBe(429);
    } finally {
      await strict.close();
    }
  });

  it('throttles wrong codes from one address', async () => {
    const strict = await boot({ TOKEN_FAILURE_RATE_LIMIT_PER_15MIN: '3', MAX_CODE_ATTEMPTS: '50' });
    try {
      const link = strict.mkLink(strict.mkCase().id);
      const p = pathOf(link.url);
      const v = new Visitor(strict.base);
      await v.getPage(p);
      await v.post(`${p}/email`, { email: RECIPIENT });
      let last = 0;
      for (let i = 0; i < 12; i++) last = (await v.post(`${p}/code`, { code: '000000' })).res.status;
      expect(last).toBe(429);
    } finally {
      await strict.close();
    }
  });
});

describe('storage hygiene', () => {
  it('writes private files the web server cannot reach', async () => {
    if (process.env.TEST_S3 === '1') return;
    const session = await app.adminLogin();
    const c = app.mkCase();
    const up = await uploadFile(app, session, c.id, 'private.bin', randomBytes(64));
    const item = await up.json() as { id: string };
    const { statSync } = await import('node:fs');
    expect(statSync(app.fileOnDisk(item.id)).mode & 0o777).toBe(0o600);
    expect((await fetch(`${app.base}/static/${item.id}`)).status).toBe(404);
  });
});
