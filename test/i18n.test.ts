import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, pathOf, RECIPIENT, Visitor, type TestApp } from './helpers.js';
import { dateLocale, LANG_NAMES, LANGS, t, type MessageKey } from '../src/i18n.js';
import { en } from '../src/locales/en.js';

let app: TestApp;

beforeAll(async () => { app = await boot(); });
afterAll(async () => { await app.close(); });

describe('dictionaries', () => {
  it('offers the 24 official EU languages, each named in itself', () => {
    expect(LANGS).toHaveLength(24);
    expect(new Set(Object.keys(LANG_NAMES))).toEqual(new Set(LANGS));
    expect(LANG_NAMES.el).toBe('Ελληνικά');
  });

  // Every dictionary is typed as Messages, so a missing key is a compile error. What
  // the types cannot see is a translation that drops or renames a {placeholder} — the
  // code e-mail would then say "{code}" instead of the code — or English pasted over.
  it('keeps every placeholder in every translation, and translates most of the text', () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    const keys = Object.keys(en) as MessageKey[];
    for (const lang of LANGS) {
      let same = 0;
      for (const key of keys) {
        const msg = t(lang, key);
        expect(msg, `${lang} ${key}`).not.toBe('');
        expect(placeholders(msg), `${lang} ${key}`).toBe(placeholders(en[key]));
        if (msg === en[key]) same++;
      }
      // Some strings are legitimately identical (IP, "—", the product name, e.g. 500MB).
      if (lang !== 'en') expect(same / keys.length, lang).toBeLessThan(0.1);
    }
  });

  it('formats dates in every language with the runtime ICU data (full-icu in the image)', () => {
    expect(dateLocale('en')).toBe('en-GB');
    expect(Intl.DateTimeFormat.supportedLocalesOf(LANGS.map(dateLocale))).toHaveLength(LANGS.length);
  });
});

describe('negotiation in the browser', () => {
  it('answers a browser in its first language, and in English when we do not have that one', async () => {
    const pl = await (await fetch(`${app.base}/admin/login`, { headers: { 'accept-language': 'pl-PL,pl;q=0.9' } })).text();
    expect(pl).toContain('Logowanie administratora');
    const de = await (await fetch(`${app.base}/admin/login`, { headers: { 'accept-language': 'de-DE,de;q=0.9,pl;q=0.5' } })).text();
    expect(de).toContain('Administrator-Anmeldung');
    const ja = await (await fetch(`${app.base}/admin/login`, { headers: { 'accept-language': 'ja,pl;q=0.5' } })).text();
    expect(ja).toContain('Administrator login');
  });

  it('shows the delivery in the language the link was issued in, whatever the browser asks for', async () => {
    const link = app.mkLink(app.mkCase().id, { lang: 'pl' });
    const p = pathOf(link.url);
    const de = await (await fetch(`${app.base}${p}`, { headers: { 'accept-language': 'de-DE,de;q=0.9' } })).text();
    expect(de).toContain('Potwierdź swój adres e-mail');
  });

  it('lets the recipient override that language with the switcher', async () => {
    const link = app.mkLink(app.mkCase().id, { lang: 'pl' });
    const chosen = await fetch(`${app.base}/lang/en`, { redirect: 'manual' });
    const cookie = chosen.headers.get('set-cookie')!.split(';')[0]!;
    const page = await (await fetch(`${app.base}${pathOf(link.url)}`, { headers: { cookie, 'accept-language': 'pl-PL,pl' } })).text();
    expect(page).toContain('Confirm your e-mail address');
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

  it('sends the code e-mail in the language the link was issued in, not the browser\'s', async () => {
    const link = app.mkLink(app.mkCase('Sprawa PL').id, { lang: 'pl' });
    const p = pathOf(link.url);
    const v = new Visitor(app.base);
    await v.getPage(p);
    const res = await fetch(`${app.base}${p}/email`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: v.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded', origin: app.base, 'accept-language': 'en-GB,en' },
      body: new URLSearchParams({ _flow: v.flowToken(), email: RECIPIENT }),
    });
    expect(res.status).toBe(200);
    expect(app.mailer.recent()[0]!.subject).toMatch(/^Kod dostępu: \d{6}$/);
  });

  it('addresses a recipient in any of the languages, not only the original two', async () => {
    const link = app.mkLink(app.mkCase('Vorgang DE').id, { lang: 'de' });
    const p = pathOf(link.url);
    const v = new Visitor(app.base);
    const { body } = await v.getPage(p);
    expect(body).toContain('<html lang="de">');
    expect(body).toContain('Bestätigen Sie Ihre E-Mail-Adresse');
    const res = await fetch(`${app.base}${p}/email`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: v.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded', origin: app.base, 'accept-language': 'en-GB,en' },
      body: new URLSearchParams({ _flow: v.flowToken(), email: RECIPIENT }),
    });
    expect(res.status).toBe(200);
    expect(app.mailer.recent()[0]!.subject).toMatch(/^Zugangscode: \d{6}$/);
  });

  it('keeps an English recipient on English even when the browser is Polish', async () => {
    const link = app.mkLink(app.mkCase('English case').id, { lang: 'en' });
    const p = pathOf(link.url);
    const v = new Visitor(app.base);
    await v.getPage(p);
    const res = await fetch(`${app.base}${p}/email`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: v.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded', origin: app.base, 'accept-language': 'pl-PL,pl' },
      body: new URLSearchParams({ _flow: v.flowToken(), email: RECIPIENT }),
    });
    expect(res.status).toBe(200);
    expect(app.mailer.recent()[0]!.subject).toMatch(/^Access code: \d{6}$/);
  });
});
