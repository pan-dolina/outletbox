import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  adminDownload, adminPost, boot, pathOf, randomBytes, tusCreate, tusPatch, unlock, uploadFile, USE_S3, Visitor, type AdminSession, type TestApp,
} from './helpers.js';
import { runCleanup } from '../src/services/cleanup.js';
import { assertValidKey } from '../src/storage/types.js';

let app: TestApp;
let session: AdminSession;

beforeAll(async () => { app = await boot(); session = await app.adminLogin(); });
afterAll(async () => { await app.close(); });
afterEach(() => { vi.restoreAllMocks(); });

function cleanupDeps() {
  return { db: app.ctx.db, cfg: app.ctx.cfg, storage: app.ctx.storage, tusStore: app.ctx.tusStore };
}

describe('cleanup', () => {
  it('expires an upload that was never finished and frees its data', async () => {
    const c = app.mkCase();
    const created = await tusCreate(app, session, c.id, 200_000, 'half.bin');
    const location = created.headers.get('location')!;
    const id = location.split('/').pop()!;
    await tusPatch(app, session, location, 0, randomBytes(50_000));

    const report = await runCleanup(cleanupDeps(), { ttlMs: 0 });
    expect(report.staleUploads).toBeGreaterThanOrEqual(1);
    expect(app.ctx.db.prepare('SELECT status FROM items WHERE id = ?').get(id)).toMatchObject({ status: 'expired' });
    expect(await app.ctx.storage.stat(id)).toBeNull();
  });

  it('flags a ready file whose object vanished, and says so instead of 500', async () => {
    const c = app.mkCase();
    const up = await uploadFile(app, session, c.id, 'vanishing.bin', randomBytes(256));
    const item = await up.json() as { id: string };
    await app.ctx.storage.delete(item.id);

    const report = await runCleanup(cleanupDeps(), { ttlMs: 3600_000 });
    expect(report.missingFiles).toBe(1);
    expect(app.ctx.db.prepare('SELECT status FROM items WHERE id = ?').get(item.id)).toMatchObject({ status: 'missing' });

    const page = await (await fetch(`${app.base}/admin/cases/${c.id}`, { headers: { cookie: session.cookie } })).text();
    expect(page).toContain('missing from storage');
    const dl = await adminDownload(app, session, item.id);
    expect(dl.status).toBe(404);
  });

  it('purges expired recipient sessions and stale challenges', async () => {
    const c = app.mkCase();
    const link = app.mkLink(c.id);
    await unlock(app, link.url);
    app.ctx.db.prepare('UPDATE access_sessions SET expires_at = ? WHERE link_id = ?').run('2020-01-01T00:00:00.000Z', link.id);
    app.ctx.db.prepare('UPDATE challenges SET created_at = ? WHERE link_id = ?').run('2020-01-01T00:00:00.000Z', link.id);

    const report = await runCleanup(cleanupDeps(), { ttlMs: 3600_000, verifyFiles: false });
    expect(report.accessSessions).toBeGreaterThanOrEqual(1);
    expect(report.challenges).toBeGreaterThanOrEqual(1);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM access_sessions WHERE link_id = ?').get(link.id)).toMatchObject({ n: 0 });
  });

  it('leaves a file alone when storage cannot say whether it is there', async () => {
    const c = app.mkCase();
    const up = await uploadFile(app, session, c.id, 'unknown.bin', randomBytes(64));
    const item = await up.json() as { id: string };
    vi.spyOn(app.ctx.storage, 'stat').mockRejectedValue(new Error('backend down'));
    const report = await runCleanup(cleanupDeps(), { ttlMs: 3600_000 });
    expect(report.missingFiles).toBe(0);
    expect(app.ctx.db.prepare('SELECT status FROM items WHERE id = ?').get(item.id)).toMatchObject({ status: 'ready' });
  });

  it('has nothing to discard for a note', async () => {
    const c = app.mkCase();
    const note = app.mkNote(c.id);
    app.ctx.db.prepare(`UPDATE items SET status = 'uploading', created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(note.id);
    const report = await runCleanup(cleanupDeps(), { ttlMs: 0, verifyFiles: false });
    expect(report.staleUploads).toBeGreaterThanOrEqual(1);
    expect(app.ctx.db.prepare('SELECT status FROM items WHERE id = ?').get(note.id)).toMatchObject({ status: 'expired' });
  });

  it('survives a storage backend that cannot sweep orphans', async () => {
    vi.spyOn(app.ctx.storage, 'cleanupOrphans').mockRejectedValue(new Error('bucket unreachable'));
    const report = await runCleanup(cleanupDeps(), { ttlMs: 3600_000, verifyFiles: false });
    expect(report.orphans).toBe(0);
  });

  it('removes only artefacts in the application key format', async () => {
    if (USE_S3) return;
    const { writeFileSync, existsSync } = await import('node:fs');
    const stranger = app.fileOnDisk('not-ours.txt');
    writeFileSync(stranger, 'someone else put this here');
    await runCleanup(cleanupDeps(), { ttlMs: 0, verifyFiles: false });
    expect(existsSync(stranger)).toBe(true);
  });
});

describe('failure paths', () => {
  it('answers a storage error with a plain 500 page, no internals', async () => {
    const c = app.mkCase();
    const up = await uploadFile(app, session, c.id, 'ok.bin', randomBytes(128));
    const item = await up.json() as { id: string };
    vi.spyOn(app.ctx.storage, 'get').mockRejectedValue(new Error('EIO: /srv/outletbox/data/files exploded'));

    const res = await adminDownload(app, session, item.id);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('An unexpected error occurred');
    expect(body).not.toContain('/srv/outletbox');
    expect(body).not.toContain('EIO');
  });

  it('shows the recipient a neutral page when their file is gone', async () => {
    const c = app.mkCase();
    const up = await uploadFile(app, session, c.id, 'gone.bin', randomBytes(128));
    const item = await up.json() as { id: string };
    const link = app.mkLink(c.id);
    const v = await unlock(app, link.url);
    await app.ctx.storage.delete(item.id);
    const res = await v.get(`${pathOf(link.url)}/files/${item.id}`);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('does not exist or is not available');
  });

  it('cleans up when the uploader disappears mid-stream', async () => {
    const c = app.mkCase();
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) { ctrl.enqueue(randomBytes(1024)); }, // and then nothing: the client hangs, then goes away
    });
    const request = fetch(`${app.base}/admin/api/cases/${c.id}/upload/torn.bin`, {
      method: 'PUT',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/octet-stream' },
      body,
      signal: controller.signal,
      // @ts-expect-error undici option
      duplex: 'half',
    });
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    await request.catch(() => undefined);

    // The server notices the torn connection and writes the item off.
    for (let i = 0; i < 40; i++) {
      const row = app.ctx.db.prepare(`SELECT status FROM items WHERE case_id = ? ORDER BY created_at DESC LIMIT 1`).get(c.id) as { status: string } | undefined;
      if (row?.status === 'aborted') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(app.ctx.db.prepare(`SELECT status FROM items WHERE case_id = ?`).get(c.id)).toMatchObject({ status: 'aborted' });
    expect(app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE case_id = ? AND status = 'ready'`).get(c.id)).toMatchObject({ n: 0 });
  });

  it('shrugs off a recipient who cancels a download', async () => {
    const c = app.mkCase();
    const up = await uploadFile(app, session, c.id, 'large.bin', randomBytes(2_000_000));
    const item = await up.json() as { id: string };
    const link = app.mkLink(c.id);
    const v = await unlock(app, link.url);

    const controller = new AbortController();
    const res = await v.get(`${pathOf(link.url)}/files/${item.id}`, { signal: controller.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => undefined);

    // The next request is served normally: nothing was left broken behind.
    const again = await v.get(`${pathOf(link.url)}/files/${item.id}`);
    expect(again.status).toBe(200);
    await again.arrayBuffer();
  });

  it('serves 404 pages for unknown paths without leaking the route', async () => {
    const res = await fetch(`${app.base}/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('This page does not exist');
    const admin = await fetch(`${app.base}/admin/nope`, { headers: { cookie: session.cookie } });
    expect(admin.status).toBe(404);
  });

  it('refuses malformed ids everywhere they are accepted', async () => {
    expect((await adminDownload(app, session, '../../etc/passwd')).status).toBe(404);
    expect((await adminPost(app, session, '/admin/items/not-an-id/delete')).status).toBe(404);
    expect((await adminPost(app, session, '/admin/links/not-an-id/revoke')).status).toBe(404);
    const missingCase = await fetch(`${app.base}/admin/cases/c_zzzzzzzzzzzzzzzz`, { headers: { cookie: session.cookie } });
    expect(missingCase.status).toBe(404);
  });

  it('validates storage keys', () => {
    expect(() => assertValidKey('f_abc-DEF_123')).not.toThrow();
    for (const bad of ['../escape', 'a/b', '', 'x'.repeat(200), 'nul\0']) expect(() => assertValidKey(bad)).toThrow();
  });

  it('aborts an unfinished upload when the item is deleted', async () => {
    const c = app.mkCase();
    const created = await tusCreate(app, session, c.id, 100_000, 'partial.bin');
    const id = created.headers.get('location')!.split('/').pop()!;
    await tusPatch(app, session, created.headers.get('location')!, 0, randomBytes(10_000));
    const res = await adminPost(app, session, `/admin/items/${id}/delete`);
    expect(res.status).toBe(303);
    expect(app.ctx.db.prepare('SELECT status FROM items WHERE id = ?').get(id)).toMatchObject({ status: 'aborted' });
    expect(await app.ctx.storage.stat(id)).toBeNull();
  });

  it('keeps working when the mail driver is broken, and says so', async () => {
    const c = app.mkCase();
    const link = app.mkLink(c.id);
    vi.spyOn(app.ctx.mailer, 'send').mockRejectedValue(new Error('relay refused'));
    const v = new Visitor(app.base);
    const p = pathOf(link.url);
    await v.getPage(p);
    const res = await v.post(`${p}/email`, { email: 'jan.kowalski@example.com' });
    expect(res.res.status).toBe(502);
    expect(res.body).toContain('could not be sent');
    expect(res.body).not.toContain('relay refused');
  });
});
