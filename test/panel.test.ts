import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ADMIN_PASS, ADMIN_USER, adminPost, boot, RECIPIENT, randomBytes, uploadFile, type AdminSession, type TestApp } from './helpers.js';
import { findAdminByUsername, forceDisableTotp } from '../src/services/auth.js';
import { totp } from '../src/totp.js';

let app: TestApp;
let session: AdminSession;

beforeAll(async () => { app = await boot(); session = await app.adminLogin(); });
afterAll(async () => { await app.close(); });
afterEach(() => { vi.restoreAllMocks(); });

async function page(urlPath: string, cookie = session.cookie): Promise<string> {
  return (await fetch(`${app.base}${urlPath}`, { headers: { cookie } })).text();
}

describe('security page', () => {
  it('walks through enabling TOTP, new recovery codes and switching it off', async () => {
    const fresh = await boot();
    try {
      const s = await fresh.adminLogin();
      const admin = findAdminByUsername(fresh.ctx.db, ADMIN_USER)!;
      const clearGuard = () => fresh.ctx.db.prepare('UPDATE admins SET totp_last_step = NULL WHERE id = ?').run(admin.id);

      const started = await adminPost(fresh, s, '/admin/security/totp/begin');
      const startedBody = await started.text();
      expect(startedBody).toContain('Step 1');
      // The page prints the key in groups of four for manual entry.
      const grouped = /<p class="mono breakable">([A-Z2-7 ]+)<\/p>/.exec(startedBody)![1]!;
      const key = grouped.replace(/\s/g, '');
      expect(key.length).toBeGreaterThan(15);

      const wrong = await adminPost(fresh, s, '/admin/security/totp/confirm', { code: '000000' });
      expect(wrong.status).toBe(400);
      expect(await wrong.text()).toContain('does not match');

      const ok = await adminPost(fresh, s, '/admin/security/totp/confirm', { code: totp(key) });
      const okBody = await ok.text();
      expect(okBody).toContain('Two-factor authentication is enabled');
      expect(okBody).toContain('Recovery codes');

      clearGuard();
      const regen = await adminPost(fresh, s, '/admin/security/totp/recovery', { code: totp(key) });
      expect(await regen.text()).toContain('New recovery codes generated');

      clearGuard();
      const off = await adminPost(fresh, s, '/admin/security/totp/disable', { code: totp(key) });
      expect(await off.text()).toContain('has been disabled');
      expect(findAdminByUsername(fresh.ctx.db, ADMIN_USER)!.totp_enabled).toBe(false);
    } finally {
      await fresh.close();
    }
  });

  it('refuses to disable TOTP when the instance requires it', async () => {
    const strict = await boot({ ADMIN_REQUIRE_TOTP: 'true' });
    try {
      const s = await strict.adminLogin();
      const admin = findAdminByUsername(strict.ctx.db, ADMIN_USER)!;
      expect(await page('/admin/security', s.cookie)).toBeTruthy();
      const res = await adminPost(strict, s, '/admin/security/totp/disable', { code: '000000' });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('cannot be disabled');
      forceDisableTotp(strict.ctx.db, admin.id);
    } finally {
      await strict.close();
    }
  });

  it('changes the password, ends other sessions and rejects a wrong current one', async () => {
    const fresh = await boot();
    try {
      const first = await fresh.adminLogin();
      const second = await fresh.adminLogin();

      const mismatch = await adminPost(fresh, first, '/admin/security/password', {
        current_password: ADMIN_PASS, new_password: 'a-new-long-password', new_password_confirm: 'something-else',
      });
      expect(mismatch.status).toBe(400);
      expect(await mismatch.text()).toContain('do not match');

      const wrongCurrent = await adminPost(fresh, first, '/admin/security/password', {
        current_password: 'not-it', new_password: 'a-new-long-password', new_password_confirm: 'a-new-long-password',
      });
      expect(wrongCurrent.status).toBe(400);
      expect(await wrongCurrent.text()).toContain('current password is incorrect');

      const tooShort = await adminPost(fresh, first, '/admin/security/password', {
        current_password: ADMIN_PASS, new_password: 'short', new_password_confirm: 'short',
      });
      expect(tooShort.status).toBe(400);

      const changed = await adminPost(fresh, first, '/admin/security/password', {
        current_password: ADMIN_PASS, new_password: 'a-new-long-password', new_password_confirm: 'a-new-long-password',
      });
      expect(await changed.text()).toContain('Password changed');
      // The session that made the change survives; the other one does not.
      expect((await fetch(`${fresh.base}/admin`, { headers: { cookie: first.cookie }, redirect: 'manual' })).status).toBe(200);
      expect((await fetch(`${fresh.base}/admin`, { headers: { cookie: second.cookie }, redirect: 'manual' })).status).toBe(302);
    } finally {
      await fresh.close();
    }
  });

  it('redirects a logged-in admin away from the login form', async () => {
    const res = await fetch(`${app.base}/admin/login`, { headers: { cookie: session.cookie }, redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
  });
});

describe('case editing', () => {
  it('saves a new name and description, and rejects an empty name', async () => {
    const created = await adminPost(app, session, '/admin/cases', { name: 'Before' });
    const id = created.headers.get('location')!.replace('/admin/cases/', '');
    const saved = await adminPost(app, session, `/admin/cases/${id}`, { name: 'After', description: 'Now with a description' });
    expect(await saved.text()).toContain('Saved');
    expect(await page(`/admin/cases/${id}`)).toContain('Now with a description');

    const empty = await adminPost(app, session, `/admin/cases/${id}`, { name: '   ' });
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain('1-200 characters');

    const noName = await adminPost(app, session, '/admin/cases', { name: '' });
    expect(noName.status).toBe(400);
  });

  it('reopens a closed case', async () => {
    const created = await adminPost(app, session, '/admin/cases', { name: 'Reopen me' });
    const id = created.headers.get('location')!.replace('/admin/cases/', '');
    await adminPost(app, session, `/admin/cases/${id}/status`, { status: 'closed' });
    expect(await page(`/admin/cases/${id}`)).toContain('badge-closed');
    await adminPost(app, session, `/admin/cases/${id}/status`, { status: 'open' });
    expect(await page(`/admin/cases/${id}`)).toContain('badge-open');
  });

  it('rejects an expiry date in the past or nonsense', async () => {
    const c = app.mkCase();
    const past = await adminPost(app, session, `/admin/cases/${c.id}/links`, { label: 'Jan', email: RECIPIENT, expires_at: '2020-01-01T10:00' });
    expect(past.status).toBe(400);
    expect(await past.text()).toContain('Expiry must be in the future');

    const nonsense = await adminPost(app, session, `/admin/cases/${c.id}/links`, { label: 'Jan', email: RECIPIENT, expires_at: 'tomorrow-ish' });
    expect(nonsense.status).toBe(400);
    expect(await nonsense.text()).toContain('Invalid expiry date');
  });

  it('accepts a future expiry and shows it', async () => {
    const c = app.mkCase();
    const when = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16);
    const res = await adminPost(app, session, `/admin/cases/${c.id}/links`, { label: 'Jan', email: RECIPIENT, expires_at: when, max_opens: '2' });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('/d/');
    expect(body).toContain('0 of 2');
  });
});

describe('the panel never mails a link', () => {
  it('creating a recipient sends nothing at all', async () => {
    const send = vi.spyOn(app.ctx.mailer, 'send');
    const c = app.mkCase();
    const res = await adminPost(app, session, `/admin/cases/${c.id}/links`, { label: 'Jan', email: RECIPIENT });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/d/');
    expect(send).not.toHaveBeenCalled();
  });

  it('reissuing sends nothing either, and a broken mailer cannot break it', async () => {
    const c = app.mkCase();
    const link = app.mkLink(c.id);
    vi.spyOn(app.ctx.mailer, 'send').mockRejectedValue(new Error('relay refused'));
    const res = await adminPost(app, session, `/admin/links/${link.id}/reissue`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/d/');
  });
});

describe('streaming uploads', () => {
  it('counts a chunked body and cuts it off at the limit', async () => {
    const small = await boot({ MAX_FILE_SIZE: '4096' });
    try {
      const s = await small.adminLogin();
      const c = small.mkCase();
      const chunks = [randomBytes(2048), randomBytes(2048), randomBytes(2048)];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
      });
      const res = await fetch(`${small.base}/admin/api/cases/${c.id}/upload/too-big.bin`, {
        method: 'PUT',
        headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/octet-stream' },
        body: stream,
        // @ts-expect-error undici option
        duplex: 'half',
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: 'file_too_large' });
      expect(small.ctx.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE status = 'ready'`).get()).toMatchObject({ n: 0 });
    } finally {
      await small.close();
    }
  });

  it('accepts a chunked body that fits', async () => {
    const c = app.mkCase();
    const data = randomBytes(3000);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(data.subarray(0, 1500)); controller.enqueue(data.subarray(1500)); controller.close(); },
    });
    const res = await fetch(`${app.base}/admin/api/cases/${c.id}/upload/chunked.bin`, {
      method: 'PUT',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/octet-stream' },
      body: stream,
      // @ts-expect-error undici option
      duplex: 'half',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ size: 3000, status: 'ready' });
  });

  it('refuses an upload into a case that does not exist', async () => {
    const res = await uploadFile(app, session, 'c_zzzzzzzzzzzzzzzz', 'x.bin', randomBytes(16));
    expect(res.status).toBe(404);
  });
});
