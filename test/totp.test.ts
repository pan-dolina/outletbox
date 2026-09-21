import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_PASS, ADMIN_USER, adminPost, boot, type TestApp } from './helpers.js';
import { hotp, totp, totpStep, base32Decode, base32Encode, generateTotpSecret } from '../src/totp.js';
import {
  beginTotpEnrolment, confirmTotpEnrolment, createSession, disableTotp, findAdminByUsername, forceDisableTotp, getSession,
  MAX_TOTP_ATTEMPTS, regenerateRecoveryCodes, remainingRecoveryCodes, TOTP_ACCOUNT_LOCK_THRESHOLD, verifySessionTotp,
} from '../src/services/auth.js';

let app: TestApp;

beforeAll(async () => { app = await boot(); });
afterAll(async () => { await app.close(); });

const SECRET_RFC = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('RFC 6238 / 4226', () => {
  it('matches the reference vectors', () => {
    expect(hotp(SECRET_RFC, 0)).toBe('755224');
    expect(hotp(SECRET_RFC, 1)).toBe('287082');
    expect(hotp(SECRET_RFC, 9)).toBe('520489');
    expect(totp(SECRET_RFC, 59_000)).toBe('287082');
    expect(totpStep(59_000)).toBe(1);
  });

  it('round-trips base32 and generates usable secrets', () => {
    expect(base32Decode(base32Encode(Buffer.from('hello world'))).toString()).toBe('hello world');
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(totp(secret)).toMatch(/^\d{6}$/);
  });
});

/**
 * The replay guard remembers the last accepted step, so a code from the same
 * 30-second window is refused afterwards. Tests clear the marker instead of
 * sleeping half a minute between steps.
 */
function clearReplayGuard(db: TestApp['ctx']['db'], adminId: string): void {
  db.prepare('UPDATE admins SET totp_last_step = NULL WHERE id = ?').run(adminId);
}

describe('enrolment and login', () => {
  function enrol(username: string) {
    const admin = findAdminByUsername(app.ctx.db, username)!;
    const { secret } = beginTotpEnrolment(app.ctx.db, admin.id);
    clearReplayGuard(app.ctx.db, admin.id);
    const codes = confirmTotpEnrolment(app.ctx.db, admin.id, totp(secret));
    expect(codes).not.toBeNull();
    clearReplayGuard(app.ctx.db, admin.id);
    return { admin, secret, codes: codes! };
  }

  it('requires a matching code to enable, and issues recovery codes', () => {
    const admin = findAdminByUsername(app.ctx.db, ADMIN_USER)!;
    const { secret } = beginTotpEnrolment(app.ctx.db, admin.id);
    expect(confirmTotpEnrolment(app.ctx.db, admin.id, '000000')).toBeNull();
    clearReplayGuard(app.ctx.db, admin.id);
    const codes = confirmTotpEnrolment(app.ctx.db, admin.id, totp(secret));
    expect(codes).toHaveLength(8);
    expect(remainingRecoveryCodes(app.ctx.db, admin.id)).toBe(8);
    clearReplayGuard(app.ctx.db, admin.id);

    // A recovery code works once and then is spent.
    const { sessionId } = createSession(app.ctx.db, { ...admin, totp_enabled: true }, 3600_000);
    expect(verifySessionTotp(app.ctx.db, sessionId, codes![0]!, 3600_000).status).toBe('ok');
    expect(remainingRecoveryCodes(app.ctx.db, admin.id)).toBe(7);

    forceDisableTotp(app.ctx.db, admin.id);
  });

  it('refuses to replay the same time step and destroys a session after five wrong codes', () => {
    const { admin, secret } = enrol(ADMIN_USER);
    const { sessionId } = createSession(app.ctx.db, { ...admin, totp_enabled: true }, 3600_000);
    const code = totp(secret);
    expect(verifySessionTotp(app.ctx.db, sessionId, code, 3600_000).status).toBe('ok');

    const second = createSession(app.ctx.db, { ...admin, totp_enabled: true }, 3600_000);
    expect(verifySessionTotp(app.ctx.db, second.sessionId, code, 3600_000).status).toBe('invalid');

    const third = createSession(app.ctx.db, { ...admin, totp_enabled: true }, 3600_000);
    for (let i = 1; i < MAX_TOTP_ATTEMPTS; i++) {
      expect(verifySessionTotp(app.ctx.db, third.sessionId, '000000', 3600_000).status).toBe('invalid');
    }
    expect(verifySessionTotp(app.ctx.db, third.sessionId, '000000', 3600_000).status).toBe('locked');
    expect(getSession(app.ctx.db, third.sessionId)).toBeNull();

    forceDisableTotp(app.ctx.db, admin.id);
  });

  it('locks the account itself after enough wrong codes across sessions', () => {
    const { admin } = enrol(ADMIN_USER);
    let last: string | undefined;
    for (let i = 0; i < TOTP_ACCOUNT_LOCK_THRESHOLD + 1; i++) {
      const s = createSession(app.ctx.db, { ...admin, totp_enabled: true }, 3600_000);
      last = verifySessionTotp(app.ctx.db, s.sessionId, '000000', 3600_000).status;
    }
    expect(last).toBe('locked');
    forceDisableTotp(app.ctx.db, admin.id);
  });

  it('needs a current code to regenerate recovery codes or switch TOTP off', () => {
    const { admin, secret } = enrol(ADMIN_USER);
    const { sessionId } = createSession(app.ctx.db, { ...admin, totp_enabled: true }, 3600_000);
    expect(regenerateRecoveryCodes(app.ctx.db, admin.id, '000000')).toBeNull();
    expect(regenerateRecoveryCodes(app.ctx.db, admin.id, totp(secret))).toHaveLength(8);
    expect(disableTotp(app.ctx.db, admin.id, '000000', sessionId)).toBe(false);
    clearReplayGuard(app.ctx.db, admin.id);
    expect(disableTotp(app.ctx.db, admin.id, totp(secret), sessionId)).toBe(true);
    expect(findAdminByUsername(app.ctx.db, ADMIN_USER)!.totp_enabled).toBe(false);
  });
});

describe('the panel behind a second factor', () => {
  it('parks a password-only session on the code page', async () => {
    const withTotp = await boot();
    try {
      const admin = findAdminByUsername(withTotp.ctx.db, ADMIN_USER)!;
      const { secret } = beginTotpEnrolment(withTotp.ctx.db, admin.id);
      expect(confirmTotpEnrolment(withTotp.ctx.db, admin.id, totp(secret))).not.toBeNull();
      clearReplayGuard(withTotp.ctx.db, admin.id);

      const login = await fetch(`${withTotp.base}/admin/login`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
      });
      expect(login.headers.get('location')).toBe('/admin/totp');
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

      const panel = await fetch(`${withTotp.base}/admin`, { headers: { cookie }, redirect: 'manual' });
      expect(panel.headers.get('location')).toBe('/admin/totp');

      const form = await (await fetch(`${withTotp.base}/admin/totp`, { headers: { cookie } })).text();
      const csrf = /name="_csrf" value="([^"]+)"/.exec(form)![1]!;
      const step = await fetch(`${withTotp.base}/admin/totp`, {
        method: 'POST', redirect: 'manual',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrf, code: totp(secret) }),
      });
      expect(step.status).toBe(303);
      // The privileged session gets a brand new id.
      const upgraded = step.headers.get('set-cookie')!.split(';')[0]!;
      expect(upgraded).not.toBe(cookie);
      expect((await fetch(`${withTotp.base}/admin`, { headers: { cookie: upgraded }, redirect: 'manual' })).status).toBe(200);
    } finally {
      await withTotp.close();
    }
  });

  it('with ADMIN_REQUIRE_TOTP only the security page is reachable', async () => {
    const strict = await boot({ ADMIN_REQUIRE_TOTP: 'true' });
    try {
      const session = await strict.adminLogin();
      const page = await fetch(`${strict.base}/admin`, { headers: { cookie: session.cookie }, redirect: 'manual' });
      expect(page.headers.get('location')).toBe('/admin/security');
      const post = await adminPost(strict, session, '/admin/cases', { name: 'nope' });
      expect(post.status).toBe(403);
    } finally {
      await strict.close();
    }
  });
});
