import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminPost, boot, lastCode, mailsTo, pathOf, RECIPIENT, randomBytes, unlock, uploadFile, Visitor, type TestApp,
} from './helpers.js';

let app: TestApp;

beforeAll(async () => { app = await boot(); });
afterAll(async () => { await app.close(); });

/** A case with one note and one file in it, plus a link for the standard recipient. */
async function delivery(opts: { maxOpens?: number | null; name?: string } = {}) {
  const session = await app.adminLogin();
  const c = app.mkCase(opts.name ?? 'Audit report');
  app.mkNote(c.id, 'Archive password', 'correct-horse-battery');
  const payload = randomBytes(2048);
  const up = await uploadFile(app, session, c.id, 'report.pdf', payload);
  const item = await up.json() as { id: string };
  const link = app.mkLink(c.id, { maxOpens: opts.maxOpens ?? null });
  return { session, case: c, link, item, payload, path: pathOf(link.url) };
}

describe('recipient unlock flow', () => {
  it('asks for the address, mails a code and opens the delivery', async () => {
    const d = await delivery();
    const v = new Visitor(app.base);

    const first = await v.getPage(d.path);
    expect(first.res.status).toBe(200);
    // Nothing about the delivery may be visible before the address is proven.
    expect(first.body).not.toContain('Audit report');
    expect(first.body).not.toContain(RECIPIENT);
    expect(first.body).toContain('Confirm your e-mail address');

    const before = app.mailer.recent().length;
    const codeStep = await v.post(`${d.path}/email`, { email: RECIPIENT.toUpperCase() });
    expect(codeStep.res.status).toBe(200);
    expect(codeStep.body).toContain('Enter the code from the e-mail');
    expect(app.mailer.recent().length).toBe(before + 1);
    expect(mailsTo(app, RECIPIENT)[0]!.subject).toMatch(/Access code: \d{6}/);

    const opened = await v.post(`${d.path}/code`, { code: lastCode(app) });
    expect(opened.res.status).toBe(303);
    expect(opened.res.headers.get('location')).toBe(d.path);

    const page = await v.getPage(d.path);
    expect(page.body).toContain('Audit report');
    expect(page.body).toContain('Archive password');
    expect(page.body).toContain('correct-horse-battery');
    expect(page.body).toContain('report.pdf');

    const dl = await v.get(`${d.path}/files/${d.item.id}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toContain('report.pdf');
    expect(dl.headers.get('content-type')).toBe('application/octet-stream');
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await dl.arrayBuffer()).equals(d.payload)).toBe(true);
  });

  it('answers a wrong address exactly like a right one, but sends nothing', async () => {
    const d = await delivery();
    const v = new Visitor(app.base);
    await v.getPage(d.path);
    const before = app.mailer.recent().length;
    const res = await v.post(`${d.path}/email`, { email: 'somebody.else@example.com' });
    expect(res.res.status).toBe(200);
    expect(res.body).toContain('Enter the code from the e-mail');
    expect(app.mailer.recent().length).toBe(before);
  });

  it('rejects a malformed address before anything else happens', async () => {
    const d = await delivery();
    const v = new Visitor(app.base);
    await v.getPage(d.path);
    const res = await v.post(`${d.path}/email`, { email: 'not-an-address' });
    expect(res.res.status).toBe(400);
    expect(res.body).toContain('Enter a valid e-mail address');
  });

  it('counts wrong codes and destroys the challenge after the last attempt', async () => {
    const d = await delivery();
    const v = new Visitor(app.base);
    await v.getPage(d.path);
    await v.post(`${d.path}/email`, { email: RECIPIENT });

    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await v.post(`${d.path}/code`, { code: '000000' });
      expect(res.res.status).toBe(401);
      expect(res.body).toContain(`Attempts left: ${5 - attempt}`);
    }
    const last = await v.post(`${d.path}/code`, { code: '000000' });
    expect(last.res.status).toBe(401);
    expect(last.body).toContain('The code has expired or was used too many times');
    // Even the correct code is worthless now.
    const correct = await v.post(`${d.path}/code`, { code: lastCode(app) });
    expect(correct.body).toContain('The code has expired or was used too many times');
  });

  it('does not accept a code typed into a different browser', async () => {
    const d = await delivery();
    const asked = new Visitor(app.base);
    await asked.getPage(d.path);
    await asked.post(`${d.path}/email`, { email: RECIPIENT });
    const code = lastCode(app);

    const other = new Visitor(app.base);
    await other.getPage(d.path);
    const res = await other.post(`${d.path}/code`, { code });
    expect(res.res.status).toBe(401);
    expect(other.has('outletbox_access')).toBe(false);

    // The browser that asked for it still works.
    const ok = await asked.post(`${d.path}/code`, { code });
    expect(ok.res.status).toBe(303);
  });

  it('enforces the number of openings but lets an open session finish', async () => {
    const d = await delivery({ maxOpens: 1 });
    const v = await unlock(app, d.link.url);
    expect(v.lastBody).toContain('report.pdf');

    const second = new Visitor(app.base);
    const blocked = await second.getPage(d.path);
    expect(blocked.res.status).toBe(403);
    expect(blocked.body).toContain('opened the maximum number of times');

    // The session opened while there was still an opening left keeps working.
    const dl = await v.get(`${d.path}/files/${d.item.id}`);
    expect(dl.status).toBe(200);
  });

  it('ends every open session the moment the link is revoked', async () => {
    const d = await delivery();
    const v = await unlock(app, d.link.url);
    expect(v.lastBody).toContain('report.pdf');

    const revoke = await adminPost(app, d.session, `/admin/links/${d.link.id}/revoke`);
    expect(revoke.status).toBe(303);

    const after = await v.getPage(d.path);
    expect(after.res.status).toBe(403);
    expect(after.body).toContain('revoked');
    const dl = await v.get(`${d.path}/files/${d.item.id}`);
    expect(dl.status).toBe(403);
  });

  it('closes the door when the case is closed', async () => {
    const d = await delivery();
    const v = await unlock(app, d.link.url);
    await adminPost(app, d.session, `/admin/cases/${d.case.id}/status`, { status: 'closed' });
    const after = await v.getPage(d.path);
    expect(after.res.status).toBe(403);
    const dl = await v.get(`${d.path}/files/${d.item.id}`);
    expect(dl.status).toBe(403);
  });

  it('refuses an expired link', async () => {
    const d = await delivery();
    app.ctx.db.prepare('UPDATE links SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', d.link.id);
    const v = new Visitor(app.base);
    const res = await v.getPage(d.path);
    expect(res.res.status).toBe(403);
    expect(res.body).toContain('expired');
  });

  it('never serves an item that belongs to another case', async () => {
    const mine = await delivery();
    const theirs = await delivery({ name: 'Somebody else' });
    const v = await unlock(app, mine.link.url);
    const res = await v.get(`${mine.path}/files/${theirs.item.id}`);
    expect(res.status).toBe(404);
  });

  it('sends anyone without a session back to the address form', async () => {
    const d = await delivery();
    const v = new Visitor(app.base);
    await v.getPage(d.path);
    const res = await v.get(`${d.path}/files/${d.item.id}`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(d.path);
  });

  it('closes the session on request', async () => {
    const d = await delivery();
    const v = await unlock(app, d.link.url);
    const closed = await v.post(`${d.path}/close`, {});
    expect(closed.res.status).toBe(200);
    expect(closed.body).toContain('The session has ended');
    expect(v.has('outletbox_access')).toBe(false);
    const again = await v.getPage(d.path);
    expect(again.body).toContain('Confirm your e-mail address');
  });

  it('starts over when asked, dropping the pending code', async () => {
    const d = await delivery();
    const v = new Visitor(app.base);
    await v.getPage(d.path);
    await v.post(`${d.path}/email`, { email: RECIPIENT });
    const code = lastCode(app);
    const restarted = await v.post(`${d.path}/restart`, {});
    expect(restarted.res.status).toBe(303);
    const page = await v.getPage(d.path);
    expect(page.body).toContain('Confirm your e-mail address');
    const res = await v.post(`${d.path}/code`, { code });
    expect(res.body).toContain('The code has expired');
  });

  it('answers 404 for unknown and malformed tokens', async () => {
    const v = new Visitor(app.base);
    expect((await v.getPage('/d/not-a-token')).res.status).toBe(404);
    expect((await v.getPage(`/d/${'A'.repeat(43)}`)).res.status).toBe(404);
  });

  it('records the opening in the audit log without leaking the code', async () => {
    const d = await delivery();
    await unlock(app, d.link.url);
    const rows = app.ctx.db.prepare('SELECT action, details FROM audit_log WHERE link_id = ?').all(d.link.id) as Array<{ action: string; details: string | null }>;
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('access.code_sent');
    expect(actions).toContain('access.granted');
    const code = lastCode(app);
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(JSON.stringify(rows)).not.toContain(d.link.token);
  });
});

describe('challenge limits', () => {
  it('stops mail bombing one link', async () => {
    const limited = await boot({ CHALLENGE_LIMIT_PER_LINK_PER_HOUR: '2' });
    try {
      const c = limited.mkCase();
      const link = limited.mkLink(c.id);
      const p = pathOf(link.url);
      const v = new Visitor(limited.base);
      await v.getPage(p);
      for (let i = 0; i < 2; i++) {
        const ok = await v.post(`${p}/email`, { email: RECIPIENT });
        expect(ok.res.status).toBe(200);
      }
      const blocked = await v.post(`${p}/email`, { email: RECIPIENT });
      expect(blocked.res.status).toBe(429);
      expect(blocked.body).toContain('Too many code requests');
      expect(limited.mailer.recent().length).toBe(2);
    } finally {
      await limited.close();
    }
  });

  it('refuses a code once it has expired', async () => {
    const short = await boot({ ACCESS_CODE_TTL_MINUTES: '0' });
    try {
      const c = short.mkCase();
      const link = short.mkLink(c.id);
      const p = pathOf(link.url);
      const v = new Visitor(short.base);
      await v.getPage(p);
      await v.post(`${p}/email`, { email: RECIPIENT });
      const res = await v.post(`${p}/code`, { code: lastCode(short) });
      expect(res.res.status).toBe(401);
      expect(res.body).toContain('expired');
    } finally {
      await short.close();
    }
  });
});
