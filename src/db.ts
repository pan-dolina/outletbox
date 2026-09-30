import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

export type Db = DatabaseSync;

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Where pre-migration copies go: a `backups` directory next to the database, never inside it. */
export function migrationBackupDir(dbPath: string): string | null {
  return dbPath === ':memory:' ? null : path.join(path.dirname(dbPath), 'backups');
}

export function openDatabase(dbPath: string): Db {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

/** Pre-migration copies kept per database; older ones are removed after a successful copy. */
export const KEEP_MIGRATION_BACKUPS = 5;

/**
 * Applies pending migrations, each in its own transaction. When `backupDir` is
 * given and an existing database is about to change, a consistent copy is taken
 * first (see backupBeforeMigrating), so an upgrade never needs a manual backup
 * step. A fresh database has nothing worth copying.
 */
export function migrate(db: Db, opts: { backupDir?: string | null } = {}): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => (r as { name: string }).name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const pending = files.filter((f) => !applied.has(f));
  if (pending.length && applied.size && opts.backupDir) backupBeforeMigrating(db, opts.backupDir, pending[0]!);
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    transaction(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, now());
    });
    ran.push(file);
    log.info('migration applied', { migration: file });
  }
  return ran;
}

/**
 * Copies the database before a migration changes it. `VACUUM INTO` produces a
 * consistent, self-contained file even in WAL mode — copying the .sqlite file
 * alone can miss everything still sitting in the -wal file. The copy is checked
 * with `PRAGMA integrity_check`; if it cannot be made or does not check out, the
 * migration does not run and the error stops the start-up: an upgrade without a
 * way back is worse than an upgrade that waits for free disk space.
 */
export function backupBeforeMigrating(db: Db, backupDir: string, firstPending: string): string {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const target = path.join(backupDir, `before-${firstPending.replace(/\.sql$/, '')}-${stamp}.sqlite`);
  db.prepare('VACUUM INTO ?').run(target);
  fs.chmodSync(target, 0o600);
  const copy = new DatabaseSync(target, { readOnly: true });
  try {
    const rows = copy.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (rows.length !== 1 || rows[0]!.integrity_check !== 'ok') {
      throw new Error(`backup ${target} failed its integrity check: ${rows.map((r) => r.integrity_check).join('; ')}`);
    }
  } finally {
    copy.close();
  }
  log.info('database copied before migrating', { backup: target, migration: firstPending });
  const old = fs.readdirSync(backupDir).filter((f) => /^before-.*\.sqlite$/.test(f)).sort((a, b) => stampOf(b).localeCompare(stampOf(a)));
  for (const f of old.slice(KEEP_MIGRATION_BACKUPS)) fs.rmSync(path.join(backupDir, f), { force: true });
  return target;
}

/** The timestamp at the end of a backup's name, which is what orders them. */
function stampOf(file: string): string {
  return /-(\d{8}T\d{6}Z)\.sqlite$/.exec(file)?.[1] ?? '';
}

/**
 * Runs `fn` inside BEGIN IMMEDIATE ... COMMIT. node:sqlite is synchronous, so a
 * transaction cannot interleave with another request: this is what makes quota
 * reservations atomic under concurrent uploads.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

export function now(): string {
  return new Date().toISOString();
}
