import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createMailer, formatFrom, MailError } from '../src/mail/index.js';
import { LogMailer } from '../src/mail/log.js';
import { accessCodeMail } from '../src/mail/templates.js';
import * as templates from '../src/mail/templates.js';
import { setLogLevel } from '../src/log.js';

setLogLevel('error');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'outletbox-mail-'));
const BASE_ENV = { PUBLIC_URL: 'http://localhost:3000', DATA_DIR: TMP, LOG_LEVEL: 'error' };

function cfgFor(env: Record<string, string>) {
  return loadConfig({ ...BASE_ENV, ...env } as NodeJS.ProcessEnv);
}

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

// ---------------------------------------------------------------------------
// A throwaway SMTP server: enough of RFC 5321 for nodemailer to deliver once.
// ---------------------------------------------------------------------------
interface FakeSmtp { port: number; messages: string[]; authSeen: string[] }

async function fakeSmtp(): Promise<FakeSmtp> {
  const messages: string[] = [];
  const authSeen: string[] = [];
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = '';
    socket.write('220 fake.test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === '.') { inData = false; socket.write('250 2.0.0 queued\r\n'); }
          else messages[messages.length - 1] += line + '\n';
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) socket.write('250-fake.test\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (upper.startsWith('AUTH')) { authSeen.push(line); socket.write('235 2.7.0 accepted\r\n'); }
        else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) socket.write('250 2.1.0 ok\r\n');
        else if (upper === 'DATA') { inData = true; messages.push(''); socket.write('354 go ahead\r\n'); }
        else if (upper === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  return { port: (server.address() as net.AddressInfo).port, messages, authSeen };
}

/** A throwaway HTTP server used as Entra ID / Graph / SES. */
async function fakeHttp(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push(`${req.method} ${req.url}`);
      handler(req, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  return { port: (server.address() as net.AddressInfo).port, hits };
}

describe('templates', () => {
  it('puts the code in the subject and never the link', () => {
    const mail = accessCodeMail({ lang: 'en', to: 'a@example.com', brand: 'Acme', caseName: 'Report', code: '123456', ttlMinutes: 15 });
    expect(mail.subject).toBe('Access code: 123456');
    expect(mail.text).toContain('123456');
    expect(mail.text).toContain('15 minutes');
    expect(mail.text).not.toContain('/d/');
    expect(mail.html).toContain('123456');
  });

  it('translates to Polish', () => {
    const mail = accessCodeMail({ lang: 'pl', to: 'a@example.com', brand: 'Acme', caseName: 'Raport', code: '123456', ttlMinutes: 10 });
    expect(mail.subject).toBe('Kod dostępu: 123456');
    expect(mail.text).toContain('jednorazowy kod: 123456');
  });

  it('refuses a subject with a header injection attempt', () => {
    expect(() => accessCodeMail({ lang: 'en', to: 'a@example.com', brand: 'Acme', caseName: 'x', code: '1\r\nBcc: victim@example.com', ttlMinutes: 15 }))
      .toThrow(MailError);
  });

  it('escapes a hostile case name in the HTML part', () => {
    const mail = accessCodeMail({ lang: 'en', to: 'a@example.com', brand: 'Acme', caseName: '<script>alert(1)</script>', code: '123456', ttlMinutes: 15 });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('is the only message the application can send', () => {
    // The delivery link is handed over by an administrator, never mailed, so
    // there is no second template to keep in step.
    expect(Object.keys(templates).filter((k) => k.endsWith('Mail'))).toEqual(['accessCodeMail']);
  });

  it('quotes a display name that needs it', () => {
    expect(formatFrom('a@b.test', 'Acme Ltd')).toBe('Acme Ltd <a@b.test>');
    expect(formatFrom('a@b.test', 'Acme, Ltd.')).toBe('"Acme, Ltd." <a@b.test>');
    expect(formatFrom('a@b.test', 'Bad\r\nName')).toBe('BadName <a@b.test>');
    expect(formatFrom('a@b.test', '')).toBe('a@b.test');
  });
});

describe('log driver', () => {
  it('keeps messages instead of sending them and spools them to disk', async () => {
    const cfg = cfgFor({});
    const mailer = createMailer(cfg);
    expect(mailer).toBeInstanceOf(LogMailer);
    await mailer.verify();
    await mailer.send({ to: 'a@example.com', subject: 'Hello', text: 'Body' });
    const recorded = (mailer as LogMailer).recent();
    expect(recorded[0]).toMatchObject({ to: 'a@example.com', subject: 'Hello' });
    const spooled = fs.readdirSync(path.join(TMP, 'mail'));
    expect(spooled.length).toBe(1);
    expect(fs.readFileSync(path.join(TMP, 'mail', spooled[0]!), 'utf8')).toContain('Subject: Hello');
    await mailer.close();
  });
});

describe('log driver spool', () => {
  it('keeps working when the spool directory cannot be created', async () => {
    const blocked = path.join(TMP, 'blocked');
    fs.writeFileSync(blocked, 'this is a file, not a directory');
    const mailer = new LogMailer('from@example.com', path.join(blocked, 'mail'));
    await expect(mailer.send({ to: 'a@example.com', subject: 's', text: 't' })).resolves.toBeUndefined();
    expect(mailer.recent()).toHaveLength(1);
  });

  it('keeps only the newest messages', async () => {
    const mailer = new LogMailer('from@example.com', undefined, 2);
    for (const n of ['1', '2', '3']) await mailer.send({ to: 'a@example.com', subject: n, text: n });
    expect(mailer.recent().map((m) => m.subject)).toEqual(['3', '2']);
  });
});

describe('SMTP driver', () => {
  it('delivers through a plain relay with AUTH', async () => {
    const smtp = await fakeSmtp();
    const cfg = cfgFor({
      MAIL_DRIVER: 'smtp', MAIL_FROM: 'sender@example.com', MAIL_FROM_NAME: 'Acme',
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false',
      SMTP_USER: 'user', SMTP_PASSWORD: 'pass',
    });
    const mailer = createMailer(cfg);
    await mailer.verify();
    await mailer.send({ to: 'rcpt@example.com', subject: 'Access code: 123456', text: 'Your one-time code: 123456' });
    await mailer.close();

    expect(smtp.authSeen.length).toBeGreaterThan(0);
    const message = smtp.messages.at(-1)!;
    expect(message).toContain('To: rcpt@example.com');
    expect(message).toContain('From: Acme <sender@example.com>');
    expect(message).toMatch(/Subject: .*(123456|=\?UTF-8)/);
  });

  it('reports an unreachable relay instead of hanging', async () => {
    const cfg = cfgFor({ MAIL_DRIVER: 'smtp', MAIL_FROM: 'sender@example.com', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_REQUIRE_TLS: 'false' });
    const mailer = createMailer(cfg);
    await expect(mailer.send({ to: 'x@example.com', subject: 's', text: 't' })).rejects.toBeInstanceOf(MailError);
    await mailer.close();
  });

  it('insists on a password when a user is configured', () => {
    expect(() => cfgFor({ MAIL_DRIVER: 'smtp', MAIL_FROM: 'a@b.test', SMTP_HOST: 'relay', SMTP_USER: 'u' })).toThrow(/SMTP_PASSWORD/);
    expect(() => cfgFor({ MAIL_DRIVER: 'smtp', MAIL_FROM: 'a@b.test' })).toThrow(/SMTP_HOST/);
  });
});

describe('Microsoft Graph driver', () => {
  async function graphServer(opts: { tokenStatus?: number; sendStatus?: number } = {}) {
    const bodies: Array<Record<string, unknown>> = [];
    const server = await fakeHttp((req, body, res) => {
      if (req.url?.includes('/oauth2/v2.0/token')) {
        res.writeHead(opts.tokenStatus ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(opts.tokenStatus && opts.tokenStatus >= 400
          ? { error: 'invalid_client', error_description: 'AADSTS7000215: bad secret' }
          : { access_token: 'token-abc', expires_in: 3600 }));
        return;
      }
      bodies.push(JSON.parse(body || '{}'));
      res.writeHead(opts.sendStatus ?? 202).end();
    });
    return { ...server, bodies };
  }

  function graphCfg(port: number) {
    return cfgFor({
      MAIL_DRIVER: 'graph', MAIL_FROM: 'sender@example.com',
      GRAPH_TENANT_ID: 'tenant-id', GRAPH_CLIENT_ID: 'client-id', GRAPH_CLIENT_SECRET: 'secret',
      GRAPH_AUTHORITY: `http://127.0.0.1:${port}`, GRAPH_API_BASE: `http://127.0.0.1:${port}/v1.0`,
    });
  }

  it('fetches a token once and posts sendMail as the configured mailbox', async () => {
    const graph = await graphServer();
    const mailer = createMailer(graphCfg(graph.port));
    await mailer.send({ to: 'rcpt@example.com', subject: 'Access code: 111111', text: 'plain', html: '<p>rich</p>' });
    await mailer.send({ to: 'rcpt@example.com', subject: 'Access code: 222222', text: 'plain' });

    expect(graph.hits.filter((h) => h.includes('token')).length).toBe(1); // cached
    expect(graph.hits).toContain('POST /v1.0/users/sender%40example.com/sendMail');
    expect(graph.bodies[0]).toMatchObject({
      message: { subject: 'Access code: 111111', body: { contentType: 'HTML', content: '<p>rich</p>' }, toRecipients: [{ emailAddress: { address: 'rcpt@example.com' } }] },
      saveToSentItems: false,
    });
    await mailer.close();
  });

  it('honours a reply-to address and sends text-only when there is no HTML', async () => {
    const graph = await graphServer();
    const cfg = { ...graphCfg(graph.port) };
    cfg.mail.replyTo = 'office@example.com';
    const mailer = createMailer(cfg);
    await mailer.send({ to: 'rcpt@example.com', subject: 'plain only', text: 'just text' });
    expect(graph.bodies[0]).toMatchObject({
      message: { body: { contentType: 'Text', content: 'just text' }, replyTo: [{ emailAddress: { address: 'office@example.com' } }] },
    });
    await mailer.close();
  });

  it('surfaces a rejected client secret', async () => {
    const graph = await graphServer({ tokenStatus: 401 });
    const mailer = createMailer(graphCfg(graph.port));
    await expect(mailer.verify()).rejects.toThrow(/AADSTS7000215/);
    await mailer.close();
  });

  it('drops the cached token when Graph answers 403', async () => {
    const graph = await graphServer({ sendStatus: 403 });
    const mailer = createMailer(graphCfg(graph.port));
    await expect(mailer.send({ to: 'x@example.com', subject: 's', text: 't' })).rejects.toThrow(/HTTP 403/);
    await mailer.send({ to: 'x@example.com', subject: 's', text: 't' }).catch(() => undefined);
    expect(graph.hits.filter((h) => h.includes('token')).length).toBe(2);
    await mailer.close();
  });

  it('demands the tenant credentials up front', () => {
    expect(() => cfgFor({ MAIL_DRIVER: 'graph', MAIL_FROM: 'a@b.test' })).toThrow(/GRAPH_TENANT_ID/);
  });
});

describe('Amazon SES driver', () => {
  it('sends through the SESv2 API', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const ses = await fakeHttp((_req, body, res) => {
      payloads.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ MessageId: 'msg-1' }));
    });
    const cfg = cfgFor({
      MAIL_DRIVER: 'ses', MAIL_FROM: 'sender@example.com', MAIL_FROM_NAME: 'Acme',
      SES_REGION: 'eu-central-1', SES_ENDPOINT: `http://127.0.0.1:${ses.port}`,
      SES_ACCESS_KEY_ID: 'AKIA-test', SES_SECRET_ACCESS_KEY: 'secret', SES_CONFIGURATION_SET: 'default',
    });
    const mailer = createMailer(cfg);
    await mailer.verify();
    await mailer.send({ to: 'rcpt@example.com', subject: 'Access code: 333333', text: 'plain', html: '<p>rich</p>' });
    await mailer.close();

    expect(payloads[0]).toMatchObject({
      FromEmailAddress: 'Acme <sender@example.com>',
      Destination: { ToAddresses: ['rcpt@example.com'] },
      ConfigurationSetName: 'default',
      Content: { Simple: { Subject: { Data: 'Access code: 333333' } } },
    });
  });

  it('sends without optional settings and without credentials of its own', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const ses = await fakeHttp((_req, body, res) => {
      payloads.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ MessageId: 'msg-2' }));
    });
    // No SES_* keys: the SDK falls back to its default credential chain, which
    // here means the ambient environment (an instance role in production).
    process.env.AWS_ACCESS_KEY_ID = 'AKIA-env';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret-env';
    try {
      const cfg = cfgFor({ MAIL_DRIVER: 'ses', MAIL_FROM: 'sender@example.com', SES_ENDPOINT: `http://127.0.0.1:${ses.port}` });
      const mailer = createMailer(cfg);
      await mailer.send({ to: 'rcpt@example.com', subject: 'no frills', text: 'text' });
      expect(payloads[0]).toMatchObject({ FromEmailAddress: 'outletbox <sender@example.com>' });
      expect(payloads[0]!.ConfigurationSetName).toBeUndefined();
      await mailer.close();
    } finally {
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }
  });

  it('wraps an API failure in a MailError', async () => {
    const ses = await fakeHttp((_req, _body, res) => {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Email address is not verified' }));
    });
    const cfg = cfgFor({
      MAIL_DRIVER: 'ses', MAIL_FROM: 'sender@example.com', SES_ENDPOINT: `http://127.0.0.1:${ses.port}`,
      SES_ACCESS_KEY_ID: 'AKIA-test', SES_SECRET_ACCESS_KEY: 'secret',
    });
    const mailer = createMailer(cfg);
    await expect(mailer.send({ to: 'x@example.com', subject: 's', text: 't' })).rejects.toBeInstanceOf(MailError);
    await mailer.close();
  });
});

describe('mail configuration', () => {
  it('requires a bare address in MAIL_FROM', () => {
    expect(() => cfgFor({ MAIL_DRIVER: 'smtp', MAIL_FROM: 'Acme <a@b.test>', SMTP_HOST: 'relay' })).toThrow(/bare e-mail address/);
    expect(() => cfgFor({ MAIL_DRIVER: 'smtp', SMTP_HOST: 'relay' })).toThrow(/MAIL_FROM is required/);
    expect(() => cfgFor({ MAIL_DRIVER: 'carrier-pigeon' })).toThrow(/MAIL_DRIVER/);
  });

  it('defaults to the log driver with no configuration at all', () => {
    const cfg = cfgFor({});
    expect(cfg.mail.driver).toBe('log');
    expect(createMailer(cfg).kind).toBe('log');
  });
});
