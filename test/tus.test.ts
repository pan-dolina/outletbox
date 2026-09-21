import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as tus from 'tus-js-client';
import {
  adminPost, b64, boot, pathOf, randomBytes, TUS_HEADERS, tusCreate, tusHead, tusPatch, unlock, type AdminSession, type TestApp,
} from './helpers.js';

let app: TestApp;
let session: AdminSession;

beforeAll(async () => { app = await boot(); session = await app.adminLogin(); });
afterAll(async () => { await app.close(); });

describe('resumable uploads from the panel', () => {
  it('creates, patches and finishes an upload the recipient can then download', async () => {
    const c = app.mkCase();
    const data = randomBytes(300_000);
    const created = await tusCreate(app, session, c.id, data.length, 'big file.bin');
    expect(created.status).toBe(201);
    const location = created.headers.get('location')!;
    expect(location).toContain('/admin/api/tus/');

    const half = data.subarray(0, 100_000);
    const first = await tusPatch(app, session, location, 0, half);
    expect(first.status).toBe(204);
    expect(first.headers.get('upload-offset')).toBe('100000');

    const head = await tusHead(app, session, location);
    expect(head.headers.get('upload-offset')).toBe('100000');

    const rest = await tusPatch(app, session, location, 100_000, data.subarray(100_000));
    expect(rest.status).toBe(204);

    const id = location.split('/').pop()!;
    expect(app.ctx.db.prepare('SELECT status, size FROM items WHERE id = ?').get(id)).toMatchObject({ status: 'ready', size: data.length });

    const link = app.mkLink(c.id);
    const v = await unlock(app, link.url);
    expect(v.lastBody).toContain('big file.bin');
    const dl = await v.get(`${pathOf(link.url)}/files/${id}`);
    expect(Buffer.from(await dl.arrayBuffer()).equals(data)).toBe(true);
  });

  it('refuses a wrong offset and a finished upload', async () => {
    const c = app.mkCase();
    const data = randomBytes(1000);
    const created = await tusCreate(app, session, c.id, data.length, 'x.bin');
    const location = created.headers.get('location')!;
    const wrong = await tusPatch(app, session, location, 500, data);
    expect(wrong.status).toBe(409);
    expect((await tusPatch(app, session, location, 0, data)).status).toBe(204);
    // The sidecar is gone once an upload completes, so tus cannot touch it again.
    expect((await tusPatch(app, session, location, 0, data)).status).toBe(410);
    expect((await tusHead(app, session, location)).status).toBe(410);
  });

  it('never acts as a download endpoint', async () => {
    const c = app.mkCase();
    const created = await tusCreate(app, session, c.id, 10, 'x.bin');
    const location = created.headers.get('location')!;
    const res = await fetch(`${app.base}${location}`, { headers: { cookie: session.cookie, 'x-csrf-token': session.csrf } });
    expect(res.status).toBe(405);
  });

  it('insists on a real, open case', async () => {
    const missing = await tusCreate(app, session, 'c_notarealcaseid00', 10, 'x.bin');
    expect([400, 404]).toContain(missing.status);

    const c = app.mkCase();
    await adminPost(app, session, `/admin/cases/${c.id}/status`, { status: 'closed' });
    expect((await tusCreate(app, session, c.id, 10, 'x.bin')).status).toBe(403);

    const noCase = await fetch(`${app.base}/admin/api/tus`, {
      method: 'POST',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, ...TUS_HEADERS, 'upload-length': '10', 'upload-metadata': `filename ${b64('x.bin')}` },
    });
    expect(noCase.status).toBe(400);
  });

  it('requires a declared length', async () => {
    const c = app.mkCase();
    const res = await fetch(`${app.base}/admin/api/tus`, {
      method: 'POST',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, ...TUS_HEADERS, 'upload-defer-length': '1', 'upload-metadata': `caseId ${b64(c.id)}` },
    });
    expect(res.status).toBe(400);
  });

  it('releases an upload the browser cancels', async () => {
    const c = app.mkCase();
    const created = await tusCreate(app, session, c.id, 50_000, 'cancelled.bin');
    const location = created.headers.get('location')!;
    const id = location.split('/').pop()!;
    await tusPatch(app, session, location, 0, randomBytes(10_000));
    const del = await fetch(`${app.base}${location}`, {
      method: 'DELETE', headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, ...TUS_HEADERS },
    });
    expect(del.status).toBe(204);
    expect(app.ctx.db.prepare('SELECT status FROM items WHERE id = ?').get(id)).toMatchObject({ status: 'aborted' });
  });

  it('answers the protocol handshake and rejects a request without the CSRF header', async () => {
    const options = await fetch(`${app.base}/admin/api/tus`, { method: 'OPTIONS', headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, ...TUS_HEADERS } });
    expect([200, 204]).toContain(options.status);

    const c = app.mkCase();
    const noCsrf = await fetch(`${app.base}/admin/api/tus`, {
      method: 'POST',
      headers: { cookie: session.cookie, ...TUS_HEADERS, 'upload-length': '10', 'upload-metadata': `caseId ${b64(c.id)}` },
    });
    expect(noCsrf.status).toBe(403);
  });

  it('answers unknown API paths with JSON, not an HTML page', async () => {
    const res = await fetch(`${app.base}/admin/api/nothing-here`, { headers: { cookie: session.cookie } });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });

  it('works with tus-js-client, including a resume after an interruption', async () => {
    const c = app.mkCase();
    const data = randomBytes(600_000);
    const headers = { cookie: session.cookie, 'x-csrf-token': session.csrf };
    let uploadUrl = '';

    // First attempt: abort after the first chunk.
    await new Promise<void>((resolve, reject) => {
      const upload = new tus.Upload(Buffer.from(data), {
        endpoint: `${app.base}/admin/api/tus`,
        headers,
        chunkSize: 200_000,
        uploadSize: data.length,
        metadata: { filename: 'resumed.bin', caseId: c.id },
        onError: reject,
        onChunkComplete: () => {
          uploadUrl = upload.url ?? '';
          upload.abort().then(() => resolve()).catch(reject);
        },
        onSuccess: () => resolve(),
      });
      upload.start();
    });
    expect(uploadUrl).toBeTruthy();

    await new Promise<void>((resolve, reject) => {
      const upload = new tus.Upload(Buffer.from(data), {
        endpoint: `${app.base}/admin/api/tus`,
        uploadUrl,
        headers,
        chunkSize: 200_000,
        uploadSize: data.length,
        metadata: { filename: 'resumed.bin', caseId: c.id },
        onError: reject,
        onSuccess: () => resolve(),
      });
      upload.start();
    });

    const id = uploadUrl.split('/').pop()!;
    expect(app.ctx.db.prepare('SELECT status, size FROM items WHERE id = ?').get(id)).toMatchObject({ status: 'ready', size: data.length });
  });
});
