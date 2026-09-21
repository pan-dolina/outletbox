import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, pathOf, RECIPIENT, Visitor, type TestApp } from './helpers.js';
import { LANGS, t } from '../src/i18n.js';

let app: TestApp;

beforeAll(async () => { app = await boot(); });
afterAll(async () => { await app.close(); });

describe('dictionaries', () => {
  it('translates every key in both languages', () => {
    // The Polish dictionary is typed as Record<keyof typeof en, string>, so a
    // missing key is a compile error; this catches empty or copy-pasted values.
    const keys = ['deliver.email.title', 'deliver.code.title', 'items.title', 'links.title', 'mail.code.subject'] as const;
    for (const key of keys) {
      for (const lang of LANGS) expect(t(lang, key).length).toBeGreaterThan(3);
      expect(t('en', key)).not.toBe(t('pl', key));
    }
  });
});

describe('negotiation in the browser', () => {
  it('answers a Polish browser in Polish and everyone else in English', async () => {
    const link = app.mkLink(app.mkCase().id);
    const p = pathOf(link.url);
    const pl = await (await fetch(`${app.base}${p}`, { headers: { 'accept-language': 'pl-PL,pl;q=0.9' } })).text();
    expect(pl).toContain('Potwierdź swój adres e-mail');
    const de = await (await fetch(`${app.base}${p}`, { headers: { 'accept-language': 'de-DE,de;q=0.9,pl;q=0.5' } })).text();
    expect(de).toContain('Confirm your e-mail address');
  });

  it('remembers an explicit choice in a cookie', async () => {
    const res = await fetch(`${app.base}/lang/pl?next=/admin/login`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login');
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const page = await (await fetch(`${app.base}/admin/login`, { headers: { cookie, 'accept-language': 'en' } })).text();
    expect(page).toContain('Logowanie administratora');
    expect((await fetch(`${app.base}/lang/xx`)).status).toBe(404);
  });

  it('refuses to bounce the switcher off-site', async () => {
    const res = await fetch(`${app.base}/lang/en?next=https://evil.test`, { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/');
  });

  it('sends the code e-mail in the language the recipient is reading', async () => {
    const link = app.mkLink(app.mkCase('Sprawa PL').id);
    const p = pathOf(link.url);
    const v = new Visitor(app.base);
    await v.getPage(p);
    const res = await fetch(`${app.base}${p}/email`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: v.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded', origin: app.base, 'accept-language': 'pl-PL,pl' },
      body: new URLSearchParams({ _flow: v.flowToken(), email: RECIPIENT }),
    });
    expect(res.status).toBe(200);
    expect(app.mailer.recent()[0]!.subject).toMatch(/^Kod dostępu: \d{6}$/);
  });
});
