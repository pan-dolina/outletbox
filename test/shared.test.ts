import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db.js';
import { formatRecipients, parseRecipients, requireRecipients, RecipientListError } from '../src/services/addresses.js';
import { listAudit } from '../src/services/audit.js';
import { listGroups } from '../src/services/groups.js';
import { getLink, listLinksForCase, listRecipients } from '../src/services/links.js';
import { adminPost, boot, mailsTo, pathOf, Visitor, type TestApp } from './helpers.js';

const ANNA = 'anna.schmidt@example.com';
const PIOTR = 'piotr.nowak@example.com';
const MARY = 'mary.smith@example.com';

let app: TestApp;
let session: Awaited<ReturnType<TestApp['adminLogin']>>;

beforeAll(async () => {
  app = await boot();
  session = await app.adminLogin();
});
afterAll(async () => { await app.close(); });

/** The code in the newest message to this address — several people are mailed in these tests. */
function codeFor(email: string): string {
  const mail = mailsTo(app, email)[0];
  if (!mail) throw new Error(`nothing was mailed to ${email}`);
  return /\b(\d{6})\b/.exec(mail.subject)![1]!;
}

async function requestCode(v: Visitor, p: string, email: string) {
  await v.getPage(p);
  return v.post(`${p}/email`, { email });
}

function sharedLink(opts: { maxOpens?: number } = {}) {
  const c = app.mkCase('Board pack');
  app.mkNote(c.id, 'Agenda', 'Item 1');
  const link = app.mkLink(c.id, {
    label: 'Board',
    recipients: [{ email: ANNA, lang: 'de' }, { email: PIOTR, lang: 'pl' }, { email: MARY, lang: 'en' }],
    maxOpens: opts.maxOpens ?? null,
  });
  return { c, link, p: pathOf(link.url) };
}

describe('one link for several people', () => {
  it('lets each person on the list unlock the same URL with their own address and code', async () => {
    const { link, p } = sharedLink();
    const anna = new Visitor(app.base);
    const piotr = new Visitor(app.base);

    await requestCode(anna, p, ANNA);
    await requestCode(piotr, p, PIOTR);
    // Each code goes to its own mailbox, in that person's language.
    expect(mailsTo(app, ANNA)[0]!.subject).toMatch(/^Zugangscode: \d{6}$/);
    expect(mailsTo(app, PIOTR)[0]!.subject).toMatch(/^Kod dostępu: \d{6}$/);

    // Piotr asking for a code did not burn Anna's: both still work.
    expect((await anna.post(`${p}/code`, { code: codeFor(ANNA) })).res.status).toBe(303);
    expect((await piotr.post(`${p}/code`, { code: codeFor(PIOTR) })).res.status).toBe(303);

    const annaPage = await anna.getPage(p);
    expect(annaPage.body).toContain('Board pack');
    expect(annaPage.body).toContain(`Angemeldet als ${ANNA}`);
    expect(annaPage.body).toContain('<html lang="de"');
    const piotrPage = await piotr.getPage(p);
    expect(piotrPage.body).toContain(`Zalogowano jako ${PIOTR}`);

    const people = Object.fromEntries(listRecipients(app.ctx.db, link.id).map((r) => [r.email, r.opens]));
    expect(people).toEqual({ [ANNA]: 1, [PIOTR]: 1, [MARY]: 0 });
    expect(getLink(app.ctx.db, link.id)!.opens_used).toBe(2);

    const granted = listAudit(app.ctx.db).filter((r) => r.action === 'access.granted' && r.link_id === link.id);
    expect(granted.map((r) => JSON.parse(r.details!).email).sort()).toEqual([ANNA, PIOTR]);
  });

  it('still answers an address that is not on the list exactly like one that is, and mails nobody', async () => {
    const { p } = sharedLink();
    const before = app.mailer.recent().length;
    const v = new Visitor(app.base);
    const wrong = await requestCode(v, p, 'stranger@example.com');
    const right = await requestCode(new Visitor(app.base), p, MARY);
    expect(wrong.res.status).toBe(right.res.status);
    // Same page, same language — the language must not reveal a match either.
    expect(wrong.body.replace(/name="_flow" value="[^"]+"/g, '')).toBe(right.body.replace(/name="_flow" value="[^"]+"/g, ''));
    expect(app.mailer.recent().length).toBe(before + 1);
  });

  it('speaks the browser language until someone signs in when the people on a link differ', async () => {
    const { p } = sharedLink();
    const pl = await fetch(`${app.base}${p}`, { headers: { 'accept-language': 'pl' } });
    expect(await pl.text()).toContain('<html lang="pl"');
    const en = await fetch(`${app.base}${p}`);
    expect(await en.text()).toContain('<html lang="en"');

    const c = app.mkCase('All German');
    const german = app.mkLink(c.id, { recipients: [{ email: ANNA, lang: 'de' }, { email: 'b@example.com', lang: 'de' }] });
    const res = await fetch(`${app.base}${pathOf(german.url)}`, { headers: { 'accept-language': 'pl' } });
    expect(await res.text()).toContain('<html lang="de"');
  });

  it('counts the opening limit for the link as a whole', async () => {
    const { p } = sharedLink({ maxOpens: 1 });
    const anna = new Visitor(app.base);
    await requestCode(anna, p, ANNA);
    expect((await anna.post(`${p}/code`, { code: codeFor(ANNA) })).res.status).toBe(303);

    const mary = new Visitor(app.base);
    const blocked = await mary.getPage(p);
    expect(blocked.res.status).toBe(403);
    // Anna, already inside, can still finish.
    expect((await anna.getPage(p)).body).toContain('Board pack');
  });

  it('limits code requests per person, so one busy recipient cannot lock out the others', async () => {
    const limited = await boot({ CHALLENGE_LIMIT_PER_LINK_PER_HOUR: '2' });
    try {
      const c = limited.mkCase();
      const link = limited.mkLink(c.id, { recipients: [{ email: ANNA, lang: 'en' }, { email: PIOTR, lang: 'en' }] });
      const p = pathOf(link.url);
      for (let i = 0; i < 2; i++) {
        const v = new Visitor(limited.base);
        await v.getPage(p);
        expect((await v.post(`${p}/email`, { email: ANNA })).res.status).toBe(200);
      }
      const v = new Visitor(limited.base);
      await v.getPage(p);
      expect((await v.post(`${p}/email`, { email: ANNA })).res.status).toBe(429);
      const other = new Visitor(limited.base);
      await other.getPage(p);
      expect((await other.post(`${p}/email`, { email: PIOTR })).res.status).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

describe('managing the people on a link', () => {
  async function linkFromPanel(fields: Record<string, string>) {
    const c = app.mkCase('Panel link');
    const res = await adminPost(app, session, `/admin/cases/${c.id}/links`, { label: 'Auditors', ...fields });
    const body = await res.text();
    const url = /value="([^"]+\/d\/[^"]+)"/.exec(body)?.[1];
    return { c, res, body, url, link: listLinksForCase(app.ctx.db, c.id)[0] };
  }

  it('creates one link from a pasted list, with a language per address', async () => {
    const { res, url, link } = await linkFromPanel({
      recipients: `"Schmidt, Anna" <${ANNA.toUpperCase()}> de; Piotr Nowak <${PIOTR}>\n${MARY} en\n${ANNA}`,
      lang: 'pl',
    });
    expect(res.status).toBe(200);
    expect(url).toBeDefined();
    expect(listRecipients(app.ctx.db, link!.id).map((r) => `${r.email} ${r.lang}`)).toEqual([`${ANNA} de`, `${PIOTR} pl`, `${MARY} en`]);
    const created = listAudit(app.ctx.db).find((r) => r.action === 'link.create' && r.link_id === link!.id)!;
    expect(JSON.parse(created.details!).recipients).toHaveLength(3);
  });

  it('refuses a list with an unreadable entry instead of silently dropping it', async () => {
    const { res, body, link } = await linkFromPanel({ recipients: `${ANNA}\n${PIOTR} xx\nnobody` });
    expect(res.status).toBe(400);
    expect(body).toContain(`${PIOTR} xx`);
    expect(body).toContain('nobody');
    expect(link).toBeUndefined();
  });

  it('adds people without changing the URL, and removes them along with their session', async () => {
    const { url, link } = await linkFromPanel({ recipients: ANNA });
    const hash = getLink(app.ctx.db, link!.id)!.token_hash;

    const added = await adminPost(app, session, `/admin/links/${link!.id}/recipients`, { recipients: `${PIOTR}\n${ANNA}`, lang: 'pl' });
    expect(added.status).toBe(200);
    expect(await added.text()).toContain('Recipients added to “Auditors”: 1');
    expect(getLink(app.ctx.db, link!.id)!.token_hash).toBe(hash);

    // The newcomer gets in through the URL that was already handed out.
    const p = pathOf(url!);
    const piotr = new Visitor(app.base);
    await requestCode(piotr, p, PIOTR);
    await piotr.post(`${p}/code`, { code: codeFor(PIOTR) });
    expect((await piotr.getPage(p)).body).toContain('Panel link');

    const piotrRow = listRecipients(app.ctx.db, link!.id).find((r) => r.email === PIOTR)!;
    const removed = await adminPost(app, session, `/admin/links/${link!.id}/recipients/${piotrRow.id}/remove`);
    expect(removed.status).toBe(200);
    expect(listRecipients(app.ctx.db, link!.id).map((r) => r.email)).toEqual([ANNA]);
    // Thrown out at once, and the address no longer earns a code.
    const after = await piotr.getPage(p);
    expect(after.body).not.toContain('Panel link');
    const before = app.mailer.recent().length;
    await requestCode(new Visitor(app.base), p, PIOTR);
    expect(app.mailer.recent().length).toBe(before);

    const last = listRecipients(app.ctx.db, link!.id)[0]!;
    const refused = await adminPost(app, session, `/admin/links/${link!.id}/recipients/${last.id}/remove`);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('revoke it');

    await adminPost(app, session, `/admin/links/${link!.id}/revoke`);
    const frozen = await adminPost(app, session, `/admin/links/${link!.id}/recipients`, { recipients: MARY });
    expect(frozen.status).toBe(400);
    expect(listRecipients(app.ctx.db, link!.id)).toHaveLength(1);
  });

  it('shows everyone on the link in the panel, each with a language and a count', async () => {
    const { c } = await linkFromPanel({ recipients: `${ANNA} de\n${PIOTR} pl` });
    const page = await (await fetch(`${app.base}/admin/cases/${c.id}`, { headers: { cookie: session.cookie } })).text();
    expect(page).toContain(ANNA);
    expect(page).toContain(PIOTR);
    expect(page).toContain('>DE<');
    expect(page).toContain('opened: 0');
  });
});

describe('address groups', () => {
  it('can be created, renamed, refilled and deleted from the panel', async () => {
    const page = await (await fetch(`${app.base}/admin/groups`, { headers: { cookie: session.cookie } })).text();
    expect(page).toContain('Address groups');
    expect(page).toContain('href="/admin/groups"');

    const created = await adminPost(app, session, '/admin/groups', { name: 'Auditors', recipients: `${ANNA} de\n${PIOTR}`, lang: 'pl' });
    expect(created.status).toBe(200);
    const group = listGroups(app.ctx.db).find((g) => g.name === 'Auditors')!;
    expect(group.members).toEqual([{ email: ANNA, lang: 'de' }, { email: PIOTR, lang: 'pl' }]);

    const dup = await adminPost(app, session, '/admin/groups', { name: 'auditors', recipients: MARY });
    expect(dup.status).toBe(400);
    const dupBody = await dup.text();
    expect(dupBody).toContain('already exists');
    expect(dupBody).toContain(MARY); // what was typed survives the error

    const bad = await adminPost(app, session, `/admin/groups/${group.id}`, { name: 'Auditors', recipients: 'broken' });
    expect(bad.status).toBe(400);

    await adminPost(app, session, `/admin/groups/${group.id}`, { name: 'External auditors', recipients: MARY, lang: 'en' });
    expect(listGroups(app.ctx.db).find((g) => g.id === group.id)).toMatchObject({ name: 'External auditors', members: [{ email: MARY, lang: 'en' }] });

    await adminPost(app, session, `/admin/groups/${group.id}/delete`);
    expect(listGroups(app.ctx.db).find((g) => g.id === group.id)).toBeUndefined();
    expect((await adminPost(app, session, `/admin/groups/${group.id}/delete`)).status).toBe(404);
    const actions = listAudit(app.ctx.db).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['group.create', 'group.update', 'group.delete']));
  });

  it('fills a link with a copy of its members, which later edits of the group do not touch', async () => {
    await adminPost(app, session, '/admin/groups', { name: 'Board', recipients: `${ANNA} de\n${PIOTR} pl` });
    const group = listGroups(app.ctx.db).find((g) => g.name === 'Board')!;
    const c = app.mkCase('Group link');

    const form = await (await fetch(`${app.base}/admin/cases/${c.id}`, { headers: { cookie: session.cookie } })).text();
    expect(form).toContain(`<option value="${group.id}">Board (2)</option>`);
    expect(form).toContain('id="outletbox-groups"');

    // Without JavaScript the group arrives as a field and is merged with what was typed.
    await adminPost(app, session, `/admin/cases/${c.id}/links`, { label: 'Board', recipients: MARY, group: group.id, lang: 'en' });
    const link = listLinksForCase(app.ctx.db, c.id)[0]!;
    expect(listRecipients(app.ctx.db, link.id).map((r) => r.email).sort()).toEqual([ANNA, MARY, PIOTR].sort());

    await adminPost(app, session, `/admin/groups/${group.id}`, { name: 'Board', recipients: 'someone.new@example.com' });
    expect(listRecipients(app.ctx.db, link.id).map((r) => r.email)).not.toContain('someone.new@example.com');
    await adminPost(app, session, `/admin/groups/${group.id}/delete`);
    expect(listRecipients(app.ctx.db, link.id)).toHaveLength(3);
  });
});

describe('reading an address list', () => {
  it('takes lines, commas, semicolons, display names and language codes', () => {
    const { recipients, invalid } = parseRecipients(
      `a@x.test\nB@X.TEST de, "Doe, Jane" <jane@x.test>; John <john@x.test> fr\r\n\n a@x.test pl`, 'en',
    );
    expect(invalid).toEqual([]);
    expect(recipients).toEqual([
      { email: 'a@x.test', lang: 'en' }, { email: 'b@x.test', lang: 'de' },
      { email: 'jane@x.test', lang: 'en' }, { email: 'john@x.test', lang: 'fr' },
    ]);
    expect(parseRecipients(formatRecipients(recipients), 'pl').recipients).toEqual(recipients);
  });

  it('reports what it cannot read rather than guessing', () => {
    expect(parseRecipients('no-at-sign\na@x.test klingon\na@x.test de extra\n<not an address>', 'en').invalid)
      .toEqual(['no-at-sign', 'a@x.test klingon', 'a@x.test de extra', '<not an address>']);
    expect(() => requireRecipients('', 'en')).toThrow(RecipientListError);
    const many = Array.from({ length: 101 }, (_, i) => `p${i}@x.test`).join('\n');
    expect(() => requireRecipients(many, 'en')).toThrow(/too_many/);
  });
});

describe('upgrading a database from before shared links', () => {
  it('turns every existing link into a link with its one recipient, keeping codes and sessions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outletbox-mig-'));
    const db = openDatabase(path.join(dir, 'old.sqlite'));
    try {
      db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const f of ['001_init.sql', '002_drop_link_sent_at.sql', '003_link_language.sql']) {
        db.exec(fs.readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
        db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(f, 'x');
      }
      db.exec(`INSERT INTO cases (id, name, created_at, updated_at) VALUES ('c_1', 'Old', 't', 't');
        INSERT INTO links (id, case_id, label, recipient_email, token_hash, token_hint, opens_used, created_at, last_used_at, lang)
          VALUES ('l_1', 'c_1', 'Jan', 'jan@x.test', 'h', 'hint', 2, '2026-01-01', '2026-01-02', 'pl');
        INSERT INTO challenges (id, link_id, code_hash, flow_hash, created_at, expires_at) VALUES ('ch_1', 'l_1', 'c', 'f', 't', 't');
        INSERT INTO access_sessions (id_hash, link_id, csrf_token, created_at, expires_at) VALUES ('s', 'l_1', 'x', 't', 't');`);

      expect(migrate(db)).toEqual(['004_shared_links.sql']);
      const [r] = listRecipients(db, 'l_1');
      expect(r).toMatchObject({ email: 'jan@x.test', lang: 'pl', opens: 2, last_opened_at: '2026-01-02' });
      expect(r!.id).toMatch(/^r_[0-9a-f]{16}$/);
      expect(db.prepare('SELECT recipient_id FROM challenges').get()).toEqual({ recipient_id: r!.id });
      expect(db.prepare('SELECT recipient_id FROM access_sessions').get()).toEqual({ recipient_id: r!.id });
      expect(Object.keys(db.prepare('SELECT * FROM links').get() as object)).not.toContain('recipient_email');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
