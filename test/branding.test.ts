import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, pathOf, RECIPIENT, Visitor, type TestApp } from './helpers.js';
import { clearLogoCache, LOGO_CONTENT_ID } from '../src/mail/logo.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');

let dir: string;
let app: TestApp;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outletbox-brand-'));
  fs.writeFileSync(path.join(dir, 'logo.png'), PNG);
  app = await boot({
    BRAND_NAME: 'Acme Secure', BRAND_LOGO_PATH: path.join(dir, 'logo.png'),
    BRAND_COLOR_PRIMARY: '#0f766e', BRAND_COLOR_TOPBAR: '#042f2e', BRAND_COLOR_ACCENT: '#14b8a6',
    BRAND_FOOTER_TEXT: 'Acme Secure · internal use only',
  });
});
afterAll(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('branding', () => {
  it('uses the operator name, logo and footer on recipient pages', async () => {
    const link = app.mkLink(app.mkCase().id);
    const page = await (await fetch(`${app.base}${pathOf(link.url)}`)).text();
    expect(page).toContain('Acme Secure');
    expect(page).toContain('<img class="brand-logo" src="/brand/logo"');
    expect(page).toContain('internal use only');
    expect(page).toContain('/brand/theme.css');
  });

  it('sends the code e-mail with the logo attached, not linked', async () => {
    clearLogoCache();
    const link = app.mkLink(app.mkCase('Brand delivery').id);
    const v = new Visitor(app.base);
    const p = pathOf(link.url);
    await v.getPage(p);
    await v.post(`${p}/email`, { email: RECIPIENT });

    const mail = app.mailer.recent()[0]!;
    expect(mail.inlineImages).toHaveLength(1);
    expect(mail.inlineImages![0]!.content.equals(PNG)).toBe(true);
    expect(mail.html).toContain(`src="cid:${LOGO_CONTENT_ID}"`);
    // Nothing is fetched from the instance, so opening the message is not reported back.
    expect(mail.html).not.toContain('/brand/logo');
    expect(mail.html).toContain('#042f2e');
    expect(mail.text).toContain('internal use only');
  });

  it('serves the colours as a stylesheet, so the CSP needs no unsafe-inline', async () => {
    const css = await (await fetch(`${app.base}/brand/theme.css`)).text();
    expect(css).toContain('--primary: #0f766e;');
    expect(css).toContain('--topbar: #042f2e;');
    expect(css).toContain('--accent: #14b8a6;');
  });

  it('serves the logo with a safe content type', async () => {
    const res = await fetch(`${app.base}/brand/logo`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('brands the one-time code e-mail too', async () => {
    const c = app.mkCase('Branded delivery');
    const link = app.mkLink(c.id, { recipientEmail: 'jan@example.com' });
    const v = new Visitor(app.base);
    const p = pathOf(link.url);
    await v.getPage(p);
    await v.post(`${p}/email`, { email: 'jan@example.com' });
    const mail = app.mailer.recent()[0]!;
    expect(mail.text).toContain('Acme Secure');
    expect(mail.subject).toMatch(/\d{6}/);
  });

  it('serves an SVG logo under a script-less policy', async () => {
    const svgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outletbox-svg-'));
    fs.writeFileSync(path.join(svgDir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    const svgApp = await boot({ BRAND_LOGO_PATH: path.join(svgDir, 'logo.svg') });
    try {
      const res = await fetch(`${svgApp.base}/brand/logo`);
      expect(res.headers.get('content-type')).toContain('image/svg+xml');
      expect(res.headers.get('content-security-policy')).toContain('sandbox');
    } finally {
      await svgApp.close();
      fs.rmSync(svgDir, { recursive: true, force: true });
    }
  });

  it('answers 404 when no logo is configured at all', async () => {
    const plain = await boot();
    try {
      expect((await fetch(`${plain.base}/brand/logo`)).status).toBe(404);
      const home = await (await fetch(`${plain.base}/`)).text();
      expect(home).toContain('outletbox');
      expect(home).not.toContain('brand-logo');
    } finally {
      await plain.close();
    }
  });

  it('answers 404 when the logo file disappears', async () => {
    fs.rmSync(path.join(dir, 'logo.png'));
    expect((await fetch(`${app.base}/brand/logo`)).status).toBe(404);
  });
});
