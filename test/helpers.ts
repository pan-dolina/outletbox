import { randomFillSync } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { startServer, type RunningServer } from '../src/server.js';
import type { LogMailer, RecordedMail } from '../src/mail/log.js';
import { createAdmin } from '../src/services/auth.js';
import { createCase } from '../src/services/cases.js';
import { createNote } from '../src/services/items.js';
import { createLink, type CreateLinkInput } from '../src/services/links.js';

export const USE_S3 = process.env.TEST_S3 === '1';
const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000';
const S3_KEY = process.env.TEST_S3_ACCESS_KEY ?? 'minioadmin';
const S3_SECRET = process.env.TEST_S3_SECRET_KEY ?? 'minioadmin';

export const ADMIN_USER = 'admin';
export const ADMIN_PASS = 'correct-horse-battery-staple';
export const RECIPIENT = 'jan.kowalski@example.com';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export interface AdminSession { cookie: string; csrf: string }

export interface TestApp extends RunningServer {
  base: string;
  dataDir: string;
  /** The "log" driver, which keeps every message it was asked to send. */
  mailer: LogMailer;
  adminLogin(): Promise<AdminSession>;
  mkCase(name?: string): { id: string; name: string };
  mkNote(caseId: string, title?: string, body?: string): { id: string };
  mkLink(caseId: string, opts?: Partial<CreateLinkInput>): { id: string; token: string; url: string };
  fileOnDisk(id: string): string;
}

export async function boot(env: Record<string, string> = {}): Promise<TestApp> {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outletbox-test-'));
  const base = `http://127.0.0.1:${port}`;
  let bucket = '';
  let s3: S3Client | undefined;
  const fullEnv: Record<string, string> = {
    PUBLIC_URL: base, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
    STORAGE_BACKEND: 'local', MAX_FILE_SIZE: '50MB', UPLOAD_CHUNK_SIZE: '1MB',
    CLEANUP_INTERVAL_MINUTES: '0', LOG_LEVEL: 'error', COOKIE_SECURE: 'false',
    MAIL_DRIVER: 'log', MAIL_FROM: 'outletbox@example.com',
    LOGIN_RATE_LIMIT_PER_15MIN: '10', TOKEN_FAILURE_RATE_LIMIT_PER_15MIN: '1000', PUBLIC_RATE_LIMIT_PER_MINUTE: '100000',
    ...env,
  };
  if (USE_S3) {
    bucket = `outletbox-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    s3 = new S3Client({ region: 'us-east-1', endpoint: S3_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: S3_KEY, secretAccessKey: S3_SECRET } });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    Object.assign(fullEnv, {
      STORAGE_BACKEND: 's3', S3_ENDPOINT, S3_REGION: 'us-east-1', S3_BUCKET: bucket, S3_ACCESS_KEY_ID: S3_KEY, S3_SECRET_ACCESS_KEY: S3_SECRET,
      S3_FORCE_PATH_STYLE: 'true', S3_PART_SIZE: '5MB',
    });
  }
  const running = await startServer(fullEnv, { host: '127.0.0.1', port });
  createAdmin(running.ctx.db, ADMIN_USER, ADMIN_PASS);

  const app: TestApp = {
    ...running,
    base,
    dataDir,
    mailer: running.ctx.mailer as LogMailer,
    close: async () => {
      await running.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
      if (s3 && bucket) {
        let token: string | undefined;
        do {
          const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
          for (const o of res.Contents ?? []) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key! }));
          token = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (token);
        await s3.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
      }
    },
    async adminLogin() {
      const res = await fetch(`${base}/admin/login`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
      });
      if (res.status !== 303) throw new Error(`login failed: ${res.status}`);
      const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
      const page = await fetch(`${base}/admin`, { headers: { cookie } });
      const csrf = /name="_csrf" value="([^"]+)"/.exec(await page.text())![1]!;
      return { cookie, csrf };
    },
    mkCase(name = 'Test delivery') {
      const c = createCase(running.ctx.db, { name });
      return { id: c.id, name: c.name };
    },
    mkNote(caseId, title = 'Note title', body = 'Note body') {
      return { id: createNote(running.ctx.db, { caseId, title, body }).id };
    },
    mkLink(caseId, opts = {}) {
      const { link, token, url } = createLink(running.ctx.db, running.ctx.cfg, { caseId, label: 'Recipient', recipientEmail: RECIPIENT, ...opts });
      return { id: link.id, token, url };
    },
    fileOnDisk: (id) => path.join(running.ctx.cfg.localStorageDir, id),
  };
  return app;
}

// ---------------------------------------------------------------------------
// Admin helpers
// ---------------------------------------------------------------------------

export async function adminPost(app: TestApp, session: AdminSession, urlPath: string, fields: Record<string, string> = {}): Promise<Response> {
  return fetch(`${app.base}${urlPath}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: session.csrf, ...fields }),
  });
}

/** Streaming upload as an administrator ("curl -T" style). */
export async function uploadFile(app: TestApp, session: AdminSession, caseId: string, name: string, body: Buffer | Uint8Array): Promise<Response> {
  return fetch(`${app.base}/admin/api/cases/${caseId}/upload/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/octet-stream' },
    body,
  });
}

export async function adminDownload(app: TestApp, session: AdminSession, itemId: string): Promise<Response> {
  return fetch(`${app.base}/admin/items/${itemId}/download`, { headers: { cookie: session.cookie }, redirect: 'manual' });
}

// ---------------------------------------------------------------------------
// Recipient helpers: a minimal cookie jar over fetch
// ---------------------------------------------------------------------------

export class Visitor {
  private readonly jar = new Map<string, string>();
  lastBody = '';

  constructor(private readonly base: string) {}

  private absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const idx = pair!.indexOf('=');
      const name = pair!.slice(0, idx);
      const value = pair!.slice(idx + 1);
      if (value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  has(cookieName: string): boolean {
    return this.jar.has(cookieName);
  }

  async get(urlPath: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.base}${urlPath}`, { ...init, redirect: 'manual', headers: { cookie: this.cookieHeader(), ...(init.headers ?? {}) } });
    this.absorb(res);
    return res;
  }

  async getPage(urlPath: string): Promise<{ res: Response; body: string }> {
    const res = await this.get(urlPath);
    this.lastBody = await res.text();
    return { res, body: this.lastBody };
  }

  async post(urlPath: string, fields: Record<string, string>): Promise<{ res: Response; body: string }> {
    const res = await fetch(`${this.base}${urlPath}`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: this.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded', origin: this.base },
      body: new URLSearchParams({ _flow: this.flowToken(), ...fields }),
    });
    this.absorb(res);
    this.lastBody = await res.text();
    return { res, body: this.lastBody };
  }

  /** The double-submit token from the page currently loaded. */
  flowToken(): string {
    return /name="_flow" value="([^"]+)"/.exec(this.lastBody)?.[1] ?? '';
  }
}

export function pathOf(url: string): string {
  return new URL(url).pathname;
}

/** The six digits out of the most recent message in the log mailer. */
export function lastCode(app: TestApp): string {
  const mail = app.mailer.recent()[0];
  if (!mail) throw new Error('no mail was sent');
  const m = /\b(\d{6})\b/.exec(mail.subject) ?? /\b(\d{6})\b/.exec(mail.text);
  if (!m) throw new Error(`no code in: ${mail.subject}`);
  return m[1]!;
}

export function mailsTo(app: TestApp, to: string): RecordedMail[] {
  return app.mailer.recent().filter((m) => m.to === to);
}

/** Walks a visitor all the way through address → code → unlocked page. */
export async function unlock(app: TestApp, url: string, email = RECIPIENT): Promise<Visitor> {
  const v = new Visitor(app.base);
  const p = pathOf(url);
  await v.getPage(p);
  await v.post(`${p}/email`, { email });
  await v.post(`${p}/code`, { code: lastCode(app) });
  await v.getPage(p);
  return v;
}

export function randomBytes(n: number): Buffer {
  return randomFillSync(Buffer.alloc(n));
}

export const TUS_HEADERS = { 'tus-resumable': '1.0.0' };

export function b64(s: string): string { return Buffer.from(s, 'utf8').toString('base64'); }

export async function tusCreate(app: TestApp, session: AdminSession, caseId: string, size: number, filename: string): Promise<Response> {
  return fetch(`${app.base}/admin/api/tus`, {
    method: 'POST',
    headers: {
      cookie: session.cookie, 'x-csrf-token': session.csrf, ...TUS_HEADERS,
      'upload-length': String(size), 'upload-metadata': `filename ${b64(filename)},caseId ${b64(caseId)}`,
    },
  });
}

export async function tusPatch(app: TestApp, session: AdminSession, location: string, offset: number, data: Uint8Array): Promise<Response> {
  return fetch(`${app.base}${location}`, {
    method: 'PATCH',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, ...TUS_HEADERS, 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' },
    body: data,
  });
}

export async function tusHead(app: TestApp, session: AdminSession, location: string): Promise<Response> {
  return fetch(`${app.base}${location}`, { method: 'HEAD', headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, ...TUS_HEADERS } });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
