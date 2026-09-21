import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminDownload, adminPost, boot, pathOf, randomBytes, RECIPIENT, unlock, uploadFile, Visitor, type AdminSession, type TestApp,
} from './helpers.js';

let app: TestApp;
let session: AdminSession;

beforeAll(async () => { app = await boot(); session = await app.adminLogin(); });
afterAll(async () => { await app.close(); });

async function newCase(name = 'Case from the panel'): Promise<string> {
  const res = await adminPost(app, session, '/admin/cases', { name, description: 'Description' });
  expect(res.status).toBe(303);
  return res.headers.get('location')!.replace('/admin/cases/', '');
}

describe('cases and contents', () => {
  it('creates a case through the form and lists it', async () => {
    const id = await newCase('Quarterly report');
    const list = await (await fetch(`${app.base}/admin`, { headers: { cookie: session.cookie } })).text();
    expect(list).toContain('Quarterly report');
    expect(list).toContain(id);
  });

  it('uploads a file and offers it back to the administrator', async () => {
    const id = await newCase();
    const payload = randomBytes(4096);
    const res = await uploadFile(app, session, id, 'statement.pdf', payload);
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; size: number; sha256: string; status: string };
    expect(body.size).toBe(payload.length);
    expect(body.status).toBe('ready');

    const page = await (await fetch(`${app.base}/admin/cases/${id}`, { headers: { cookie: session.cookie } })).text();
    expect(page).toContain('statement.pdf');
    expect(page).toContain(body.sha256.slice(0, 12));

    const dl = await adminDownload(app, session, body.id);
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).equals(payload)).toBe(true);
  });

  it('adds a note and refuses an empty one', async () => {
    const id = await newCase();
    const ok = await adminPost(app, session, `/admin/cases/${id}/notes`, { title: 'Password', body: 'hunter2' });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Note added');

    const bad = await adminPost(app, session, `/admin/cases/${id}/notes`, { title: '  ', body: '' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('A note needs a title and some text');
  });

  it('deletes an item and removes the object from storage', async () => {
    const id = await newCase();
    const up = await uploadFile(app, session, id, 'gone.bin', randomBytes(512));
    const item = await up.json() as { id: string };
    const res = await adminPost(app, session, `/admin/items/${item.id}/delete`);
    expect(res.status).toBe(303);
    expect(app.ctx.db.prepare('SELECT status FROM items WHERE id = ?').get(item.id)).toMatchObject({ status: 'deleted' });
    expect(await app.ctx.storage.stat(item.id)).toBeNull();
    expect((await adminDownload(app, session, item.id)).status).toBe(404);
  });

  it('sanitises hostile file names', async () => {
    const id = await newCase();
    const res = await uploadFile(app, session, id, '../../etc/passwd', randomBytes(32));
    const item = await res.json() as { id: string; name: string };
    expect(item.name).toBe('passwd');
    const xss = await uploadFile(app, session, id, '<img src=x onerror=alert(1)>.png', randomBytes(32));
    const page = await (await fetch(`${app.base}/admin/cases/${id}`, { headers: { cookie: session.cookie } })).text();
    expect(page).not.toContain('<img src=x');
    expect(page).toContain('&lt;img src=x');
    expect((await xss.json() as { status: string }).status).toBe('ready');
  });

  it('refuses uploads into a closed case', async () => {
    const id = await newCase();
    await adminPost(app, session, `/admin/cases/${id}/status`, { status: 'closed' });
    const res = await uploadFile(app, session, id, 'late.bin', randomBytes(16));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'case_closed' });
  });

  it('rejects a file above the global limit', async () => {
    const small = await boot({ MAX_FILE_SIZE: '1024' });
    try {
      const s = await small.adminLogin();
      const c = small.mkCase();
      const res = await uploadFile(small, s, c.id, 'big.bin', randomBytes(4096));
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: 'file_too_large', limit: 1024 });
    } finally {
      await small.close();
    }
  });
});

describe('recipient links', () => {
  it('shows the full URL exactly once and only a hint afterwards', async () => {
    const id = await newCase();
    const created = await adminPost(app, session, `/admin/cases/${id}/links`, { label: 'Jan', email: RECIPIENT });
    const body = await created.text();
    const url = /value="(http:[^"]+\/d\/[^"]+)"/.exec(body)![1]!;
    const token = url.split('/d/')[1]!;

    const later = await (await fetch(`${app.base}/admin/cases/${id}`, { headers: { cookie: session.cookie } })).text();
    expect(later).not.toContain(token);
    expect(later).toContain(token.slice(0, 6));
    expect(later).toContain(RECIPIENT);
  });

  it('never mails the link, whatever the form is asked to do', async () => {
    const id = await newCase('Delivery without mail');
    const before = app.mailer.recent().length;
    // send_email is a leftover an old client might still post; it must do nothing.
    const res = await adminPost(app, session, `/admin/cases/${id}/links`, { label: 'Jan', email: RECIPIENT, send_email: '1' });
    const body = await res.text();
    expect(body).toContain('/d/');
    expect(app.mailer.recent().length).toBe(before);
    expect(body).toContain('never sends the link itself');
  });

  it('rejects a link without a usable address', async () => {
    const id = await newCase();
    const res = await adminPost(app, session, `/admin/cases/${id}/links`, { label: 'Jan', email: 'nope' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('valid recipient e-mail address');
  });

  it('reissuing a link rotates the token, ends the session and sends nothing', async () => {
    const id = await newCase();
    const link = app.mkLink(id);
    const visitor = await unlock(app, link.url);
    expect(visitor.lastBody).toContain('Your delivery');

    const before = app.mailer.recent().length;
    const res = await adminPost(app, session, `/admin/links/${link.id}/reissue`);
    const body = await res.text();
    const fresh = /value="(http:[^"]+\/d\/[^"]+)"/.exec(body)![1]!;
    expect(fresh).not.toBe(link.url);
    expect(app.mailer.recent().length).toBe(before);

    // The old URL is dead, and the session opened with it is gone too.
    const old = await new Visitor(app.base).getPage(pathOf(link.url));
    expect(old.res.status).toBe(404);
    expect((await visitor.getPage(pathOf(fresh))).body).toContain('Confirm your e-mail address');
  });

  it('refuses to create links in a closed case', async () => {
    const id = await newCase();
    await adminPost(app, session, `/admin/cases/${id}/status`, { status: 'closed' });
    const res = await adminPost(app, session, `/admin/cases/${id}/links`, { label: 'Jan', email: RECIPIENT });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('case is closed');
  });
});

describe('audit log', () => {
  it('records the administrator actions and stays free of tokens', async () => {
    const id = await newCase('Audited case');
    const link = app.mkLink(id);
    await unlock(app, link.url);
    const page = await (await fetch(`${app.base}/admin/audit`, { headers: { cookie: session.cookie } })).text();
    expect(page).toContain('case.create');
    expect(page).toContain('access.granted');
    expect(page).not.toContain(link.token);
  });
});
