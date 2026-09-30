import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { newSessionId, newToken, sha256Hex } from '../src/crypto.js';
import { backupBeforeMigrating, KEEP_MIGRATION_BACKUPS, migrate, migrationBackupDir, openDatabase } from '../src/db.js';
import { boot, mailsTo, Visitor, type TestApp } from './helpers.js';

/**
 * An instance upgraded in place must come up on its own: no manual backup, no
 * lost links, and nobody thrown out of a delivery they were in the middle of.
 */

const OLD_MIGRATIONS = ['001_init.sql', '002_drop_link_sent_at.sql', '003_link_language.sql'];
const dirs: string[] = [];
const apps: TestApp[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A DATA_DIR as v0.3.x left it: schema up to 003, one case, one link, one open recipient session. */
function oldInstance() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outletbox-upgrade-'));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, 'outletbox.sqlite'));
  db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const f of OLD_MIGRATIONS) {
    db.exec(fs.readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(f, '2026-09-01T00:00:00.000Z');
  }
  const token = newToken();
  const sessionId = newSessionId();
  const later = new Date(Date.now() + 3600_000).toISOString();
  db.prepare(`INSERT INTO cases (id, name, created_at, updated_at) VALUES ('c_oldcase00000000', 'Kept across the upgrade', 't', 't')`).run();
  db.prepare(`INSERT INTO links (id, case_id, label, recipient_email, token_hash, token_hint, created_at, lang)
              VALUES ('l_oldlink00000000', 'c_oldcase00000000', 'Jan', 'jan@example.com', ?, ?, 't', 'pl')`).run(sha256Hex(token), token.slice(0, 6));
  db.prepare(`INSERT INTO access_sessions (id_hash, link_id, csrf_token, created_at, expires_at) VALUES (?, 'l_oldlink00000000', 'x', 't', ?)`)
    .run(sha256Hex(sessionId), later);
  db.close();
  return { dir, token, sessionId };
}

describe('upgrading an instance in place', () => {
  it('copies the database first, then migrates, and keeps links and open sessions working', async () => {
    const old = oldInstance();
    const app = await boot({ DATA_DIR: old.dir });
    apps.push(app);

    // A consistent copy of the database as it was, taken before anything changed.
    const backups = fs.readdirSync(path.join(old.dir, 'backups'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^before-004_shared_links-\d{8}T\d{6}Z\.sqlite$/);
    const file = path.join(old.dir, 'backups', backups[0]!);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const copy = new DatabaseSync(file, { readOnly: true });
    expect((copy.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(3);
    expect(copy.prepare('SELECT recipient_email FROM links').get()).toEqual({ recipient_email: 'jan@example.com' });
    copy.close();

    // The recipient who was inside before the upgrade is still inside.
    const inside = await fetch(`${app.base}/d/${old.token}`, { headers: { cookie: `outletbox_access=${old.sessionId}` } });
    const page = await inside.text();
    expect(page).toContain('Kept across the upgrade');
    expect(page).toContain('Zalogowano jako jan@example.com');

    // The old link still works for a new visit, in the language it was issued in.
    const v = new Visitor(app.base);
    await v.getPage(`/d/${old.token}`);
    await v.post(`/d/${old.token}/email`, { email: 'jan@example.com' });
    expect(mailsTo(app, 'jan@example.com')[0]!.subject).toMatch(/^Kod dostępu: \d{6}$/);
  });

  it('takes no copy when nothing is pending, nor for a brand-new database', async () => {
    const old = oldInstance();
    const dbPath = path.join(old.dir, 'outletbox.sqlite');
    const db = openDatabase(dbPath);
    try {
      expect(migrate(db, { backupDir: migrationBackupDir(dbPath) })).toEqual(['004_shared_links.sql']);
      // The next start finds nothing pending, and copies nothing.
      expect(migrate(db, { backupDir: migrationBackupDir(dbPath) })).toEqual([]);
    } finally {
      db.close();
    }
    expect(fs.readdirSync(path.join(old.dir, 'backups'))).toHaveLength(1);

    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outletbox-fresh-'));
    dirs.push(freshDir);
    const fresh = openDatabase(path.join(freshDir, 'outletbox.sqlite'));
    try {
      expect(migrate(fresh, { backupDir: path.join(freshDir, 'backups') })).toContain('004_shared_links.sql');
    } finally {
      fresh.close();
    }
    expect(fs.existsSync(path.join(freshDir, 'backups'))).toBe(false);
  });

  it('keeps only the newest copies', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outletbox-backups-'));
    dirs.push(dir);
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir);
    for (let i = 1; i <= KEEP_MIGRATION_BACKUPS + 2; i++) fs.writeFileSync(path.join(backupDir, `before-00${i}_x-2020010${i}T000000Z.sqlite`), '');
    fs.writeFileSync(path.join(backupDir, 'operator-notes.txt'), 'not ours');
    const db = openDatabase(path.join(dir, 'db.sqlite'));
    try {
      const made = backupBeforeMigrating(db, backupDir, '009_next.sql');
      const left = fs.readdirSync(backupDir).sort();
      expect(left).toContain(path.basename(made));
      expect(left).toContain('operator-notes.txt');
      expect(left.filter((f) => f.startsWith('before-'))).toHaveLength(KEEP_MIGRATION_BACKUPS);
      expect(left).not.toContain('before-001_x-20200101T000000Z.sqlite');
      expect(left).not.toContain('before-002_x-20200102T000000Z.sqlite');
    } finally {
      db.close();
    }
  });
});
