import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate, openDatabase, type Db } from '../src/db.js';
import { LimitHashStream } from '../src/storage/limit.js';
import { LocalStorage } from '../src/storage/local.js';
import { StorageLimitError, StorageNotFoundError } from '../src/storage/types.js';
import { createCase, listCases, updateCase } from '../src/services/cases.js';
import { createNote, LimitError, markDeleted, markMissing, startUpload, completeUpload, failUpload, listItemsForRecipient } from '../src/services/items.js';
import { createLink, emailMatches, linkState, openingsLeft, registerOpen, rotateLinkToken } from '../src/services/links.js';

let dir: string;
let storage: LocalStorage;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outletbox-storage-'));
  storage = new LocalStorage(path.join(dir, 'files'));
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const stream = (data: Buffer) => Readable.from([data]);

describe('local storage', () => {
  it('stores, reads back and deletes an object', async () => {
    const body = Buffer.from('some bytes');
    const put = await storage.put('f_one', stream(body), { maxBytes: 1024 });
    expect(put.size).toBe(body.length);
    expect(put.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await storage.stat('f_one')).toEqual({ size: body.length });

    const chunks: Buffer[] = [];
    for await (const chunk of await storage.get('f_one')) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(body)).toBe(true);

    await storage.delete('f_one');
    expect(await storage.stat('f_one')).toBeNull();
    await storage.delete('f_one'); // idempotent
    await expect(storage.get('f_one')).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it('never overwrites an existing key and never leaves half a file behind', async () => {
    await storage.put('f_two', stream(Buffer.from('first')), { maxBytes: 1024 });
    await expect(storage.put('f_two', stream(Buffer.from('second')), { maxBytes: 1024 })).rejects.toThrow();
    await expect(storage.put('f_three', stream(Buffer.alloc(100)), { maxBytes: 10 })).rejects.toBeInstanceOf(StorageLimitError);
    expect(await storage.stat('f_three')).toBeNull();
  });

  it('refuses keys that try to leave the directory', async () => {
    for (const key of ['../escape', 'a/b', 'a\\b', '']) {
      await expect(storage.put(key, stream(Buffer.from('x')), { maxBytes: 10 })).rejects.toThrow(/invalid storage key/);
    }
  });

  it('sweeps its own leftovers but leaves anything else alone', async () => {
    // Only the application's own key format (f_ + 16 chars) is ever touched.
    const live = 'f_aaaaaaaaaaaaaaaa';
    const dead = 'f_bbbbbbbbbbbbbbbb';
    await storage.put(live, stream(Buffer.from('keep me')), { maxBytes: 1024 });
    await storage.put(dead, stream(Buffer.from('sweep me')), { maxBytes: 1024 });
    fs.writeFileSync(path.join(dir, 'files', `${dead}.json`), '{}');
    fs.writeFileSync(path.join(dir, 'files', 'notes.txt'), 'not ours');
    // Backdate everything: the sweep only touches artefacts older than the TTL.
    const past = new Date(Date.now() - 86_400_000);
    for (const f of fs.readdirSync(path.join(dir, 'files'))) fs.utimesSync(path.join(dir, 'files', f), past, past);

    const { removed } = await storage.cleanupOrphans({ olderThanMs: 3600_000, isLive: (key) => key === live });
    expect(removed).toBe(2); // the object and its sidecar
    expect(await storage.stat(live)).not.toBeNull();
    expect(await storage.stat(dead)).toBeNull();
    expect(fs.existsSync(path.join(dir, 'files', 'notes.txt'))).toBe(true);
  });

  it('passes its health check', async () => {
    await expect(storage.healthCheck()).resolves.toBeUndefined();
  });
});

describe('limit stream', () => {
  it('counts and hashes until the cap is hit', async () => {
    const limiter = new LimitHashStream(10);
    const out: Buffer[] = [];
    limiter.on('data', (c: Buffer) => out.push(c));
    limiter.write(Buffer.alloc(5));
    expect(limiter.size).toBe(5);
    await new Promise<void>((resolve) => {
      limiter.on('error', (err) => { expect(err).toBeInstanceOf(StorageLimitError); resolve(); });
      limiter.write(Buffer.alloc(20));
    });
  });
});

describe('services', () => {
  let db: Db;
  const cfg = loadConfig({ PUBLIC_URL: 'https://out.example.com', MAX_FILE_SIZE: '1MB' } as NodeJS.ProcessEnv);

  beforeAll(() => { db = openDatabase(':memory:'); migrate(db); });

  it('validates case names', () => {
    expect(() => createCase(db, { name: '' })).toThrow(/1-200/);
    expect(() => createCase(db, { name: 'x'.repeat(201) })).toThrow(/1-200/);
    const c = createCase(db, { name: 'Valid', description: 'd' });
    expect(updateCase(db, c.id, { status: 'closed' })!.status).toBe('closed');
    expect(() => updateCase(db, c.id, { status: 'weird' as 'open' })).toThrow(/Invalid status/);
    expect(updateCase(db, 'c_nope', { name: 'x' })).toBeNull();
    expect(listCases(db).some((row) => row.id === c.id)).toBe(true);
  });

  it('validates notes and file sizes', () => {
    const c = createCase(db, { name: 'Items' });
    expect(() => createNote(db, { caseId: c.id, title: '', body: 'x' })).toThrow();
    expect(() => createNote(db, { caseId: c.id, title: 'x', body: '   ' })).toThrow();
    const note = createNote(db, { caseId: c.id, title: 'Note', body: 'Body' });

    expect(() => startUpload(db, cfg, { caseId: c.id, originalName: 'big', uploadKind: 'direct', declaredSize: 2 * 1024 * 1024 }))
      .toThrow(LimitError);
    expect(() => startUpload(db, cfg, { caseId: c.id, originalName: 'weird', uploadKind: 'direct', declaredSize: -1 }))
      .toThrow(/invalid declared size/);

    const { item } = startUpload(db, cfg, { caseId: c.id, originalName: 'ok.bin', uploadKind: 'direct', declaredSize: 10 });
    expect(completeUpload(db, item.id, 10, 'abc')).toBe(true);
    expect(completeUpload(db, item.id, 10)).toBe(false); // idempotent
    expect(failUpload(db, item.id, 'aborted')).toBe(false); // already finished

    expect(listItemsForRecipient(db, c.id).map((i) => i.id)).toEqual([note.id, item.id]);
    markMissing(db, item.id);
    expect(markDeleted(db, item.id)).toBe(true);
    expect(markDeleted(db, item.id)).toBe(false);
    expect(listItemsForRecipient(db, c.id).map((i) => i.id)).toEqual([note.id]);
  });

  it('validates links and counts openings', () => {
    const c = createCase(db, { name: 'Links' });
    expect(() => createLink(db, cfg, { caseId: c.id, label: 'x', recipientEmail: 'nope' })).toThrow(/valid recipient e-mail/);
    expect(() => createLink(db, cfg, { caseId: c.id, label: 'x', recipientEmail: 'a@b.test', maxOpens: 0 })).toThrow(/positive integer/);
    expect(() => createLink(db, cfg, { caseId: c.id, label: 'x', recipientEmail: 'a@b.test', expiresAt: new Date(Date.now() - 1000) })).toThrow(/future/);
    expect(() => createLink(db, 'c_missing' as unknown as typeof cfg extends never ? never : string extends string ? string : never, { caseId: 'c_missing', label: 'x', recipientEmail: 'a@b.test' } as never)).toThrow();

    const { link, url } = createLink(db, cfg, { caseId: c.id, label: '', recipientEmail: ' A@B.test ', maxOpens: 2 });
    expect(link.recipient_email).toBe('a@b.test');
    expect(link.label).toBe('Recipient');
    expect(url.startsWith('https://out.example.com/d/')).toBe(true);
    expect(emailMatches(link, 'a@B.TEST')).toBe(true);
    expect(emailMatches(link, 'other@b.test')).toBe(false);
    expect(openingsLeft(link)).toBe(2);

    expect(registerOpen(db, link.id)).toBe(true);
    expect(registerOpen(db, link.id)).toBe(true);
    expect(registerOpen(db, link.id)).toBe(false); // the limit holds
    const reloaded = { ...link, opens_used: 2 };
    expect(linkState(reloaded, createCase(db, { name: 'open case' }))).toBe('exhausted');
    expect(linkState({ ...link, revoked_at: '2020-01-01T00:00:00.000Z' }, { ...createCase(db, { name: 'x' }) })).toBe('revoked');
    expect(rotateLinkToken(db, cfg, 'l_missing000000000')).toBeNull();
    const rotated = rotateLinkToken(db, cfg, link.id)!;
    expect(rotated.url).not.toBe(url);
  });
});
