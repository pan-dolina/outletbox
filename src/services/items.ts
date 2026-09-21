import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { now } from '../db.js';
import { newId } from '../crypto.js';

export type ItemKind = 'file' | 'note';
export type ItemStatus = 'uploading' | 'ready' | 'aborted' | 'expired' | 'missing' | 'deleted';

export interface ItemRow {
  id: string; case_id: string; kind: ItemKind; title: string; body: string | null;
  upload_kind: 'tus' | 'direct' | null; status: ItemStatus;
  declared_size: number | null; size: number | null; sha256: string | null;
  created_by: string | null; created_at: string; ready_at: string | null; deleted_at: string | null;
}

export class LimitError extends Error {
  constructor(public readonly code: 'file_too_large', message: string, public readonly limit: number) {
    super(message);
    this.name = 'LimitError';
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/**
 * Normalises an uploaded file name so it is safe to store, display and send back
 * in Content-Disposition. It is NEVER used to build a storage path.
 */
export function sanitizeFilename(raw: string | undefined | null): string {
  let name = (raw ?? '').normalize('NFC');
  // Drop any path component (both separators) and NUL / control characters.
  name = name.split(/[\\/]/).pop() ?? '';
  name = name.replace(CONTROL_CHARS, '');
  name = name.trim().replace(/^\.+$/, '');
  if (name.length > 255) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, 255 - ext.length) + ext;
  }
  return name || 'unnamed';
}

function insert(db: Db, item: ItemRow): ItemRow {
  db.prepare(
    `INSERT INTO items (id, case_id, kind, title, body, upload_kind, status, declared_size, size, sha256, created_by, created_at, ready_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(item.id, item.case_id, item.kind, item.title, item.body, item.upload_kind, item.status, item.declared_size,
    item.size, item.sha256, item.created_by, item.created_at, item.ready_at, item.deleted_at);
  return item;
}

export function createNote(db: Db, input: { caseId: string; title: string; body: string; adminId?: string | null }): ItemRow {
  const title = input.title.trim().slice(0, 200);
  const body = input.body.trim().slice(0, 20_000);
  if (!title || !body) throw new Error('A note needs a title and a body');
  const ts = now();
  return insert(db, {
    id: newId('n'), case_id: input.caseId, kind: 'note', title, body, upload_kind: null, status: 'ready',
    declared_size: null, size: null, sha256: null, created_by: input.adminId ?? null, created_at: ts, ready_at: ts, deleted_at: null,
  });
}

export interface StartUploadInput {
  caseId: string;
  originalName: string;
  uploadKind: 'tus' | 'direct';
  /** Size announced by the client, or null when unknown (chunked request). */
  declaredSize: number | null;
  adminId?: string | null;
  /** Optional pre-generated id (used when the id is chosen by the tus naming function). */
  id?: string;
}

/**
 * Registers a new file upload. Only the global per-file cap applies here — the
 * uploader is an authenticated administrator, not an anonymous third party, so
 * there are no per-link quotas or reservations to juggle.
 */
export function startUpload(db: Db, cfg: Config, input: StartUploadInput): { item: ItemRow; maxBytes: number } {
  if (input.declaredSize != null && (!Number.isSafeInteger(input.declaredSize) || input.declaredSize < 0)) {
    throw new Error('invalid declared size');
  }
  if (input.declaredSize != null && input.declaredSize > cfg.maxFileBytes) {
    throw new LimitError('file_too_large', `File exceeds the maximum size of ${cfg.maxFileBytes} bytes`, cfg.maxFileBytes);
  }
  const item = insert(db, {
    id: input.id ?? newId('f'), case_id: input.caseId, kind: 'file', title: sanitizeFilename(input.originalName), body: null,
    upload_kind: input.uploadKind, status: 'uploading', declared_size: input.declaredSize, size: null, sha256: null,
    created_by: input.adminId ?? null, created_at: now(), ready_at: null, deleted_at: null,
  });
  return { item, maxBytes: input.declaredSize ?? cfg.maxFileBytes };
}

/** Idempotent: only an 'uploading' row transitions to 'ready'. Returns false if it already did. */
export function completeUpload(db: Db, itemId: string, size: number, sha256?: string | null): boolean {
  const res = db.prepare(
    `UPDATE items SET status = 'ready', size = ?, sha256 = COALESCE(?, sha256), ready_at = ?
     WHERE id = ? AND status = 'uploading'`,
  ).run(size, sha256 ?? null, now(), itemId);
  return res.changes > 0;
}

export function failUpload(db: Db, itemId: string, status: 'aborted' | 'expired'): boolean {
  const res = db.prepare(`UPDATE items SET status = ? WHERE id = ? AND status = 'uploading'`).run(status, itemId);
  return res.changes > 0;
}

export function markMissing(db: Db, itemId: string): void {
  db.prepare(`UPDATE items SET status = 'missing' WHERE id = ? AND status = 'ready' AND kind = 'file'`).run(itemId);
}

export function markDeleted(db: Db, itemId: string): boolean {
  const res = db.prepare(`UPDATE items SET status = 'deleted', deleted_at = ? WHERE id = ? AND status IN ('ready', 'missing')`).run(now(), itemId);
  return res.changes > 0;
}

export function getItem(db: Db, id: string): ItemRow | null {
  return (db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined) ?? null;
}

/** Everything an administrator sees for a case, including failed uploads. */
export function listItemsForCase(db: Db, caseId: string): ItemRow[] {
  return db.prepare(
    `SELECT * FROM items WHERE case_id = ? AND status NOT IN ('aborted', 'expired') ORDER BY created_at DESC`,
  ).all(caseId) as unknown as ItemRow[];
}

/** What a recipient sees: only finished content, no storage or uploader details. */
export interface RecipientItem { id: string; kind: ItemKind; title: string; body: string | null; size: number | null; ready_at: string | null }

export function listItemsForRecipient(db: Db, caseId: string): RecipientItem[] {
  return db.prepare(
    `SELECT id, kind, title, body, size, ready_at FROM items
     WHERE case_id = ? AND status = 'ready' ORDER BY kind = 'note' DESC, created_at ASC`,
  ).all(caseId) as unknown as RecipientItem[];
}

export function listStaleUploads(db: Db, olderThanMs: number): ItemRow[] {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  return db.prepare(`SELECT * FROM items WHERE status = 'uploading' AND created_at < ?`).all(cutoff) as unknown as ItemRow[];
}

export function listReadyFiles(db: Db): ItemRow[] {
  return db.prepare(`SELECT * FROM items WHERE status = 'ready' AND kind = 'file'`).all() as unknown as ItemRow[];
}

export function liveStorageKeys(db: Db): Set<string> {
  const rows = db.prepare(`SELECT id FROM items WHERE kind = 'file' AND status IN ('uploading', 'ready')`).all() as unknown as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}
