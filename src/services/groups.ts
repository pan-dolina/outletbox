import type { Db } from '../db.js';
import type { Viewer } from './users.js';
import { now, transaction } from '../db.js';
import { newId } from '../crypto.js';
import { MAX_RECIPIENTS, RecipientListError, type RecipientInput } from './addresses.js';

/**
 * Address groups: named lists of people who usually receive deliveries
 * together ("Board", "External auditors"). A group is only a shortcut for
 * typing addresses — adding it to a link copies the addresses there, so a later
 * change to the group never widens or narrows access to an existing link.
 */
export interface Group {
  id: string; name: string; created_at: string; updated_at: string; members: RecipientInput[];
  /** The account that created it; null for groups kept by the administrators. */
  created_by: string | null;
  created_by_name: string | null;
}

interface GroupRow { id: string; name: string; created_at: string; updated_at: string; created_by: string | null; created_by_name: string | null }

const SELECT_GROUP = `SELECT g.*, a.username AS created_by_name FROM recipient_groups g LEFT JOIN admins a ON a.id = g.created_by`;

/**
 * Everyone may pick any group for a link; changing or deleting one is for the
 * account that created it and for administrators.
 */
export function canEditGroup(viewer: Viewer, group: Group): boolean {
  return viewer.role === 'admin' || group.created_by === viewer.id;
}

function validName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > 200) throw new RecipientListError('groups.name_required');
  return name;
}

function validMembers(members: RecipientInput[]): RecipientInput[] {
  if (members.length === 0) throw new RecipientListError('recipients.none');
  if (members.length > MAX_RECIPIENTS) throw new RecipientListError('recipients.too_many', { max: MAX_RECIPIENTS });
  return members;
}

function nameTaken(db: Db, name: string, exceptId: string | null): boolean {
  const row = db.prepare('SELECT id FROM recipient_groups WHERE name = ? COLLATE NOCASE').get(name) as { id: string } | undefined;
  return row !== undefined && row.id !== exceptId;
}

function writeMembers(db: Db, groupId: string, members: RecipientInput[]): void {
  db.prepare('DELETE FROM recipient_group_members WHERE group_id = ?').run(groupId);
  const insert = db.prepare('INSERT INTO recipient_group_members (group_id, email, lang, position) VALUES (?, ?, ?, ?)');
  members.forEach((m, i) => insert.run(groupId, m.email, m.lang, i));
}

function membersOf(db: Db, groupId: string): RecipientInput[] {
  return db.prepare('SELECT email, lang FROM recipient_group_members WHERE group_id = ? ORDER BY position')
    .all(groupId) as unknown as RecipientInput[];
}

export function createGroup(db: Db, input: { name: string; members: RecipientInput[]; createdBy?: string | null }): Group {
  const name = validName(input.name);
  const members = validMembers(input.members);
  if (nameTaken(db, name, null)) throw new RecipientListError('groups.name_taken');
  const ts = now();
  const id = newId('g');
  transaction(db, () => {
    db.prepare('INSERT INTO recipient_groups (id, name, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?)').run(id, name, ts, ts, input.createdBy ?? null);
    writeMembers(db, id, members);
  });
  return getGroup(db, id)!;
}

export function updateGroup(db: Db, id: string, input: { name: string; members: RecipientInput[] }): Group | null {
  if (!getGroup(db, id)) return null;
  const name = validName(input.name);
  const members = validMembers(input.members);
  if (nameTaken(db, name, id)) throw new RecipientListError('groups.name_taken');
  transaction(db, () => {
    db.prepare('UPDATE recipient_groups SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), id);
    writeMembers(db, id, members);
  });
  return getGroup(db, id);
}

export function deleteGroup(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM recipient_groups WHERE id = ?').run(id).changes > 0;
}

export function getGroup(db: Db, id: string): Group | null {
  const row = db.prepare(`${SELECT_GROUP} WHERE g.id = ?`).get(id) as GroupRow | undefined;
  return row ? { ...row, members: membersOf(db, row.id) } : null;
}

export function listGroups(db: Db): Group[] {
  const rows = db.prepare(`${SELECT_GROUP} ORDER BY g.name COLLATE NOCASE`).all() as unknown as GroupRow[];
  return rows.map((row) => ({ ...row, members: membersOf(db, row.id) }));
}

/** Members of the chosen group, or nothing when no (or an unknown) group was chosen. */
export function groupMembers(db: Db, id: string | null | undefined): RecipientInput[] {
  if (!id) return [];
  return getGroup(db, id)?.members ?? [];
}
